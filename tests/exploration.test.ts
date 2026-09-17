import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.IDEAARENA_DATA_DIR = mkdtempSync(join(tmpdir(), "idea-agents-"));

import type { Concept, Review } from "../src/lib/agent-types";
const concept = (id: string): Concept => ({ id, title: id, problem: "A specific unmet need", mechanism: `Mechanism ${id}`, interaction: `Action ${id}`, output: `Output ${id}`, moment: "A surprising transformation", prototype: "A concrete first experiment", uncertainties: "Needs an experiment", explorer: 0, revision: 0 });
const review = (id: string): Review => ({ id, cluster: id, duplicateOf: null, surprise: 9, taste: 9, violatesConstraints: false, reason: "Distinct experiment" });

test("quality gates reject renamed repeats, weak taste, shared mechanisms and hard violations", async () => {
  const { qualify } = await import("../src/lib/exploration");
  const cs = ["a", "b", "c", "d", "e"].map(concept);
  const rows = [0, 1, 2].map(() => cs.map(c => review(c.id)));
  rows[0][1].duplicateOf = "a"; rows[1][2].taste = 5; rows[2][3].violatesConstraints = true; rows[0][4].cluster = "a";
  const result = qualify(cs, rows);
  assert.deepEqual(result.accepted.map(c => c.id), ["a"]);
  assert.equal(result.rejected.length, 4);
  assert.equal(qualify(cs, []).accepted.length, 0);
});

test("leases, history, feedback and old records remain compatible", async () => {
  const db = await import("../src/lib/db"); const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const { historicalConcepts } = await import("../src/lib/exploration");
  db.createRun("history", "Experimental toy", "creative", DEFAULT_SETTINGS, "chat");
  db.appendEvent("history", "message", JSON.stringify({ role: "assistant", round: 1, content: "A remembered historical mechanism" }));
  assert.ok(JSON.stringify(historicalConcepts("different")).includes("remembered historical"));
  assert.ok(!JSON.stringify(historicalConcepts("history")).includes("remembered historical"));
  assert.equal(db.acquireLease("history", "one"), true); assert.equal(db.acquireLease("history", "two"), false);
  db.releaseLease("history", "two"); assert.equal(db.hasLease("history"), true); db.releaseLease("history", "one");
  db.addTasteFeedback({ runId: "history", conceptId: "a", concept: concept("a"), kind: "familiar", reason: "Seen this before" });
  assert.equal(db.getTasteFeedback()[0].reason, "Seen this before"); db.clearTasteFeedback(); assert.equal(db.getTasteFeedback().length, 0);
});

