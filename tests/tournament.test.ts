import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { availableModels, omniChat, parseJsonOrSse } from "../src/lib/omniroute";
import { requestStructured } from "../src/lib/structured";
import { filterAvailableModels, type AvailabilitySnapshot } from "../src/lib/model-availability";

process.env.IDEAARENA_DATA_DIR = mkdtempSync(join(tmpdir(), "ideaarena-tests-"));

test("availability includes paid account models but excludes unsupported variants, exhausted and unhealthy accounts", () => {
  const snapshot: AvailabilitySnapshot = {
    connections: [
      { id: "a", provider: "antigravity", is_active: 1, test_status: "active", rate_limited_until: null },
      { id: "o", provider: "openrouter", is_active: 1, test_status: "active", rate_limited_until: null },
    ],
    synced: { "openrouter:o": [{ id: "example/free:free" }, { id: "example/paid" }] },
    limits: { a: { fetchedAt: new Date().toISOString(), quotas: { "claude-opus-4-6-thinking": { remainingPercentage: 99 }, "empty": { remainingPercentage: 0 } } } },
  };
  const catalog = ["auto", "auto/best-coding", "antigravity/claude-opus-4-6-high", "antigravity/claude-opus-4-6-thinking", "antigravity/empty", "openrouter/example/paid", "openrouter/example/free:free", "openrouter/not-synced:free"].map(id => ({ id }));
  assert.deepEqual(filterAvailableModels(catalog, snapshot).map(model => model.id), ["antigravity/claude-opus-4-6-thinking", "openrouter/example/free:free", "openrouter/example/paid"]);
  snapshot.connections[0].test_status = "error";
  snapshot.connections[1].rate_limited_until = new Date(Date.now() + 60000).toISOString();
  assert.deepEqual(filterAvailableModels(catalog, snapshot), []);

  // OpenCode free models filtering (unauthenticated vs authenticated)
  const ocSnapshot: AvailabilitySnapshot = {
    connections: [
      { id: "oc", provider: "opencode", is_active: 1, test_status: "active", rate_limited_until: null, has_key: 0, is_configured: 1 },
    ],
    synced: { "opencode:oc": [{ id: "big-pickle" }, { id: "mimo-v2.5-free" }, { id: "claude-sonnet-4-5" }] },
    limits: {},
  };
  const ocCatalog = [{ id: "opencode/big-pickle" }, { id: "opencode/mimo-v2.5-free" }, { id: "opencode/claude-sonnet-4-5" }];
  assert.deepEqual(filterAvailableModels(ocCatalog, ocSnapshot).map(m => m.id), ["opencode/big-pickle", "opencode/mimo-v2.5-free"]);

  // When key is provided, paid models become available
  ocSnapshot.connections[0].has_key = 1;
  assert.deepEqual(filterAvailableModels(ocCatalog, ocSnapshot).map(m => m.id), ["opencode/big-pickle", "opencode/claude-sonnet-4-5", "opencode/mimo-v2.5-free"]);

  // Antigravity cached quotas older than 60 minutes remain available
  const staleAgSnapshot: AvailabilitySnapshot = {
    connections: [
      { id: "a", provider: "antigravity", is_active: 1, test_status: "active", rate_limited_until: null },
    ],
    synced: {},
    limits: {
      a: {
        fetchedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        quotas: {
          "claude-opus-4-6-thinking": { remainingPercentage: 100 },
          "gemini-2.5-flash": { remainingPercentage: 0, resetAt: new Date(Date.now() - 60000).toISOString() },
          "exhausted": { remainingPercentage: 0, resetAt: new Date(Date.now() + 60000).toISOString() },
        },
      },
    },
  };
  const staleAgCatalog = [
    { id: "antigravity/claude-opus-4-6-thinking" },
    { id: "antigravity/gemini-2.5-flash" },
    { id: "antigravity/exhausted" },
    { id: "antigravity/not-in-quotas" },
  ];
  assert.deepEqual(
    filterAvailableModels(staleAgCatalog, staleAgSnapshot).map(m => m.id),
    ["antigravity/claude-opus-4-6-thinking", "antigravity/gemini-2.5-flash"]
  );
});

