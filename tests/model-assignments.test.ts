import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAutoModels } from "../src/lib/model-assignments";
import { DEFAULT_SETTINGS } from "../src/lib/types";

test("Auto resolves only available models while preserving manual assignments and defaults", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.models.critic = "provider/b";
  const result = resolveAutoModels(settings, ["provider/a", "provider/b"]);
  const assigned = Object.values(result.models).flat();
  assert.ok(Math.abs(assigned.filter(model => model === "provider/a").length - assigned.filter(model => model === "provider/b").length) <= 1);
  assert.equal(result.models.critic, "provider/b");
  assert.equal(settings.models.analyzer, "auto");
  assert.ok(Object.values(result.models).flat().every(model => model !== "auto"));
  assert.throws(() => resolveAutoModels(settings, []), /No available/);
  assert.throws(() => resolveAutoModels(settings, ["provider/a"]), /no longer available/);
});

test("Auto spreads generators and jury across providers despite an alphabetically dominant catalog", () => {
  const available = [
    ...Array.from({ length: 20 }, (_, index) => `antigravity/model-${index}`),
    ...["groq", "huggingface", "kimi", "nvidia", "opencode", "openrouter"].map(provider => `${provider}/model`),
  ];
  const result = resolveAutoModels(DEFAULT_SETTINGS, available);
  const competing = [...result.models.generators, ...result.models.jury];
  assert.equal(new Set(competing.map(model => model.split("/")[0])).size, 7);
  const counts = Object.values(result.models).flat().reduce<Record<string, number>>((counts, model) => {
    const provider = model.split("/")[0]; counts[provider] = (counts[provider] || 0) + 1; return counts;
  }, {});
  assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1);
  assert.deepEqual(resolveAutoModels(DEFAULT_SETTINGS, [...available].reverse()), result);
});

test("Auto accounts for manual provider choices and handles a single available model", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.models.generators[0] = "a/manual";
  settings.models.critic = "a/manual";
  const result = resolveAutoModels(settings, ["a/manual", "a/other", "b/model", "c/model"]);
  assert.equal(result.models.generators[0], "a/manual");
  assert.equal(result.models.generators[1], "b/model");
  assert.equal(result.models.generators[2], "c/model");
  assert.equal(result.models.critic, "a/manual");
  assert.ok(Object.values(resolveAutoModels(DEFAULT_SETTINGS, ["only/model"]).models).flat().every(model => model === "only/model"));
});

test("Auto excludes known non-conversation model families", () => {
  const result = resolveAutoModels(DEFAULT_SETTINGS, ["groq/whisper-large-v3", "groq/canopylabs/orpheus-arabic-saudi", "nvidia/embed-v2", "provider/chat"]);
  assert.ok(Object.values(result.models).flat().every(model => model === "provider/chat"));
});

test("sampleDistinctChatModels picks unique models across providers and respects exclusion sets", async () => {
  const { sampleDistinctChatModels } = await import("../src/lib/model-assignments");
  const catalog = [
    "antigravity/gemini-flash",
    "antigravity/gemini-pro",
    "groq/llama-3",
    "groq/qwen-2.5",
    "nvidia/mistral-large",
    "openrouter/deepseek-v3",
    "groq/whisper-large-v3", // should be excluded
  ];
  const picked = sampleDistinctChatModels(catalog, 4);
  assert.equal(picked.length, 4);
  assert.equal(new Set(picked).size, 4);
  assert.ok(!picked.includes("groq/whisper-large-v3"));

  // Verify exclusion
  const exclude = new Set([picked[0], picked[1]]);
  const nextPicked = sampleDistinctChatModels(catalog, 3, exclude);
  assert.equal(nextPicked.length, 3);
  assert.ok(!nextPicked.includes(picked[0]));
  assert.ok(!nextPicked.includes(picked[1]));
});

