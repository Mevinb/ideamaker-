import assert from "node:assert/strict";
import { test } from "node:test";
import { withModelFailover } from "../src/lib/failover";

test("failed models are replaced without repeating completed steps or fabricating output", async () => {
  const calls: string[] = [];
  const result = await withModelFailover({ model: "a", alternatives: async () => ["a", "b", "c"], checkActive: () => {}, warning: () => {}, invoke: async model => { calls.push(model); if (model !== "c") throw new Error("Invalid response"); return { text: "Valid response" }; } });
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.equal(result.text, "Valid response");
});

test("cancellation prevents fallback and exhausted models fail honestly", async () => {
  let cancelled = false;
  await assert.rejects(withModelFailover({ model: "a", alternatives: async () => { throw new Error("Must not discover"); }, checkActive: () => { if (cancelled) throw new Error("Tournament cancelled"); }, warning: () => {}, invoke: async () => { cancelled = true; throw new Error("Request failed"); } }), /Tournament cancelled/);
  await assert.rejects(withModelFailover({ model: "a", alternatives: async () => [], checkActive: () => {}, warning: () => {}, invoke: async () => { throw new Error("Unavailable"); } }), /No available model completed/);
});
