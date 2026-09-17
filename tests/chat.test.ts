import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.IDEAARENA_DATA_DIR = mkdtempSync(join(tmpdir(), "ideaarena-chat-tests-"));

const NAMES = ["Sam", "Alex", "Robin", "Kai"];

test("a chat round pitches openly, debates freely, then votes a winner", async () => {
  const { createRun, getEvents, getRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  let replies = 0;
  const prompts: string[] = [];
  const systems: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format, undefined);
    assert.equal(body.max_tokens, 400);
    assert.doesNotMatch(body.messages[0].content, /JSON Schema/);
    systems.push(body.messages[0].content);
    prompts.push(body.messages[1].content);
    replies++;
    const content = body.messages[1].content.includes("Cast your vote") ? "1 — strongest hook." : `Concise reply ${replies}.`;
    return Response.json({ model: "fixture", choices: [{ message: { content } }] });
  };
  try {
    createRun("chat-round", "A tiny camera game for a school event", "hackathon", DEFAULT_SETTINGS, "chat");
    assert.equal(addUserMessage("chat-round", "A tiny camera game for a school event").queued, false);
    await runChatRound("chat-round");
    const run = getRun("chat-round")!;
    assert.equal(run.status, "completed", run.error);
    const messages = getEvents("chat-round").filter(event => event.kind === "message").map(event => JSON.parse(event.message));
    // 4 pitches + 8 debate turns + 4 votes.
    assert.equal(replies, 16);
    const assistant = messages.filter(message => message.role === "assistant");
    assert.equal(assistant.length, 16);
    assert.ok(assistant.every(message => message.content.length < 600));
    // No roles: every seat speaks four times across pitches, debate, and votes.
    assert.deepEqual(assistant.map(message => message.agent).sort(), [...NAMES, ...NAMES, ...NAMES, ...NAMES].sort());
    for (const message of assistant) assert.equal(NAMES[message.participant], message.agent);
    // Every turn sees the same shared thread, including the opening turn.
    assert.ok(prompts.every(prompt => prompt.includes("Group chat so far")));
    // Votes carry a ballot of the pitches.
    assert.ok(prompts.filter(prompt => prompt.includes("Cast your vote")).every(prompt => prompt.includes("Ballot:")));
    // Later turns can actually react to earlier speakers by name.
    assert.match(prompts[4], /Sam:/);
    // Nobody is hidden from the discussion and nobody has a scripted role.
    assert.ok(systems.every(system => /Nobody has a role/.test(system)));
    assert.ok(systems.every(system => /Talk like a real person/.test(system)));
    assert.ok(prompts.every(prompt => !prompt.includes("Concept Alpha")));
    for (const role of ["Explorer", "Challenger", "Builder", "Connector"]) {
      assert.ok(prompts.every(prompt => !prompt.includes(role)), role);
    }
    // Consensus is announced, not reported.
    const updates = messages.filter(message => message.role === "system").map(message => message.content);
    assert.ok(updates.some(content => /settled on option 1/.test(content)));
  } finally { globalThis.fetch = realFetch; }
});

test("a split vote triggers fresh ideas and a second vote", async () => {
  const { createRun, getEvents, getRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  const prompts: string[] = [];
  let votes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    const body = JSON.parse(String(init?.body));
    prompts.push(body.messages[1].content);
    if (body.messages[1].content.includes("Cast your vote")) {
      votes++;
      // First ballot splits 1-2-3-4; the revote converges on option 2.
      return Response.json({ model: "fixture", choices: [{ message: { content: `${votes <= 4 ? votes : 2} — my pick.` } }] });
    }
    return Response.json({ model: "fixture", choices: [{ message: { content: "Debate point." } }] });
  };
  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      models: {
        ...DEFAULT_SETTINGS.models,
        generators: ["deadlock-test/model-a", "deadlock-test/model-b", "deadlock-test/model-c", "deadlock-test/model-d"],
      },
    };
    createRun("chat-deadlock", "A tiny camera game for a school event", "hackathon", settings, "chat");
    addUserMessage("chat-deadlock", "A tiny camera game for a school event");
    await runChatRound("chat-deadlock");
    const run = getRun("chat-deadlock")!;
    assert.equal(run.status, "completed", run.error);
    const messages = getEvents("chat-deadlock").filter(e => e.kind === "message").map(e => JSON.parse(e.message));
    // 16 first-cycle turns + 4 fresh pitches + 4 debate turns + 4 revotes.
    assert.equal(messages.filter(m => m.role === "assistant").length, 28);
    assert.ok(prompts.some(prompt => prompt.includes("brand-new idea")));
    const updates = messages.filter(m => m.role === "system").map(m => m.content);
    assert.ok(updates.some(content => /pitching a fresh idea/.test(content)));
    assert.ok(updates.some(content => /settled on option 2/.test(content)));
  } finally { globalThis.fetch = realFetch; }
});

