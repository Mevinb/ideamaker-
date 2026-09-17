import { appendEvent, getEvents, getRun, listRuns, updateRun } from "./db";
import { sampleDistinctChatModels } from "./model-assignments";
import { availableModels, omniChat } from "./omniroute";
import type { ChatMessage, Run, RunEvent } from "./types";

const MAX_CONTEXT = 50_000;
// Total model-call budget per round. Sized for the busiest path: 4 pitches +
// 8 debate turns + 4 votes, plus one deadlock cycle of 4 fresh pitches +
// 4 debate turns + 4 votes.
const MAX_REQUESTS = 30;
const MAX_AUTONOMOUS_ROUNDS = 2;
const RECENT_RUNS_FOR_NOVELTY = 20;
// Alternates tried per speaker before that speaker sits out (the round continues).
const MAX_SPEAKER_ATTEMPTS = 6;

// Stable seats so each voice keeps its model. These are just names — nobody has
// a role, nobody leads, and anyone can pitch, argue, or change their mind.
export const PARTICIPANT_NAMES = ["Sam", "Alex", "Robin", "Kai"];
const SEATS = [0, 1, 2, 3];

const IDEA_QUALITY =
  "Good ideas are concrete: name what the user does, what they see happen, and how it works in one input -> change -> payoff loop. " +
  "Avoid generic chatbots, mood journals, habit trackers, dashboards, marketplaces, or playlist generators unless the interaction itself is genuinely new. " +
  "Prefer numbers, visible consequences, and a real demo moment over adjectives like seamless, immersive, or delightful.";

const DISCUSS_INSTRUCTION =
  "Jump into the discussion freely. Back the idea you think is strongest and say exactly why, disagree openly with weak points, or combine the best bits of several ideas. You may change your mind. Quote something specific someone said.";

function presetDirection(preset: Run["preset"]): string {
  return {
    general: "Match the user's actual goal and constraints. Do not assume this is a hackathon.",
    hackathon: "Favor a memorable live demo and a realistically buildable scope for the stated time and team.",
    startup: "Favor a narrow customer problem, a defensible differentiator, and a credible first product.",
    creative: "Favor an expressive interaction and a distinctive emotional or artistic payoff.",
    personal: "Favor learning value, a satisfying experience, and an achievable scope.",
  }[preset];
}

function speakerName(message: ChatMessage): string {
  if (message.role === "user") return "User";
  if (message.agent) return message.agent;
  if (message.participant !== undefined) return PARTICIPANT_NAMES[message.participant] || `Participant ${message.participant + 1}`;
  return "Participant";
}

function shuffled(seats: number[]): number[] {
  const order = [...seats];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function active(runId: string): void {
  const run = getRun(runId);
  if (!run || run.status === "cancelled") throw new Error("Group chat stopped");
  if (run.status === "failed") throw new Error("Group chat has stopped");
}

function isStop(error: unknown, runId: string): boolean {
  return getRun(runId)?.status === "cancelled" || (error instanceof Error && error.message === "Group chat stopped");
}

function messageEvent(runId: string, message: ChatMessage): void {
  appendEvent(runId, "message", JSON.stringify(message), `Round ${message.round}`);
}

function parseMessage(event: RunEvent): ChatMessage | undefined {
  if (event.kind !== "message") return undefined;
  try {
    const value = JSON.parse(event.message) as ChatMessage;
    return typeof value.content === "string" && (value.role === "user" || value.role === "assistant" || value.role === "system") ? value : undefined;
  } catch { return undefined; }
}

function transcript(run: Run): string {
  const messages = getEvents(run.id).map(parseMessage).filter((item): item is ChatMessage => Boolean(item));
  let output = "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const line = `${speakerName(message)}: ${message.content}\n`;
    if (output.length + line.length > MAX_CONTEXT) break;
    output = line + output;
  }
  return output;
}

const TERRITORY_STOPWORDS = new Set(
  "a,an,the,and,or,of,to,in,on,with,for,from,that,this,these,those,it,its,is,are,was,were,be,been,by,as,at,into,through,via,using,use,used,user,users,app,apps,experience,new,novel,idea,ideas,concept,concepts,system,platform,project,projects,build,builds,built,make,makes,help,helps,like,just,more,most,than,then,their,they,them,when,where,which,while,who,will,your,you,we,our,can,should,could,would,one,two,also,well,even,every,without,within,across,another,other,codex,gpt,ai,pitch,demo,hackathon,team,hours,hour,time".split(",")
);