test("deep exploration replaces failed ideas, resumes checkpoints, uses 13 roles, and persists first-round options", async () => {
  const db = await import("../src/lib/db"); const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const { runExploration } = await import("../src/lib/exploration");
  const realFetch = globalThis.fetch;
  const calls: { agent: string; user: string }[] = [];
  let failGeneration = true;
  let alwaysReject = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    const body = JSON.parse(String(init?.body)); const system = body.messages[0].content as string; const user = body.messages[1].content as string;
    const agent = system.split(" in an experimental")[0].replace("You are ", ""); calls.push({ agent, user });
    if (agent === "Explorer 4" && failGeneration) return new Response("Provider unavailable", { status: 503 });
    let output: unknown;
    if (user.includes("Assign exactly eight orthogonal")) output = { goal: "Experimental toy", hardConstraints: ["Build solo overnight"], preferences: ["Wild"], assignments: Array.from({ length: 8 }, (_, i) => ({ direction: `Independent direction ${i}`, excludedMechanisms: [] })) };
    else if (user.includes("Determine whether the LATEST")) output = { selectedId: null, reason: "User requested further exploration" };
    else if (user.includes("The user explicitly selected")) output = concept("Refined selection");
    else if (user.includes("Explain the refined concept")) output = { explanation: "A concrete refinement with unresolved experimental risks." };
    else if (user.includes("Decide which failed")) output = { action: "replace", targets: ["1", "2"], instruction: "Change the core mechanism" };
    else if (agent.startsWith("Explorer")) output = { ideas: [concept(`${agent}-one`), concept(`${agent}-two`)] };
    else if (agent.endsWith("reviewer")) {
      const cs = JSON.parse(user.split("\nCandidates:")[1].split("\nHistory:")[0]) as Concept[];
      output = { reviews: cs.map(c => ({ ...review(c.id), taste: alwaysReject || c.revision === 0 ? 4 : 9 })) };
    } else {
      const cs = JSON.parse(user.split("Shortlist:")[1]) as Concept[];
      output = { comparisons: cs.map(c => ({ id: c.id, explanation: "Different core experience, with an explicit risk." })), nextQuestion: "Which direction interests you?" };
    }
    return Response.json({ model: "fixture", choices: [{ message: { content: JSON.stringify(output) } }] });
  };
  try {
    db.createRun("deep", "A strange experimental toy without any required AI", "creative", { ...DEFAULT_SETTINGS, workflow: "exploration-v1", noveltySearch: false }, "chat");
    db.appendEvent("deep", "message", JSON.stringify({ role: "user", content: "A strange experimental toy without any required AI", round: 1 }));
    await runExploration("deep"); assert.equal(db.getRun("deep")!.status, "failed");
    const firstExplorerCalls = calls.filter(c => c.agent === "Explorer 1").length;
    failGeneration = false; await runExploration("deep");
    const state = db.getExploration("deep")!;
    assert.equal(db.getRun("deep")!.status, "completed", db.getRun("deep")!.error);
    assert.equal(state.shortlist.length, 3); assert.equal(state.cycle, 1); assert.equal(state.candidates.length, 20);
    assert.equal(calls.filter(c => c.agent === "Explorer 1").length, firstExplorerCalls + 1, "Only replacement should repeat completed explorer");
    assert.equal(new Set(calls.map(c => c.agent)).size, 13);
    assert.ok(calls.filter(c => c.agent.startsWith("Explorer")).every(c => !c.user.includes("Build solo overnight")), "Invented constraints must not reach explorers");
    assert.ok(calls.filter(c => c.agent.startsWith("Explorer") && !c.user.includes("Retained concepts")).every(c => !c.user.includes("Explorer 1-one")));
    assert.ok(db.getEvents("deep").some(e => e.message.includes("rejected")));
    assert.ok(JSON.stringify((await import("../src/lib/exploration")).historicalConcepts("new-run")).includes("Mechanism Explorer"));
    const count = calls.length; await runExploration("deep"); assert.equal(calls.length, count, "Finished round is idempotent");
    db.appendEvent("deep", "message", JSON.stringify({ role: "user", content: "Develop this idea", selectedConceptId: state.shortlist[0].id, round: 2 }));
    await runExploration("deep");
    assert.equal(db.getExploration("deep")!.round, 2);
    assert.equal(db.getExploration("deep")!.shortlist.length, 1);
    assert.equal(calls.length, count + 2, "Explicit selection refines instead of generating another pool");
    db.createRun("continuous-deep", "Explore unusual things", "creative", { ...DEFAULT_SETTINGS, workflow: "exploration-v1", noveltySearch: false, continuous: true }, "chat");
    db.appendEvent("continuous-deep", "message", JSON.stringify({ role: "user", content: "Explore unusual things", round: 1 }));
    await runExploration("continuous-deep");
    assert.equal(db.getExploration("continuous-deep")!.round, 2);
    assert.equal(db.getRun("continuous-deep")!.status, "completed");
    assert.equal(db.getExploration("continuous-deep")!.selectedId, undefined, "Continue does not invent a winner");
    alwaysReject = true;
    db.createRun("exhausted", "Explore unusual things", "creative", { ...DEFAULT_SETTINGS, workflow: "exploration-v1", noveltySearch: false }, "chat");
    db.appendEvent("exhausted", "message", JSON.stringify({ role: "user", content: "Explore unusual things", round: 1 }));
    await runExploration("exhausted");
    assert.equal(db.getExploration("exhausted")!.cycle, 3);
    assert.equal(db.getExploration("exhausted")!.shortlist.length, 0);
    assert.equal(db.getRun("exhausted")!.status, "completed");
    assert.ok(db.getEvents("exhausted").some(e => e.message.includes("Fewer than three")));
  } finally { globalThis.fetch = realFetch; }
});

