import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { prose, requestStructured } from "../src/lib/structured";

test("long debate prose is preserved on the first attempt with a warning", async () => {
  const text = "A specific argument. ".repeat(150);
  let calls = 0;
  const warnings: string[] = [];
  const result = await requestStructured({ model: "fixture", stage: "opening", prompt: "Debate", schema: z.object({ text: prose(1200, 20) }), warning: message => warnings.push(message), chat: async () => { calls++; return { model: "fixture", content: JSON.stringify({ text }) }; } });
  assert.equal(result.text, text);
  assert.equal(calls, 1);
  assert.match(warnings[0], /full text preserved/);
});

test("prose targets do not relax type, minimum, safety ceiling, or scoring validation", () => {
  const schema = z.object({ text: prose(1200, 20), score: z.number().max(10) });
  for (const value of [{ text: 123, score: 8 }, { text: "short", score: 8 }, { text: "x".repeat(20001), score: 8 }, { text: "x".repeat(1500), score: 11 }]) assert.equal(schema.safeParse(value).success, false);
});
