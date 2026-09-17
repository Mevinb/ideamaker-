import { appendEvent, getEvents, getRun, listRuns, updateRun } from "./db";
import { sampleDistinctChatModels } from "./model-assignments";
import { availableModels, omniChat } from "./omniroute";
import type { ChatMessage, Run, RunEvent } from "./types";

const MAX_CONTEXT = 50_000;
const MAX_REQUESTS = 12;
const MAX_AUTONOMOUS_ROUNDS = 2;
const RECENT_RUNS_FOR_NOVELTY = 20;

export const PARTICIPANT_ROLES = ["Explorer", "Challenger", "Builder", "Connector"];
const PARTICIPANTS = [
  "A creative product visionary who loves specific, visual, memorable ideas. You pitch one concrete direction at a time and react warmly when others improve it.",
  "A sharp, pragmatic critic. You like bold ideas but call out vague, generic, or fragile parts by name and offer one sharper twist.",
  "A practical full-stack builder. You turn the strongest thread into something that can actually be built fast, naming concrete pieces and cuts.",
  "A connector who listens to everyone. You notice which bits fit together, name the direction worth keeping, and ask the one question that unblocks the next step.",
];

const IDEA_QUALITY =
  "Good ideas are concrete: name what the user does, what they see happen, and how it works in one input -> change -> payoff loop. " +
  "Avoid generic chatbots, mood journals, habit trackers, dashboards, marketplaces, or playlist generators unless the interaction itself is genuinely new. " +
  "Prefer numbers, visible consequences, and a real demo moment over adjectives like seamless, immersive, or delightful.";

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
  if (message.participant !== undefined) return PARTICIPANT_ROLES[message.participant] || `Participant ${message.participant + 1}`;
  return "Participant";
}