test("chat rounds select distinct models for participants when catalog is available", async () => {
  const { createRun, getEvents, getRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  const modelsUsed: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) {
      return Response.json({
        data: [
          { id: "antigravity/model-a" },
          { id: "groq/model-b" },
          { id: "nvidia/model-c" },
          { id: "openrouter/model-d" },
        ],
      });
    }
    const body = JSON.parse(String(init?.body));
    modelsUsed.push(body.model);
    const content = body.messages[1].content.includes("Cast your vote") ? "1 — distinct and best." : "Distinct model idea.";
    return Response.json({ model: body.model, choices: [{ message: { content } }] });
  };
  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      models: {
        ...DEFAULT_SETTINGS.models,
        generators: ["antigravity/model-a", "groq/model-b", "nvidia/model-c", "openrouter/model-d"],
      },
    };
    createRun("chat-distinct", "A sensory music device", "hackathon", settings, "chat");
    addUserMessage("chat-distinct", "A sensory music device");
    await runChatRound("chat-distinct");
    const run = getRun("chat-distinct")!;
    assert.equal(run.status, "completed", run.error);
    const messages = getEvents("chat-distinct").filter(e => e.kind === "message").map(e => JSON.parse(e.message));
    const assistantMessages = messages.filter(m => m.role === "assistant");
    assert.equal(assistantMessages.length, 16);
    // The opening pitches must all have distinct models
    const participantModels = assistantMessages.slice(0, 4).map(m => m.model);
    assert.equal(new Set(participantModels).size, 4);
  } finally { globalThis.fetch = realFetch; }
});

test("continuous chat mode loops through rounds and halts on cancellation", async () => {
  const { createRun, getEvents, getRun, updateRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    callCount++;
    if (callCount === 8) {
      updateRun("chat-continuous", { status: "cancelled" });
    }
    const body = JSON.parse(String(init?.body));
    const content = body.messages[1].content.includes("Cast your vote") ? "1 — moving on." : `Continuous turn ${callCount}.`;
    return Response.json({ model: "fixture", choices: [{ message: { content } }] });
  };
  try {
    createRun("chat-continuous", "A multi-agent game", "hackathon", { ...DEFAULT_SETTINGS, continuous: true }, "chat");
    addUserMessage("chat-continuous", "A multi-agent game");
    await runChatRound("chat-continuous");
    const run = getRun("chat-continuous")!;
    assert.equal(run.status, "cancelled");
    assert.ok(callCount >= 8);
    const messages = getEvents("chat-continuous").filter(e => e.kind === "message").map(e => JSON.parse(e.message));
    assert.ok(messages.some(m => m.role === "assistant"));
  } finally { globalThis.fetch = realFetch; }
});

test("a speaker whose model 503s switches models instead of stopping the chat", async () => {
  const { createRun, getEvents, getRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (url, init) => {
    // The live catalog is unreachable exactly when failover matters most.
    if (String(url).endsWith("/models")) return new Response("gateway overloaded", { status: 503 });
    const body = JSON.parse(String(init?.body));
    prompts.push(body.messages[1].content);
    if (body.model === "failover-test/model-a") return new Response("worker limit reached", { status: 503 });
    const content = body.messages[1].content.includes("Cast your vote") ? "2 — best demo." : `Reply via ${body.model}.`;
    return Response.json({ model: body.model, choices: [{ message: { content } }] });
  };
  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      models: {
        ...DEFAULT_SETTINGS.models,
        generators: ["failover-test/model-a", "failover-test/model-b", "failover-test/model-c", "failover-test/model-d"],
      },
    };
    createRun("chat-failover", "A tiny camera game for a school event", "hackathon", settings, "chat");
    addUserMessage("chat-failover", "A tiny camera game for a school event");
    await runChatRound("chat-failover");
    const run = getRun("chat-failover")!;
    assert.equal(run.status, "completed", run.error);
    const messages = getEvents("chat-failover").filter(e => e.kind === "message").map(e => JSON.parse(e.message));
    assert.equal(messages.filter(m => m.role === "assistant").length, 16);
    assert.ok(prompts.every(prompt => prompt.includes("Group chat so far")));
    const warnings = getEvents("chat-failover").filter(e => e.kind === "warning").map(e => e.message);
    assert.ok(warnings.some(w => w.includes("live model list was unreachable")));
    assert.ok(warnings.some(w => w.includes("used fallback model") && w.includes("failover-test/model-a")));
  } finally { globalThis.fetch = realFetch; }
});

