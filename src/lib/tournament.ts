import { z } from "zod";
import { appendEvent, getRun, updateRun } from "./db";
import { prose, requestStructured } from "./structured";
import { availableModels } from "./omniroute";
import { NON_CHAT_MODELS } from "./model-assignments";
import { withModelFailover } from "./failover";
import type { Brief, Candidate, DebateRecord, Evidence, FinalCandidate, JudgeScore, MetricScores, Run, TournamentResult } from "./types";

const scoreSchema = z.object({
  originality: z.number().min(0).max(10), feasibility: z.number().min(0).max(10), demoImpact: z.number().min(0).max(10),
  constraintFit: z.number().min(0).max(10), simplicity: z.number().min(0).max(10), surprise: z.number().min(0).max(10),
});
export const briefSchema = z.object({
  goal: z.string(), audience: z.string(), tone: z.array(z.string()), constraints: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  avoid: z.array(z.string()), priorities: z.array(z.string()), assumptions: z.array(z.string()),
});
const genomeSchema = z.object({
  interaction: z.string(), input: z.string(), output: z.string(), humor_or_hook: z.string(),
  complexity: z.enum(["low", "medium", "high"]), technologies: z.array(z.string()),
});
const ideaSchema = z.object({
  title: prose(80), oneLiner: prose(180), concept: prose(700), demo: prose(450),
  buildPlan: z.array(z.string()).min(2).max(5), risks: z.array(z.string()).max(4), genome: genomeSchema,
});
const generationSchema = z.object({ ideas: z.array(ideaSchema).length(3) });
const filterSchema = z.object({
  clusters: z.array(z.object({ ids: z.array(z.string()).min(1), representativeId: z.string(), reason: z.string(), scores: scoreSchema })),
});
const textSchema = z.object({ text: prose(1200, 20) });
const mutationSchema = z.object({
  title: prose(80), oneLiner: prose(180), concept: prose(800), demo: prose(500), buildPlan: z.array(z.string()).min(2).max(5),
  risks: z.array(z.string()).max(4), genome: genomeSchema, changes: z.array(z.string()).min(1).max(5), rationale: prose(500), unresolvedRisks: z.array(z.string()).max(4),
});
const jurySchema = z.object({ scores: z.array(z.object({ ideaId: z.string(), ...scoreSchema.shape, rationale: prose(500) })) });

async function structured<T extends z.ZodType>(run: Run, model: string, stage: string, prompt: string, schema: T): Promise<z.infer<T> & { modelAttribution: string }> {
  let modelAttribution = model;
  const warning = (message: string) => { appendEvent(run.id, "warning", message, stage); };
  const value = await withModelFailover({ model, checkActive: () => active(run.id), warning,
    alternatives: async () => (await availableModels()).map(item => item.id).filter(id => !NON_CHAT_MODELS.test(id)).sort((a, b) => Number(a.split("/")[0] === model.split("/")[0]) - Number(b.split("/")[0] === model.split("/")[0])),
    invoke: requested => requestStructured({ model: requested, stage, prompt, schema, checkActive: () => active(run.id),
      onModel: (reported, attempt) => { modelAttribution = reported; appendEvent(run.id, "progress", `${stage}: requested ${requested}; gateway reported ${reported} (attempt ${attempt})`, stage); }, warning }),
  });
  appendEvent(run.id, "message", JSON.stringify({ model: modelAttribution, requestedModel: model, role: stage, content: value }), stage);
  return Object.assign(value as object, { modelAttribution }) as z.infer<T> & { modelAttribution: string };
}

function active(runId: string): void {
  const run = getRun(runId);
  if (!run || run.status === "cancelled") throw new Error("Tournament cancelled");
  if (run.status === "failed") throw new Error("Tournament has stopped");
}

function updateStage(run: Run, stage: string, message: string): void {
  updateRun(run.id, { status: "running", stage });
  appendEvent(run.id, "progress", message, stage);
}

function presetInstruction(preset: Run["preset"]): string {
  return {
    general: "Optimize for the prompt's stated priorities.",
    hackathon: "Optimize for a memorable demo, a buildable short timeline, and an original interaction.",
    startup: "Optimize for a real customer problem, differentiation, evidence needed, and a narrow MVP.",
    creative: "Optimize for a distinctive experience, an expressive hook, and practical production choices.",
    personal: "Optimize for learning value, manageable scope, and a satisfying build.",
  }[preset];
}