function active(runId: string): void {
  const run = getRun(runId);
  if (!run || run.status === "cancelled") throw new Error("Group chat stopped");
  if (run.status === "failed") throw new Error("Group chat has stopped");
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

/** Compact first-round ideas from other chats give new sessions a useful novelty boundary. */
function recentIdeaExclusions(runId: string): string {
  const excerpts: string[] = [];
  for (const previous of listRuns()) {
    if (previous.id === runId || previous.mode !== "chat") continue;
    const openings = getEvents(previous.id).map(parseMessage)
      .filter((message): message is ChatMessage => Boolean(message && message.role === "assistant" && message.round === 1))
      .slice(0, 3);
    for (const opening of openings) {
      const compact = opening.content.replace(/\s+/g, " ").trim();
      if (compact) excerpts.push(compact.slice(0, 240));
    }
    if (excerpts.length >= RECENT_RUNS_FOR_NOVELTY * 3) break;
  }
  if (!excerpts.length) return "No prior opening ideas are saved yet.";
  return `Avoid repeating these prior opening ideas, including renamed versions with the same user experience or mechanism:\n${excerpts.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
}

const FAILED_MODELS = new Set<string>();

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
  maxAttempts: number
): Promise<number> {
  active(run.id);
  const requested = modelToUse || run.settings.models.generators[participant] || "auto";
  const name = PARTICIPANT_ROLES[participant];
  const others = PARTICIPANT_ROLES.filter((_, index) => index !== participant).join(", ");
  const system = `You are ${name} in a small group chat with ${others}, brainstorming together. ${PARTICIPANTS[participant]} Talk like a real person in a group thread: use plain prose with no bullet points, headings, or reports, reply to specific people by name, quote a concrete detail they said, and add one thought per message. Keep it short: 2-5 sentences, under 450 characters. Never summarize the whole chat or deliver a verdict. ${presetDirection(run.preset)} ${IDEA_QUALITY}`;
  const user = `User's brief: ${run.prompt}\n\nGroup chat so far:\n${transcript(run)}\n\nYour turn, ${name}: ${instruction}`;

  let alternatives: string[] = [];
  try {
    const available = (await availableModels()).map(m => m.id).filter(m => !FAILED_MODELS.has(m));
    alternatives = sampleDistinctChatModels(available, 4, new Set([requested, ...FAILED_MODELS]));
  } catch {
    appendEvent(run.id, "warning", "A fallback model could not be checked for this reply.", `Round ${round}`);
  }

  const candidates = [requested, ...alternatives].slice(0, Math.max(1, maxAttempts));
  let lastError: unknown;
  let attempts = 0;
  for (const model of candidates) {
    attempts++;
    try {
      const answer = await omniChat({ model, system, user, maxTokens: 400, signal: AbortSignal.timeout(60_000) });
      active(run.id);
      const content = cleanCut(answer.content, 580);
      if (!content) throw new Error("The model returned an empty reply");
      messageEvent(run.id, { role: "assistant", agent: name, participant, model: answer.model, content, round });
      if (model !== requested) appendEvent(run.id, "warning", `${name} used fallback model ${answer.model} after ${requested} failed.`, `Round ${round}`);
      return attempts;
    } catch (error) {
      FAILED_MODELS.add(model);
      lastError = error;
      active(run.id);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No participant model completed a reply");
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
      appendEvent(runId, "progress", `Round ${round} started. Explorer, Challenger, Builder, and Connector are talking it through.`, `Round ${round}`);

      const currentRoundUsedModels = new Set<string>();
      const allChatUsedModels = new Set(messages.filter(m => m.model).map(m => m.model!));

      let requests = 0;
      const speak = async (participant: number, instruction: string) => {
        if (requests >= MAX_REQUESTS) throw new Error("The group round reached its request limit");
        active(runId);
        const currentRun = getRun(runId)!;
        const modelToUse = await getRoundModel(currentRun, participant, currentRoundUsedModels, allChatUsedModels);
        currentRoundUsedModels.add(modelToUse);
        allChatUsedModels.add(modelToUse);
        const label = PARTICIPANT_ROLES[participant];
        updateRun(runId, { stage: `Round ${round} · ${label} is replying` });
        requests += await reply(currentRun, participant, round, instruction, modelToUse, Math.min(3, MAX_REQUESTS - requests));
      };

      if (round === 1) {
        const historyExclusions = recentIdeaExclusions(runId);
        await speak(0, `Open the chat. React to the brief like a friend with a fresh take and pitch ONE concrete idea in your own words: give it a name, say what the user actually does, and what they see happen. Stay specific and buildable. ${historyExclusions}`);
        await speak(1, "Explorer just opened. Reply to Explorer by name: say what feels weak, risky, or generic, then offer one sharper twist that keeps what works. Be honest, not rude.");
        await speak(2, "Reply to Explorer and Challenger by name. Pick the strongest thread so far and say how you would actually build the first working version: concrete pieces, what to cut, and what it does on day one.");
        updateRun(runId, { stage: `Round ${round} · reacting` });
        await speak(3, "Reply to everyone by name. Say which bits fit together, name the direction you would keep exploring, and end with one sharp question for the group or user.");
        updateRun(runId, { stage: `Round ${round} · building` });
        await speak(0, "The group pushed back. Reply to them by name, keep your idea, and fix its weakest part with one concrete change. Say what you changed and why.");
        await speak(3, "Close this round like a person, not a report. Say which idea you would carry forward and why in a sentence or two, plus what you want from the user next. Do not list options or declare a winner.");
      } else if (isUserGuiding) {
        await speak(0, `The user just said: "${latestUserDirection}". Reply to them directly, stay with their direction unless it is weak, and move the idea forward with one concrete suggestion grounded in the chat so far.`);
        await speak(1, `The user said: "${latestUserDirection}". Reply to the group by name: what is still risky or vague, and what is one sharper fix?`);
        await speak(2, `The user said: "${latestUserDirection}". Reply by name: what would you build next, concretely, and what would you cut to keep it working?`);
        updateRun(runId, { stage: `Round ${round} · reacting` });
        await speak(3, `React to everyone by name, pull the thread together, and ask the one question that would unblock the next step for: "${latestUserDirection}".`);
        updateRun(runId, { stage: `Round ${round} · building` });
        await speak(0, "Give one concrete next step the group could try first, in plain words. Reference what others said.");
        await speak(3, "Wrap naturally: say what stuck from this round and what to try next. No report, no list, no winner.");
      } else {
        await speak(0, "No new user direction. Pick up the most promising thread from the chat so far, do not restart, and push it one step forward with a concrete detail.");
        await speak(1, "Reply by name to what was just said. Challenge the weakest assumption and offer one sharper alternative.");
        await speak(2, "Reply by name. Ground the current direction: what gets built next, what gets cut, and what working looks like.");
        updateRun(runId, { stage: `Round ${round} · reacting` });
        await speak(3, "Reply by name, connect the best bits, and ask the group one useful question that keeps the conversation moving.");
        updateRun(runId, { stage: `Round ${round} · building` });
        await speak((round - 1) % 3, "Add one vivid, concrete detail: what the user sees, hears, or does in the key moment. Keep it short and human.");
        await speak(3, "Close the round like a person. Say what you would keep and what you need from the user next. No report or winner.");
      }

      roundsRan++;
      appendEvent(runId, "status", `Round ${round} finished. The group shared thoughts.`, `Round ${round} complete`);

      if (roundsRan >= maxRoundsToRun) {
        updateRun(runId, { status: "completed", stage: `Round ${round} complete` });
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