/**
 * Novelty boundary mined from prior chats. Deliberately abstract: pasting full
 * prior pitches into the prompt anchors the model to the same space even under
 * negation ("avoid these" reads as examples to imitate). Repeated two-word
 * territories ("pull request", "code review") name the rut without feeding it.
 */
export function exhaustedTerritories(runId: string): string {
  const texts: string[] = [];
  for (const previous of listRuns()) {
    if (previous.id === runId || previous.mode !== "chat") continue;
    const openings = getEvents(previous.id).map(parseMessage)
      .filter((message): message is ChatMessage => Boolean(message && message.role === "assistant" && message.round === 1))
      .slice(0, 3);
    for (const opening of openings) texts.push(opening.content.toLowerCase());
    if (texts.length >= RECENT_RUNS_FOR_NOVELTY * 3) break;
  }
  const docFreq = new Map<string, number>();
  for (const text of texts) {
    const tokens = text.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(token => token.length > 2 && !TERRITORY_STOPWORDS.has(token));
    const seen = new Set<string>();
    for (let i = 0; i + 1 < tokens.length; i++) seen.add(`${tokens[i]} ${tokens[i + 1]}`);
    for (const bigram of seen) docFreq.set(bigram, (docFreq.get(bigram) ?? 0) + 1);
  }
  const top = [...docFreq.entries()]
    .filter(([, count]) => texts.length >= 3 && count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([bigram, count]) => `- "${bigram}" (in ${count} prior runs)`);
  if (!top.length) return "No prior opening ideas are saved yet — start fresh.";
  return `These territories are exhausted in prior runs. Do not pitch there, and do not just rename them:\n${top.join("\n")}\nVary the WHO and WHERE: if prior runs served developers at a desk, serve someone else somewhere else. No developer-tool or repo-centered idea unless the brief explicitly asks for one.`;
}

const FAILED_MODELS = new Set<string>();

// The gateway does not report remaining free-tier tokens, so an exhausted daily
// allowance surfaces as a call error. Matching models are parked for the session
// instead of being retried.
const QUOTA_ERROR = /insufficient[_ ]?quota|quota[_ ]?(exceeded|exhausted)|exceed.*quota|out of credit|billing|payment required|\b402\b|\b429\b/i;

export function recordFailedModel(model: string): void {
  FAILED_MODELS.add(model);
}

function cleanCut(text: string, maxLen = 580): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const slice = trimmed.slice(0, maxLen);
  const lastPunctuation = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("!\n"),
    slice.lastIndexOf("?\n"),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? ")
  );
  if (lastPunctuation > 200) {
    return slice.slice(0, lastPunctuation + 1).trim();
  }
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 250) {
    return slice.slice(0, lastNewline).trim();
  }
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 300) {
    return slice.slice(0, lastSpace).trim() + "...";
  }
  return slice;
}

async function getRoundModel(
  run: Run,
  participant: number,
  currentRoundUsedModels: Set<string>,
  allChatUsedModels: Set<string>
): Promise<string> {
  const manual = run.settings.models.generators[participant];
  if (manual && manual !== "auto" && !currentRoundUsedModels.has(manual) && !FAILED_MODELS.has(manual)) {
    return manual;
  }

  let catalog: string[] = [];
  try {
    catalog = (await availableModels()).map(m => m.id);
  } catch {
    catalog = [];
  }

  const rawPool = [...new Set([...catalog, ...run.settings.models.generators.filter(m => m !== "auto")])];
  const candidatePool = rawPool.filter(m => !FAILED_MODELS.has(m));
  const poolToUse = candidatePool.length ? candidatePool : rawPool;

  if (!poolToUse.length) {
    return manual || "auto";
  }

  const roundExcluded = new Set([...currentRoundUsedModels, ...FAILED_MODELS]);
  const fullExcluded = new Set([...currentRoundUsedModels, ...FAILED_MODELS]);
  for (const m of allChatUsedModels) {
    if (poolToUse.length - fullExcluded.size > 4) {
      fullExcluded.add(m);
    }
  }

  const fresh = sampleDistinctChatModels(poolToUse, 1, fullExcluded);
  if (fresh.length) return fresh[0];

  const fallback = sampleDistinctChatModels(poolToUse, 1, roundExcluded);
  if (fallback.length) return fallback[0];

  return manual || "auto";
}