test("model catalog is fetched fresh, deduplicated, and rejects gateway failures", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/models$/);
    assert.equal(init?.cache, "no-store");
    return Response.json({ data: [{ id: "provider/z" }, { id: "provider/a" }, { id: "provider/z" }, { id: "" }] });
  };
  try {
    assert.deepEqual(await availableModels({ connections: [], synced: {}, limits: {} }), []);
    globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
    await assert.rejects(availableModels(), /503/);
    globalThis.fetch = async () => Response.json({ wrong: [] });
    await assert.rejects(availableModels(), /invalid model catalog/);
  } finally { globalThis.fetch = realFetch; }
});

const brief = { goal: "Funny hackathon", audience: "Judges", tone: ["funny"], constraints: { hours: 24, hardware: false }, avoid: ["assistants"], priorities: ["demo"], assumptions: [] };
const scores = { originality: 8, feasibility: 9, demoImpact: 8, constraintFit: 9, simplicity: 8, surprise: 7 };
const idea = { title: "Object orchestra", oneLiner: "Household objects conduct a soundscape.", concept: "A camera turns object movement into musical notes.", demo: "Move a spoon to play a bass line.", buildPlan: ["Track objects", "Map movement to notes"], risks: ["Lighting"], genome: { interaction: "camera", input: "objects", output: "music", humor_or_hook: "Unexpected instruments", complexity: "low", technologies: ["OpenCV"] } };

test("JSON and SSE decode the same completion; reject partial streams", () => {
  const content = JSON.stringify(brief);
  assert.equal(parseJsonOrSse(JSON.stringify({ choices: [{ message: { content } }] })).content, content);
  const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
  const stream = `: heartbeat\r\nevent: completion\r\n${frame(content.slice(0, 30))}${frame(content.slice(30))}data: [DONE]\r\n\r\n`;
  assert.equal(parseJsonOrSse(stream).content, content);
  assert.throws(() => parseJsonOrSse(frame("partial")), /before completion/);
  assert.throws(() => parseJsonOrSse('data: {"error":{"message":"quota exceeded"}}\n\n'), /quota exceeded/);
  assert.throws(() => parseJsonOrSse('data: [DONE]\n\n'), /empty/);
});

test("every attempt carries the schema; repairs carry exact errors and full context", async () => {
  const schema = z.object({ tone: z.array(z.string()), constraints: z.record(z.string(), z.string()) });
  let calls = 0;
  const result = await requestStructured({ model: "test", stage: "brief", prompt: "Keep the original constraints.", schema,
    chat: async request => {
      assert.match(request.system, /"type":"array"/);
      assert.match(request.system, /"type":"object"/);
      if (calls++) {
        assert.match(request.user, /tone:.*expected array/);
        assert.match(request.user, /constraints:/);
        assert.match(request.user, /Keep the original constraints/);
        return { content: JSON.stringify({ tone: ["funny"], constraints: { time: "24 hours" } }), model: "test" };
      }
      return { content: JSON.stringify({ tone: "funny", constraints: "24 hours" }), model: "test" };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { tone: ["funny"], constraints: { time: "24 hours" } });
});

test("repair exhaustion and cancellation fail explicitly", async () => {
  let calls = 0;
  await assert.rejects(requestStructured({ model: "test", stage: "brief", prompt: "brief", schema: z.object({ tone: z.array(z.string()) }), chat: async () => { calls++; return { content: '{}', model: "test" }; } }), /brief returned invalid.*two repairs/);
  assert.equal(calls, 3);
  await assert.rejects(requestStructured({ model: "test", stage: "brief", prompt: "brief", schema: z.object({}), checkActive: () => { throw new Error("Tournament cancelled"); }, chat: async () => { throw new Error("Should not call provider"); } }), /Tournament cancelled/);
});

test("transport handles UTF-8 split across chunks and aborts without a partial response", async () => {
  const realFetch = globalThis.fetch;
  const content = '{"tone":["楽しい"]}';
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
    controller.close();
  } }));
  try {
    assert.equal((await omniChat({ model: "test", system: "JSON", user: "test" })).content, content);
    globalThis.fetch = async () => { throw new DOMException("Aborted", "AbortError"); };
    await assert.rejects(omniChat({ model: "test", system: "JSON", user: "test", signal: AbortSignal.abort() }), /Aborted/);
  } finally { globalThis.fetch = realFetch; }
});