async function parallelLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let cursor = 0;
  let failure: unknown;
  async function worker() { while (!failure && cursor < items.length) { const index = cursor++; try { result[index] = await fn(items[index], index); } catch (error) { failure = error; } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return result;
}

function candidateView(candidate: Candidate): object {
  return { id: candidate.id, title: candidate.title, oneLiner: candidate.oneLiner, concept: candidate.concept, demo: candidate.demo, buildPlan: candidate.buildPlan, risks: candidate.risks, genome: candidate.genome, evidence: candidate.evidence };
}

function average(scores: JudgeScore[]): MetricScores {
  const keys = Object.keys(scoreSchema.shape) as (keyof MetricScores)[];
  return Object.fromEntries(keys.map((key) => [key, scores.reduce((sum, score) => sum + score[key], 0) / scores.length])) as MetricScores;
}

function weighted(score: MetricScores): number {
  return Number((score.originality * 3 + score.feasibility * 2 + score.demoImpact * 2 + score.constraintFit * 1.5 + score.simplicity + score.surprise * 0.5).toFixed(1));
}

async function research(candidate: Candidate): Promise<Evidence[]> {
  if (!process.env.TAVILY_API_KEY) return [];
  const query = `${candidate.title} ${candidate.oneLiner}`.slice(0, 350);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 4, search_depth: "basic" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Novelty search failed with ${response.status}`);
  const data = await response.json() as { results?: { url: string; title: string; content: string }[] };
  const results = data.results ?? [];
  return results.map((item) => ({ url: item.url, title: item.title, snippet: item.content.slice(0, 300), query, risk: "unknown" as const }));
}

export async function runTournament(runId: string): Promise<void> {
  try {
    let run = getRun(runId);
    if (!run || run.status === "cancelled") return;
    updateRun(runId, { status: "running", stage: "Understand brief" });

    updateStage(run, "Understand brief", "Extracting the shared brief");
    const brief = await structured(run, run.settings.models.analyzer, "brief analysis", `Convert this user problem into a shared constitution for all agents. Preset: ${run.preset}. ${presetInstruction(run.preset)}\nUser problem: ${run.prompt}\nReturn {goal,audience,tone,constraints,avoid,priorities,assumptions}.`, briefSchema) as Brief;
    // Keep transport metadata out of the shared constitution and blind jury prompts.
    delete (brief as Brief & { modelAttribution?: string }).modelAttribution;
    active(runId); run = getRun(runId)!;

    updateStage(run, "Independent generation", "Four generator slots are producing blind candidate sets");
    const generatorOutputs = await parallelLimit(run.settings.models.generators, 2, async (model, generatorSlot) => {
      active(runId);
      return structured(run!, model, `generator ${generatorSlot + 1}`, `Generate exactly three substantially different ideas from this brief. Do not mention other agents. Seek mechanisms, not generic app names. Every idea must be understandable and buildable within the brief.\nBrief: ${JSON.stringify(brief)}\nReturn {ideas:[{title,oneLiner,concept,demo,buildPlan,risks,genome}]}.`, generationSchema);
    });
    const candidates: Candidate[] = generatorOutputs.flatMap((output, generatorSlot) => output.ideas.map((idea, index) => ({ ...idea, id: `I${generatorSlot + 1}${index + 1}`, generatorSlot, generatorModel: output.modelAttribution })));
    active(runId); run = getRun(runId)!;

    updateStage(run, "Deduplicate", "Clustering mechanisms and selecting representatives");
    const clusterInput = candidates.map((candidate) => ({ id: candidate.id, title: candidate.title, oneLiner: candidate.oneLiner, genome: candidate.genome }));
    const checkedFilter = filterSchema.superRefine((value, context) => {
      const ids = value.clusters.flatMap(cluster => cluster.ids);
      if (ids.length !== candidates.length || new Set(ids).size !== candidates.length || candidates.some(candidate => !ids.includes(candidate.id)))
        context.addIssue({ code: "custom", message: `Assign every candidate exactly once: ${candidates.map(candidate => candidate.id).join(", ")}` });
      if (value.clusters.some(cluster => !cluster.ids.includes(cluster.representativeId)))
        context.addIssue({ code: "custom", message: "Each representativeId must belong to its cluster ids." });
    });
    const filtered = await structured(run, run.settings.models.filter, "deduplication", `Cluster these candidate ideas by shared underlying mechanism. Equivalent phrasing or a superficial feature change belongs in one cluster. Return every candidate ID exactly once. Pick one representative per cluster and score each representative against the brief.\nBrief: ${JSON.stringify(brief)}\nCandidates: ${JSON.stringify(clusterInput)}\nReturn {clusters:[{ids,representativeId,reason,scores}]}.`, checkedFilter);
    const validClusters = filtered.clusters;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const representatives = validClusters.map((cluster, index) => ({ ...byId.get(cluster.representativeId)!, cluster: `C${index + 1}`, preliminary: cluster.scores }));
    const eliminated = validClusters.flatMap((cluster) => cluster.ids.filter((id) => id !== cluster.representativeId).map((id) => ({ candidate: byId.get(id)!, reason: `Merged into ${cluster.representativeId}: ${cluster.reason}` })));
    const survivors = representatives.sort((a, b) => weighted(b.preliminary!) - weighted(a.preliminary!)).slice(0, 6);
    representatives.filter((candidate) => !survivors.some((survivor) => survivor.id === candidate.id)).forEach((candidate) => eliminated.push({ candidate, reason: "Below the top six preliminary representatives." }));
    active(runId); run = getRun(runId)!;

    if (run.settings.noveltySearch && process.env.TAVILY_API_KEY) {
      updateStage(run, "Novelty evidence", "Finding related public work for survivor concepts");
      await parallelLimit(survivors, 2, async (candidate) => {
        try { candidate.evidence = await research(candidate); }
        catch (error) { candidate.evidence = []; appendEvent(runId, "warning", `Novelty research unavailable for ${candidate.title}: ${error instanceof Error ? error.message : "unknown error"}`, "Novelty evidence"); }
      });
    } else {
      appendEvent(runId, "warning", "Novelty research is unverified. Add TAVILY_API_KEY to enable external evidence.", "Novelty evidence");
    }
    active(runId); run = getRun(runId)!;

    updateStage(run, "Debate and critique", "Advocates, rebuttals, and critics are challenging the survivors");
    const debateRun = run;
    for (let index = 0; index < survivors.length; index += 2) {
      active(runId);
      const left = survivors[index]; const right = survivors[index + 1];
      if (!right) {
        const critic = await structured(run, run.settings.models.critic, `standalone critique · ${left.id}: ${left.title}`, `Act as a ruthless idea critic. Find concrete reasons this idea could be boring, technically weak, difficult to demonstrate, common, or incompatible with the brief. Do not choose a winner.\nBrief: ${JSON.stringify(brief)}\nIdea: ${JSON.stringify(candidateView(left))}\nReturn {text}.`, textSchema);
        left.debate = { opening: "No paired opponent.", rebuttal: "No paired opponent.", critic: critic.text, models: { critic: critic.modelAttribution } };
        continue;
      }
      const openings = await parallelLimit([left, right], 2, async (candidate) => structured(debateRun!, debateRun!.settings.models.generators[candidate.generatorSlot] || "auto", `generator ${candidate.generatorSlot + 1} opening · ${candidate.id}: ${candidate.title} → ${candidate === left ? right.id : left.id}`, `Advocate for your assigned idea against its opponent. Explain why it fits better, expose the opponent's weakness, name your own failure risk, and propose one improvement.\nBrief: ${JSON.stringify(brief)}\nAssigned: ${JSON.stringify(candidateView(candidate))}\nOpponent: ${JSON.stringify(candidateView(candidate === left ? right : left))}\nReturn {text}.`, textSchema));
      const rebuttals = await parallelLimit([left, right], 2, async (candidate, candidateIndex) => structured(debateRun!, debateRun!.settings.models.generators[candidate.generatorSlot] || "auto", `generator ${candidate.generatorSlot + 1} rebuttal · ${candidate.id}: ${candidate.title} → ${candidate === left ? right.id : left.id}`, `Write a direct rebuttal to the opponent's argument. Stay specific and acknowledge valid criticism.\nYour idea: ${JSON.stringify(candidateView(candidate))}\nYour opening: ${openings[candidateIndex].text}\nOpponent opening: ${openings[candidateIndex === 0 ? 1 : 0].text}\nReturn {text}.`, textSchema));
      const critic = await structured(run, run.settings.models.critic, `pair critique · ${left.id} vs ${right.id}`, `You are a ruthless judge. Destroy both ideas. Identify where each is boring, already common, technically unrealistic, hard to explain, or weak in a demo. Do not choose a winner and do not soften the critique.\nIdea A: ${JSON.stringify(candidateView(left))}\nIdea B: ${JSON.stringify(candidateView(right))}\nArguments: ${JSON.stringify({ a: openings[0].text, b: openings[1].text, aRebuttal: rebuttals[0].text, bRebuttal: rebuttals[1].text })}\nReturn {text}.`, textSchema);
      left.debate = { opponentId: right.id, opening: openings[0].text, rebuttal: rebuttals[0].text, critic: critic.text, models: { opening: openings[0].modelAttribution, rebuttal: rebuttals[0].modelAttribution, critic: critic.modelAttribution } } satisfies DebateRecord;
      right.debate = { opponentId: left.id, opening: openings[1].text, rebuttal: rebuttals[1].text, critic: critic.text, models: { opening: openings[1].modelAttribution, rebuttal: rebuttals[1].modelAttribution, critic: critic.modelAttribution } } satisfies DebateRecord;
    }
    active(runId); run = getRun(runId)!;

    updateStage(run, "Mutation", "Evolving survivors in response to the critique");
    const evolved = await parallelLimit(survivors, 2, async (candidate) => {
      const mutation = await structured(run!, run!.settings.models.mutation, `mutation · ${candidate.id}: ${candidate.title}`, `Transform this concept so its critique no longer applies. Preserve its central mechanism when possible. You may simplify, remove features, make the interaction stranger, or alter the implementation. Be honest about unresolved risks.\nBrief: ${JSON.stringify(brief)}\nCandidate: ${JSON.stringify(candidateView(candidate))}\nDebate: ${JSON.stringify(candidate.debate)}\nReturn {title,oneLiner,concept,demo,buildPlan,risks,genome,changes,rationale,unresolvedRisks}.`, mutationSchema);
      return { ...candidate, ...mutation, parentId: candidate.id, id: `${candidate.id}M`, mutation: { changes: mutation.changes, rationale: mutation.rationale, unresolvedRisks: mutation.unresolvedRisks } } as Candidate;
    });
    active(runId); run = getRun(runId)!;

    updateStage(run, "Blind jury", "Three jurors are independently scoring anonymous evolved concepts");
    const anonymous = evolved.map((candidate, index) => ({ ...candidateView(candidate), id: `F${index + 1}`, unresolvedRisks: candidate.mutation?.unresolvedRisks ?? [] }));
    const checkedJury = jurySchema.superRefine((value, context) => {
      const ids = value.scores.map(score => score.ideaId);
      if (ids.length !== anonymous.length || new Set(ids).size !== anonymous.length || anonymous.some(candidate => !ids.includes(candidate.id)))
        context.addIssue({ code: "custom", message: `Score each idea exactly once using only these ideaId values: ${anonymous.map(candidate => candidate.id).join(", ")}` });
    });
    const juryResults = await parallelLimit(run.settings.models.jury, 2, async (model, index) => {
      const rotated = [...anonymous.slice(index), ...anonymous.slice(0, index)];
      return structured(run!, model, `jury ${index + 1}`, `Score every anonymous final idea from 0 to 10 using the requested metrics. Use each idea's id as ideaId exactly once. Judge the idea, not any provider. Respect hard user constraints. Provide a concise rationale for each.\nBrief: ${JSON.stringify(brief)}\nIdeas: ${JSON.stringify(rotated)}\nReturn {scores:[{ideaId,originality,feasibility,demoImpact,constraintFit,simplicity,surprise,rationale}]}.`, checkedJury);
    });
    const finalCandidates: FinalCandidate[] = evolved.map((candidate, index) => {
      const anonymousId = `F${index + 1}`;
      const judgeScores = juryResults.map((jury) => ({ ...jury.scores.find((score) => score.ideaId === anonymousId)!, model: jury.modelAttribution })) as JudgeScore[];
      const averageScores = judgeScores.length ? average(judgeScores) : { originality: 0, feasibility: 0, demoImpact: 0, constraintFit: 0, simplicity: 0, surprise: 0 };
      const violatesHardConstraint = averageScores.constraintFit < 4;
      return { ...candidate, judgeScores, average: averageScores, finalScore: weighted(averageScores), eligible: !violatesHardConstraint, ineligibilityReason: violatesHardConstraint ? "Average constraint fit was below 4/10." : undefined };
    });
    finalCandidates.sort((a, b) => b.finalScore - a.finalScore || b.average.constraintFit - a.average.constraintFit || b.average.feasibility - a.average.feasibility || a.id.localeCompare(b.id));
    const winner = finalCandidates.find((candidate) => candidate.eligible);
    active(runId);
    const result: TournamentResult = { brief, initialCandidates: candidates, eliminated, finalists: finalCandidates, winner, completedAt: new Date().toISOString(), externalResearchEnabled: Boolean(process.env.TAVILY_API_KEY && run.settings.noveltySearch) };
    updateRun(runId, { status: "completed", stage: "Complete", result });
    appendEvent(runId, "status", winner ? `${winner.title} won the jury.` : "No candidate satisfied the hard constraints.", "Complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tournament error";
    if (message === "Tournament cancelled" || getRun(runId)?.status === "cancelled") { updateRun(runId, { status: "cancelled", stage: "Cancelled" }); appendEvent(runId, "status", "Tournament cancelled", "Cancelled"); return; }
    updateRun(runId, { status: "failed", error: message });
    appendEvent(runId, "error", message, "Needs attention");
  }
}