test("a model reporting a quota limit is parked with a clear warning while the chat continues", async () => {
  const { createRun, getEvents, getRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    const body = JSON.parse(String(init?.body));
    if (body.model === "quota-test/model-a") {
      return new Response('{"error":{"message":"429 insufficient_quota: daily allowance exhausted"}}', { status: 429 });
    }
    const content = body.messages[1].content.includes("Cast your vote") ? "2 — best demo." : `Reply via ${body.model}.`;
    return Response.json({ model: body.model, choices: [{ message: { content } }] });
  };
  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      models: {
        ...DEFAULT_SETTINGS.models,
        generators: ["quota-test/model-a", "quota-test/model-b", "quota-test/model-c", "quota-test/model-d"],
      },
    };
    createRun("chat-quota", "A tiny camera game for a school event", "hackathon", settings, "chat");
    addUserMessage("chat-quota", "A tiny camera game for a school event");
    await runChatRound("chat-quota");
    const run = getRun("chat-quota")!;
    assert.equal(run.status, "completed", run.error);
    const messages = getEvents("chat-quota").filter(e => e.kind === "message").map(e => JSON.parse(e.message));
    assert.equal(messages.filter(m => m.role === "assistant").length, 16);
    const warnings = getEvents("chat-quota").filter(e => e.kind === "warning").map(e => e.message);
    assert.ok(warnings.some(w => /quota or rate limit/.test(w) && w.includes("quota-test/model-a") && w.includes("won't be retried")));
  } finally { globalThis.fetch = realFetch; }
});

test("a total model outage fails honestly instead of hanging or masking the error", async () => {
  const { createRun, getEvents, getRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    return new Response("worker limit reached", { status: 503 });
  };
  try {
    createRun("chat-outage", "A tiny camera game for a school event", "hackathon", DEFAULT_SETTINGS, "chat");
    addUserMessage("chat-outage", "A tiny camera game for a school event");
    await runChatRound("chat-outage");
    const run = getRun("chat-outage")!;
    assert.equal(run.status, "failed");
    assert.match(run.error || "", /OmniRoute 503/);
    assert.doesNotMatch(run.error || "", /Group chat has stopped/);
    const messages = getEvents("chat-outage").filter(e => e.kind === "message").map(e => JSON.parse(e.message));
    assert.equal(messages.filter(m => m.role === "assistant").length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("keep talking after a failure retries with other models instead of stopping again", async () => {
  const { createRun, getEvents, getRun } = await import("../src/lib/db");
  const { addUserMessage, runChatRound } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  const realFetch = globalThis.fetch;
  let outage = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    if (outage) return new Response("worker limit reached", { status: 503 });
    const body = JSON.parse(String(init?.body));
    const content = body.messages[1].content.includes("Cast your vote") ? "1 — recovered pick." : `Recovered via ${body.model}.`;
    return Response.json({ model: body.model, choices: [{ message: { content } }] });
  };
  try {
    const settings = {
      ...DEFAULT_SETTINGS,
      models: {
        ...DEFAULT_SETTINGS.models,
        generators: ["retry-test/model-a", "retry-test/model-b", "retry-test/model-c", "retry-test/model-d"],
      },
    };
    createRun("chat-retry", "A tiny camera game for a school event", "hackathon", settings, "chat");
    addUserMessage("chat-retry", "A tiny camera game for a school event");
    await runChatRound("chat-retry");
    assert.equal(getRun("chat-retry")!.status, "failed");
    outage = false;
    addUserMessage("chat-retry", "Try again with whatever models are up.");
    await runChatRound("chat-retry");
    const run = getRun("chat-retry")!;
    assert.equal(run.status, "completed", run.error);
    assert.ok(!run.error);
    const messages = getEvents("chat-retry").filter(e => e.kind === "message").map(e => JSON.parse(e.message));
    // The failed round never completed, so the retry re-runs round 1.
    assert.equal(messages.filter(m => m.role === "assistant").length, 16);
  } finally { globalThis.fetch = realFetch; }
});