test("complete tournament repairs brief, cluster membership and jury IDs without fabricated scores", async () => {
  const { createRun, getRun, getEvents } = await import("../src/lib/db");
  const { runTournament } = await import("../src/lib/tournament");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  let generations = 0, briefCalls = 0, filterCalls = 0, juryCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt: string = body.messages[1].content;
    const schema = JSON.parse(body.messages[0].content.split("JSON Schema:\n")[1]);
    assert.equal(body.stream, false);
    let output: unknown;
    if (schema.properties.goal) {
      output = briefCalls++ ? brief : { ...brief, tone: "funny", constraints: "24 hours", avoid: "assistants", priorities: "demo", assumptions: "none" };
    } else if (schema.properties.ideas) {
      assert.doesNotMatch(prompt, /Opponent:|I11/);
      generations++;
      output = { ideas: [1, 2, 3].map(index => ({ ...idea, title: `Concept ${generations}-${index}` })) };
    } else if (schema.properties.clusters) {
      const ids = [1, 2, 3, 4].flatMap(slot => [1, 2, 3].map(index => `I${slot}${index}`));
      output = { clusters: (filterCalls++ ? ids : ids.slice(1)).map(id => ({ ids: [id], representativeId: id, reason: "Different mechanism", scores })) };
    } else if (schema.properties.changes) {
      output = { ...idea, changes: ["Use fixed lighting"], rationale: "Addresses tracking risk", unresolvedRisks: ["Camera calibration"] };
    } else if (schema.properties.scores) {
      assert.doesNotMatch(prompt, /generatorSlot|generatorModel|modelAttribution|fixture|I11M|anonymousId/);
      const ids = Array.from({ length: 6 }, (_, index) => `F${index + 1}`);
      output = { scores: (juryCalls++ ? ids : ids.slice(1)).map(ideaId => ({ ideaId, ...scores, rationale: "Fits the brief with a simple demo." })) };
    } else output = { text: "Tracking could fail under poor lighting. Use a fixed camera and a controlled background." };
    const content = JSON.stringify(output);
    // All stages exercise the real transport adapter with SSE despite stream:false.
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }], model: "fixture" })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  try {
    createRun("integration", "Find a funny hackathon idea for 24 hours", "hackathon", { ...DEFAULT_SETTINGS, noveltySearch: false });
    await runTournament("integration");
    const run = getRun("integration")!;
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.result!.initialCandidates.length, 12);
    assert.equal(run.result!.finalists.length, 6);
    assert.equal(run.result!.eliminated.length, 6);
    assert.equal(run.result!.winner!.finalScore, 83);
    assert.ok(run.result!.initialCandidates.every(candidate => candidate.generatorModel === "fixture"));
    assert.ok(run.result!.finalists.every(candidate => candidate.modelAttribution === "fixture" && candidate.debate?.models?.opening === "fixture" && candidate.judgeScores.every(score => score.model === "fixture")));
    assert.ok(getEvents("integration").some(event => event.message.includes("requested auto; gateway reported fixture")));
    const messages = getEvents("integration").filter(event => event.kind === "message").map(event => JSON.parse(event.message));
    assert.ok(messages.some(message => message.role.includes("opening") && message.role.includes("→") && message.content.text));
    assert.ok(messages.some(message => message.role.includes("rebuttal") && message.model === "fixture"));
    assert.ok(messages.some(message => message.role.includes("pair critique") && message.content.text));
    for (const finalist of run.result!.finalists) { assert.equal(finalist.judgeScores.length, 3); assert.ok(finalist.mutation); assert.ok(finalist.debate?.rebuttal); }
    assert.equal(briefCalls, 2); assert.equal(filterCalls, 2); assert.equal(juryCalls, 4);
    assert.equal(getEvents("integration").filter(event => event.kind === "warning" && event.message.startsWith("Repairing")).length, 3);
  } finally { globalThis.fetch = realFetch; }
});
