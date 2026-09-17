import { randomUUID } from "node:crypto";
import { createRun, getRun, getEvents } from "../src/lib/db";
import { runTournament } from "../src/lib/tournament";
import { DEFAULT_SETTINGS } from "../src/lib/types";

async function main() {
  const id = randomUUID();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.noveltySearch = false;
  const model = process.env.IDEAARENA_SMOKE_MODEL || "auto";
  settings.models = { analyzer: model, filter: model, critic: model, mutation: model, generators: Array(4).fill(model), jury: Array(3).fill(model) };
  createRun(id, "Find a funny, useful-to-nobody hackathon project for three people in 24 hours. No hardware purchases, generic AI assistants, or productivity apps. Prioritize a memorable working demo and feasibility.", "hackathon", settings);
  console.log(`Live smoke run: ${id}; model: ${model}`);
  let cursor = 0;
  const report = () => { for (const event of getEvents(id, cursor)) { cursor = event.id; console.log(`${event.stage}: ${event.message}`); } };
  const timer = setInterval(report, 3000);
  try {
    await runTournament(id);
    report();
    const run = getRun(id)!;
    if (run.status !== "completed") throw new Error(run.error || run.status);
    console.log(JSON.stringify({ status: run.status, initialIdeas: run.result!.initialCandidates.length, finalists: run.result!.finalists.length, winner: run.result!.winner?.title, score: run.result!.winner?.finalScore, juryCounts: run.result!.finalists.map(candidate => candidate.judgeScores.length) }));
  } finally { clearInterval(timer); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