test("elapsed and attempt budgets stop without another provider call", async () => {
  const db = await import("../src/lib/db"); const { DEFAULT_SETTINGS } = await import("../src/lib/types"); const { runExploration } = await import("../src/lib/exploration");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => { assert.ok(String(url).endsWith("/models")); return Response.json({ data: [] }); };
  try {
    for (const [id, attempts, startedAt] of [["time-budget", 2, Date.now() - 21 * 60_000], ["call-budget", 96, Date.now()]] as const) {
      db.createRun(id, "Budget test", "creative", { ...DEFAULT_SETTINGS, workflow: "exploration-v1" }, "chat");
      db.saveExploration(id, { round: 1, attempts, startedAt, done: false, cycle: 0, tasks: {}, candidates: [], reviews: [], shortlist: [] });
      await runExploration(id);
      assert.equal(db.getExploration(id)!.attempts, attempts); assert.equal(db.getRun(id)!.status, "completed"); assert.match(db.getRun(id)!.stage, /Budget reached/);
    }
  } finally { globalThis.fetch = realFetch; }
});

test("Stop aborts an in-flight provider request and keeps completed checkpoints", async () => {
  const db = await import("../src/lib/db"); const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const { runExploration, stopExploration } = await import("../src/lib/exploration");
  const realFetch = globalThis.fetch; let aborted = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("Stopped")); });
      setTimeout(() => stopExploration("stop"), 5);
    });
  };
  try {
    db.createRun("stop", "A cancellation test", "creative", { ...DEFAULT_SETTINGS, workflow: "exploration-v1" }, "chat");
    db.appendEvent("stop", "message", JSON.stringify({ role: "user", content: "Test", round: 1 }));
    await Promise.all([runExploration("stop"), runExploration("stop")]);
    assert.ok(aborted); assert.equal(db.getRun("stop")!.status, "cancelled"); assert.equal(db.getExploration("stop")!.attempts, 1);
    assert.equal(db.hasLease("stop"), false);
  } finally { globalThis.fetch = realFetch; }
});

test("paraphrased clusters collapse and low originality is rejected", async () => {
  const { normalizeCluster, qualify } = await import("../src/lib/exploration");
  assert.equal(normalizeCluster("Dream Garden Experience!"), normalizeCluster("dream-garden experience"));
  assert.equal(normalizeCluster("Typing deforms text"), normalizeCluster("text deforms typing"));
  const cs = ["a", "b", "c"].map(concept);
  const rows = [0, 1, 2].map(() => cs.map(c => review(c.id)));
  rows[0][1].surprise = 4;
  rows[0][2].cluster = "A";
  cs[2].id = "c";
  // b fails the originality floor even with strong taste scores.
  const low = qualify(cs, rows);
  assert.ok(low.rejected.some(r => r.id === "b" && r.reason.includes("originality")));
  // Paraphrase of an accepted cluster is rejected as the same mechanism family.
  const cs2 = ["x", "y"].map(concept);
  const rows2 = [0, 1, 2].map(() => cs2.map(c => review(c.id)));
  rows2[0][0].cluster = "Dream Garden Experience";
  rows2[0][1].cluster = "dream-garden experience!";
  const dup = qualify(cs2, rows2);
  assert.equal(dup.accepted.length, 1);
  assert.ok(dup.rejected[0].reason.includes("Same mechanism cluster"));
});

test("deterministic similarity hints flag near-duplicate mechanisms", async () => {
  const { similarityHints } = await import("../src/lib/exploration");
  const a = { id: "a", title: "t", problem: "p", mechanism: "typing deforms text into waves", interaction: "type to deform", output: "wavy text", moment: "m", prototype: "p", uncertainties: "u", explorer: 0, revision: 0 };
  const b = { ...a, id: "b", title: "t2", mechanism: "scrolling deforms text into waves" };
  const c = { ...a, id: "c", title: "t3", mechanism: "trade a visible memory for an inspectable shortcut", interaction: "sacrifice to gain", output: "shortcut token" };
  const hints = similarityHints([a, b, c]);
  assert.ok(hints.includes("a ~ b"));
  assert.ok(!hints.includes("a ~ c"));
});
