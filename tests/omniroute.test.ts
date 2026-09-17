import assert from "node:assert/strict";
import { test } from "node:test";
import { omniChat } from "../src/lib/omniroute";

test("models rejecting temperature are retried without it instead of failing", async () => {
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      return new Response("[400]: Unsupported parameter: 'temperature' is not supported with this model.", { status: 400 });
    }
    return Response.json({ model: "luna", choices: [{ message: { content: "Reply without temperature." } }] });
  }) as typeof fetch;
  try {
    const result = await omniChat({ model: "openai/gpt-5.6-luna", system: "s", user: "u" });
    assert.equal(result.content, "Reply without temperature.");
    assert.equal(bodies.length, 2);
    assert.ok(JSON.parse(bodies[0]).temperature === 0.8);
    assert.ok(!("temperature" in JSON.parse(bodies[1])));
  } finally { globalThis.fetch = realFetch; }
});

test("unrelated 400 errors still fail without a retry", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("Bad request: malformed messages", { status: 400 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => omniChat({ model: "m", system: "s", user: "u" }), /OmniRoute 400/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});
