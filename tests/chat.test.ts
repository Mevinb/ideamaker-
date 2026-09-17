import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.IDEAARENA_DATA_DIR = mkdtempSync(join(tmpdir(), "ideaarena-chat-tests-"));

test("a chat round feels like one shared group thread with six bounded replies", async () => {
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
    return Response.json({ model: "fixture", choices: [{ message: { content: `Concise reply ${replies}.` } }] });
  };
  try {
    createRun("chat-round", "A tiny camera game for a school event", "hackathon", DEFAULT_SETTINGS, "chat");
    assert.equal(addUserMessage("chat-round", "A tiny camera game for a school event").queued, false);
    await runChatRound("chat-round");
    const run = getRun("chat-round")!;
    assert.equal(run.status, "completed", run.error);
    const messages = getEvents("chat-round").filter(event => event.kind === "message").map(event => JSON.parse(event.message));
    assert.equal(replies, 6);
    assert.equal(messages.length, 7);
    const assistant = messages.filter(message => message.role === "assistant");
    assert.equal(assistant.length, 6);
    assert.ok(assistant.every(message => message.content.length < 600));
    assert.deepEqual(assistant.map(message => message.agent), ["Explorer", "Challenger", "Builder", "Connector", "Explorer", "Connector"]);
    assert.deepEqual(assistant.map(message => message.participant), [0, 1, 2, 3, 0, 3]);
    // Every turn sees the same shared thread, including the opening turn.
    assert.ok(prompts.every(prompt => prompt.includes("Group chat so far")));
    // Later turns can actually react to earlier speakers by name.
    assert.match(prompts[1], /Explorer:/);
    assert.match(prompts[2], /Explorer:/);
    assert.match(prompts[3], /Builder:/);
    // No isolated-pitch pipeline: nobody is hidden from the discussion.
    assert.ok(prompts.every(prompt => !prompt.includes("Do not assume another participant")));
    assert.ok(systems.every(system => /Talk like a real person/.test(system)));
    assert.ok(systems.every(system => /no bullet points/.test(system)));
    assert.ok(prompts.every(prompt => !prompt.includes("Concept Alpha")));
    assert.ok(prompts.every(prompt => !prompt.includes("exploration map")));
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
    return Response.json({ model: body.model, choices: [{ message: { content: "Distinct model idea." } }] });
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
    assert.equal(assistantMessages.length, 6);
    // The first 4 participants must all have distinct models
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
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    callCount++;
    if (callCount === 8) {
      updateRun("chat-continuous", { status: "cancelled" });
    }
    return Response.json({ model: "fixture", choices: [{ message: { content: `Continuous turn ${callCount}.` } }] });
  };
  try {
    createRun("chat-continuous", "A multi-agent game", "hackathon", { ...DEFAULT_SETTINGS, continuous: true }, "chat");
    addUserMessage("chat-continuous", "A multi-agent game");
    await runChatRound("chat-continuous");
    const run = getRun("chat-continuous")!;
    assert.equal(run.status, "cancelled");
    assert.ok(callCount >= 8);
    const events = getEvents("chat-continuous");
    assert.ok(events.some(e => e.stage?.includes("Round 1 complete")));
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
    return Response.json({ model: body.model, choices: [{ message: { content: `Reply via ${body.model}.` } }] });
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
    assert.equal(messages.filter(m => m.role === "assistant").length, 6);
    assert.ok(prompts.every(prompt => prompt.includes("Group chat so far")));
    const warnings = getEvents("chat-failover").filter(e => e.kind === "warning").map(e => e.message);
    assert.ok(warnings.some(w => w.includes("live model list was unreachable")));
    assert.ok(warnings.some(w => w.includes("used fallback model") && w.includes("failover-test/model-a")));
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
    return Response.json({ model: body.model, choices: [{ message: { content: `Recovered via ${body.model}.` } }] });
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
    assert.equal(messages.filter(m => m.role === "assistant").length, 6);
  } finally { globalThis.fetch = realFetch; }
});