async function reply(
  run: Run,
  participant: number,
  round: number,
  instruction: string,
  modelToUse: string,
  maxAttempts: number,
  exclude: Set<string>
): Promise<{ attempts: number; model: string }> {
  active(run.id);
  const requested = modelToUse || run.settings.models.generators[participant] || "auto";
  const name = PARTICIPANT_NAMES[participant];
  const system = `You are ${name}, one of four friends — ${PARTICIPANT_NAMES.join(", ")} — kicking around ideas in a group chat. Nobody has a role and nobody leads: pitch when you have something, back ideas you like, disagree openly, change your mind. Talk like a real person in plain prose with no bullet points, headings, or reports: 2-5 sentences, under 450 characters, one thought per message. Reply to people by name and quote concrete details they mentioned. Never summarize the chat or deliver a verdict. ${presetDirection(run.preset)} ${IDEA_QUALITY}`;
  const user = `User's brief: ${run.prompt}\n\nGroup chat so far:\n${transcript(run)}\n\nYour turn, ${name}: ${instruction}`;

  // Fallback must not depend on the live catalog alone: when the gateway is
  // struggling, the /models check is the first thing to fail, which is exactly
  // when alternates matter most. Recently working models are always eligible.
  const known = new Set<string>();
  for (const m of run.settings.models.generators) {
    if (m && m !== "auto") known.add(m);
  }
  for (const event of getEvents(run.id)) {
    const msg = parseMessage(event);
    if (msg?.model && msg.model !== "Not reported by gateway") known.add(msg.model);
  }
  let catalog: string[] = [];
  try {
    catalog = (await availableModels()).map(m => m.id);
  } catch {
    appendEvent(run.id, "warning", "The live model list was unreachable, so fallback uses recently working models.", `Round ${round}`);
  }
  const pool = [...new Set([requested, ...catalog, ...known])].filter(m => m && m !== "auto");
  const rest = sampleDistinctChatModels(
    pool.filter(m => m !== requested),
    Math.max(0, Math.min(MAX_SPEAKER_ATTEMPTS, maxAttempts) - 1),
    new Set([...exclude, ...FAILED_MODELS])
  );
  const candidates = [requested, ...rest].slice(0, Math.max(1, maxAttempts));

  let lastError: unknown;
  let attempts = 0;
  for (const model of candidates) {
    attempts++;
    exclude.add(model);
    try {
      const answer = await omniChat({ model, system, user, maxTokens: 400, signal: AbortSignal.timeout(60_000) });
      active(run.id);
      const content = cleanCut(answer.content, 580);
      if (!content) throw new Error("The model returned an empty reply");
      FAILED_MODELS.delete(model);
      messageEvent(run.id, { role: "assistant", agent: name, participant, model: answer.model, content, round });
      if (model !== requested) appendEvent(run.id, "warning", `${name} used fallback model ${answer.model} after ${requested} failed.`, `Round ${round}`);
      return { attempts, model: answer.model };
    } catch (error) {
      // Stopping must never burn more provider calls or ban a healthy model.
      if (isStop(error, run.id)) throw error;
      FAILED_MODELS.add(model);
      lastError = error;
      const detail = error instanceof Error ? error.message : "Unknown error";
      if (QUOTA_ERROR.test(detail)) {
        appendEvent(run.id, "warning", `${name}: ${model} hit a quota or rate limit and won't be retried this session (${detail.slice(0, 160)}).`, `Round ${round}`);
      }
      active(run.id);
    }
  }
  const exhausted = new Error(lastError instanceof Error ? lastError.message : "No participant model completed a reply");
  (exhausted as { attempts?: number }).attempts = attempts;
  throw exhausted;
}

export function addUserMessage(runId: string, content: string): { queued: boolean; run: Run } {
  const run = getRun(runId);
  if (!run) throw new Error("Conversation not found");
  if (run.mode !== "chat") throw new Error("This saved tournament cannot accept chat replies");
  const messages = getEvents(runId).map(parseMessage).filter((item): item is ChatMessage => Boolean(item));
  const currentRound = Math.max(1, ...messages.map(message => message.round));
  const round = run.status === "running" || run.status === "queued" ? currentRound : messages.length ? currentRound + 1 : 1;
  messageEvent(runId, { role: "user", content, round });
  return { queued: run.status !== "running" && run.status !== "queued", run: getRun(runId)! };
}

