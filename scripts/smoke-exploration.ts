import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.IDEAARENA_DATA_DIR ||= mkdtempSync(join(tmpdir(), "idea-live-exploration-"));

async function main() {
  const { createRun, appendEvent, getRun, getExploration, getEvents } = await import("../src/lib/db");
  const { runExploration } = await import("../src/lib/exploration");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const { AGENT_ROLES } = await import("../src/lib/agent-types");
  const prompt = "Find wild experimental browser experiences for three people to prototype in 24 hours. No extra hardware. Avoid chatbots, dashboards, camera-to-music toys and productivity assistants. Surprise us with unusual user actions and visible consequences.";
  console.log(`Isolated validation database: ${process.env.IDEAARENA_DATA_DIR}`);
  for (let i = 1; i <= 2; i++) {
    const id = `live-${Date.now()}-${i}`;
    const agentModels = process.env.IDEAARENA_SMOKE_MODEL ? Object.fromEntries(AGENT_ROLES.map(r => [r, process.env.IDEAARENA_SMOKE_MODEL!])) : undefined;
    createRun(id, prompt, "creative", { ...DEFAULT_SETTINGS, workflow: "exploration-v1", agentModels, noveltySearch: false, continuous: false }, "chat");
    appendEvent(id, "message", JSON.stringify({ role: "user", content: prompt, round: 1 }));
    let cursor = 0;
    const timer = setInterval(() => { for (const event of getEvents(id, cursor)) { cursor = event.id; if (event.kind !== "message") console.log(`${i}: ${event.kind}: ${event.message.slice(0, 400)}`); } }, 3000);
    try { await runExploration(id); } finally { clearInterval(timer); }
    console.log(JSON.stringify({ run: i, id, status: getRun(id)!.status, error: getRun(id)!.error, candidates: getExploration(id)?.candidates.length, attempts: getExploration(id)?.attempts, shortlist: getExploration(id)?.shortlist }, null, 2));
    const state = getExploration(id);
    const reviews = state?.reviews ?? [];
    const byId = new Map(reviews.map(r => [r.id, r]));
    console.log(JSON.stringify({
      mechanisms: state?.shortlist.map(c => ({ id: c.id, title: c.title, mechanism: c.mechanism.slice(0, 300), scores: byId.get(c.id) ? { surprise: byId.get(c.id)!.surprise, taste: byId.get(c.id)!.taste } : undefined })),
      rejections: getEvents(id).filter(e => e.kind === "progress" && e.message.includes("rejected")).map(e => e.message.slice(0, 200)),
      duplicates: reviews.filter(r => r.duplicateOf).length,
    }, null, 2));
    if (getRun(id)!.status !== "completed") process.exitCode = 1;
  }
}
void main();