export async function runChatRound(runId: string): Promise<void> {
  let run = getRun(runId);
  if (!run || run.mode !== "chat" || run.status === "cancelled") return;
  // A failed round keeps its messages; "Keep talking" retries with other models.
  if (run.status === "failed") {
    updateRun(runId, { status: "queued", stage: "Retrying", error: "" });
    appendEvent(runId, "status", "Retrying the group chat with other models.", "Retrying");
    run = getRun(runId)!;
  }

  const isContinuous = Boolean(run.settings.continuous);
  const maxRoundsToRun = isContinuous ? MAX_AUTONOMOUS_ROUNDS : 1;
  let roundsRan = 0;

  try {
    while (true) {
      active(runId);
      run = getRun(runId)!;
      if (run.status === "cancelled") return;

      const events = getEvents(runId);
      const messages = events.map(parseMessage).filter((item): item is ChatMessage => Boolean(item));
      const maxCompletedRound = Math.max(0, ...events.filter(e => e.stage?.includes("complete")).map(e => {
        const m = e.stage?.match(/Round\s+(\d+)/i);
        return m ? parseInt(m[1], 10) : 0;
      }));
      const round = maxCompletedRound + 1;

      if (!messages.some(m => m.role === "user")) {
        throw new Error("A group round needs a user message");
      }

      const userMessages = messages.filter(m => m.role === "user");
      const latestUserDirection = userMessages[userMessages.length - 1]?.content?.trim() || "";
      const isUserGuiding = round > 1 && latestUserDirection && !latestUserDirection.toLowerCase().includes("continue");

      updateRun(runId, { status: "running", stage: `Round ${round} · chatting` });
      appendEvent(runId, "progress", `Round ${round} started. ${PARTICIPANT_NAMES.join(", ")} are talking it through.`, `Round ${round}`);

      const currentRoundUsedModels = new Set<string>();
      const allChatUsedModels = new Set(messages.filter(m => m.model).map(m => m.model!));

      let requests = 0;
      let produced = 0;
      const skipped: string[] = [];
      let lastSpeakError: unknown;
      const speak = async (participant: number, instruction: string) => {
        const label = PARTICIPANT_NAMES[participant];
        active(runId);
        const currentRun = getRun(runId)!;
        const modelToUse = await getRoundModel(currentRun, participant, currentRoundUsedModels, allChatUsedModels);
        currentRoundUsedModels.add(modelToUse);
        updateRun(runId, { stage: `Round ${round} · ${label} is replying` });
        const budget = Math.min(MAX_SPEAKER_ATTEMPTS, MAX_REQUESTS - requests);
        if (budget <= 0) throw new Error("The group round reached its request limit");
        try {
          const done = await reply(currentRun, participant, round, instruction, modelToUse, budget, currentRoundUsedModels);
          requests += done.attempts;
          currentRoundUsedModels.add(done.model);
          allChatUsedModels.add(done.model);
          produced++;
        } catch (error) {
          // One unavailable speaker sits out; the rest of the group carries on.
          if (isStop(error, runId)) throw error;
          requests += (error as { attempts?: number })?.attempts ?? 1;
          lastSpeakError = error;
          skipped.push(label);
          appendEvent(runId, "warning", `${label} could not reply after trying other models: ${error instanceof Error ? error.message : "unknown error"}. The rest of the group carries on.`, `Round ${round}`);
          messageEvent(runId, { role: "system", content: `${label} couldn't get a word in — every model tried was unavailable. The rest of the group carries on.`, round });
          active(runId);
        }
      };

      const assistantSince = (eventId: number): ChatMessage[] =>
        getEvents(runId).filter(e => e.id > eventId).map(parseMessage)
          .filter((m): m is ChatMessage => Boolean(m && m.role === "assistant"));

      let voteMarker = 0;
      /** Everyone votes for the strongest option; returns its 1-based number, or -1. */
      const vote = async (options: ChatMessage[]): Promise<number> => {
        if (options.length < 2) return -1;
        const ballot = options.map((option, index) => `${index + 1}. ${cleanCut(option.content, 150)}`).join("\n");
        for (const participant of SEATS) {
          await speak(participant, `Cast your vote: which option is strongest? Reply with ONLY one line starting with the option number, a dash, and your short reason (for example "2 — the demo moment is unbeatable").\nBallot:\n${ballot}`);
        }
        const tally = new Map<number, number>();
        for (const ballotVote of assistantSince(voteMarker).slice(-SEATS.length)) {
          const match = /^\s*(\d+)\s*[—\-:]/.exec(ballotVote.content);
          const pick = match ? parseInt(match[1], 10) : NaN;
          if (pick >= 1 && pick <= options.length) tally.set(pick, (tally.get(pick) ?? 0) + 1);
        }
        let top = -1;
        let topCount = 0;
        let cast = 0;
        for (const [pick, count] of tally) {
          cast += count;
          if (count > topCount) { top = pick; topCount = count; }
        }
        if (cast >= 2 && topCount > cast / 2) return top;
        return -1;
      };

      if (round === 1) {
        const historyExclusions = exhaustedTerritories(runId);
        // Everyone pitches — same open brief for all, no roles.
        for (const participant of SEATS) {
          await speak(participant, `Pitch YOUR idea for the brief: give it a name, say what the user actually does, and what they see happen. Make it different from any idea already pitched in this chat. Stay specific and buildable. ${historyExclusions}`);
        }
        updateRun(runId, { stage: `Round ${round} · reacting` });
        // Open debate, shuffled so anyone can jump in after anyone.
        for (let lap = 0; lap < 2; lap++) {
          for (const participant of shuffled(SEATS)) await speak(participant, DISCUSS_INSTRUCTION);
        }
        // Which idea is best, and why? Majority settles it.
        let pitches = assistantSince(0).filter(m => m.round === round).slice(0, 4);
        voteMarker = getEvents(runId).at(-1)?.id ?? 0;
        let winner = await vote(pitches);
        if (winner < 0) {
          // Deadlock: nobody agreed, so everyone finds something new.
          messageEvent(runId, { role: "system", content: "Nobody agreed, so everyone is pitching a fresh idea.", round });
          const freshMarker = getEvents(runId).at(-1)?.id ?? 0;
          for (const participant of SEATS) {
            await speak(participant, "The group couldn't agree. Pitch ONE brand-new idea: a different core action and mechanism from everything pitched so far in this chat. Name it, say what the user does and sees.");
          }
          updateRun(runId, { stage: `Round ${round} · reacting` });
          for (const participant of shuffled(SEATS)) await speak(participant, DISCUSS_INSTRUCTION);
          pitches = assistantSince(freshMarker).slice(0, 4);
          voteMarker = getEvents(runId).at(-1)?.id ?? 0;
          winner = await vote(pitches);
          if (winner < 0) {
            messageEvent(runId, { role: "system", content: "The group is split — over to you to break the tie.", round });
          } else {
            messageEvent(runId, { role: "system", content: `The group settled on option ${winner} after a second round of ideas: ${cleanCut(pitches[winner - 1].content, 140)}`, round });
          }
        } else {
          messageEvent(runId, { role: "system", content: `The group settled on option ${winner}: ${cleanCut(pitches[winner - 1].content, 140)}`, round });
        }
      } else {
        // Later rounds: everyone reacts to the user, then open debate.
        const topic = isUserGuiding
          ? `React to the user's latest message ("${latestUserDirection}") directly and honestly. Move the strongest thread forward with one concrete thought, or push back with a better angle. Build on what others already said.`
          : "No new direction from the user. Pick up the most promising thread from the chat so far and push it forward with one concrete thought, or challenge it with a better angle.";
        for (const participant of shuffled(SEATS)) await speak(participant, topic);
        updateRun(runId, { stage: `Round ${round} · reacting` });
        for (let lap = 0; lap < 2; lap++) {
          const order = shuffled(SEATS);
          for (let k = 0; k < order.length; k++) {
            const wrap = lap === 1 && k === order.length - 1;
            await speak(order[k], DISCUSS_INSTRUCTION + (wrap ? " If the thread feels settled, say what seems agreed and what the user should do next." : ""));
          }
        }
      }

      // Only fail honestly when nothing got through; partial rounds still count.
      if (produced === 0) throw lastSpeakError instanceof Error ? lastSpeakError : new Error("No participant model completed a reply");
      if (skipped.length) appendEvent(runId, "warning", `${skipped.join(", ")} sat out this round after repeated model failures.`, `Round ${round} complete`);

      roundsRan++;
      appendEvent(runId, "status", `Round ${round} finished. The group shared thoughts.`, `Round ${round} complete`);

      if (roundsRan >= maxRoundsToRun) {
        updateRun(runId, { status: "completed", stage: `Round ${round} complete`, error: "" });
        break;
      }

      updateRun(runId, { status: "running", stage: `Round ${round} complete · continuing...` });
      // Brief pacing pause for continuous loop
      await new Promise(resolve => setTimeout(resolve, 2000));
      active(runId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Group chat failed";
    if (message === "Group chat stopped" || getRun(runId)?.status === "cancelled") {
      updateRun(runId, { status: "cancelled", stage: "Stopped" });
      appendEvent(runId, "status", "Group chat stopped", "Stopped");
      return;
    }
    updateRun(runId, { status: "failed", stage: "Needs attention", error: message });
    appendEvent(runId, "error", message, "Needs attention");
  }
}
