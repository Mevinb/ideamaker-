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

test("Auto never assigns billed OpenAI models but preserves manual paid picks", async () => {
  const { isBilledOpenAIModel } = await import("../src/lib/model-assignments");
  for (const free of ["openai/gpt-5", "openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano", "openai/gpt-5.2", "openai/gpt-5.1", "openai/gpt-5-mini", "openai/gpt-5-nano", "openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano", "openai/gpt-4o", "openai/gpt-4o-mini", "openai/o1", "openai/o3", "openai/o3-mini", "openai/o4-mini", "openai/gpt-5-2025-08-07", "openai/gpt-4o-2024-08-06", "openai/o1-2024-12-17", "openai/o3-2025-04-16", "openai/gpt-4.1-mini-2025-04-14", "openai/gpt-5.4-mini-2026-03-17"]) {
    assert.equal(isBilledOpenAIModel(free), false, free);
  }
  for (const billed of ["openai/o1-pro", "openai/gpt-5-pro", "openai/gpt-5.5", "openai/gpt-3.5-turbo", "openai/gpt-5-chat-latest", "openai/gpt-5-codex", "openai/gpt-4o-transcribe", "openai/gpt-image-1", "openai/sora-2", "openai/gpt-4o-search-preview", "openai/davinci-002"]) {
    assert.equal(isBilledOpenAIModel(billed), true, billed);
  }
  assert.equal(isBilledOpenAIModel("groq/llama-3"), false);

  const available = ["openai/o1-pro", "openai/gpt-3.5-turbo", "openai/gpt-5.5", "openai/gpt-5", "openai/gpt-4o-mini", "openai/o3-2025-04-16", "groq/model-x"];
  const result = resolveAutoModels(DEFAULT_SETTINGS, available);
  for (const model of Object.values(result.models).flat()) assert.equal(isBilledOpenAIModel(model), false, model);

  const manual = structuredClone(DEFAULT_SETTINGS);
  manual.models.generators[0] = "openai/o1-pro";
  assert.equal(resolveAutoModels(manual, available).models.generators[0], "openai/o1-pro");
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

  // Billed OpenAI models are never auto-picked, even when present.
  const freePicked = sampleDistinctChatModels(["openai/o1-pro", "openai/gpt-5", "openai/gpt-4o-mini", "groq/model-x"], 3);
  assert.equal(freePicked.length, 3);
  assert.ok(!freePicked.includes("openai/o1-pro"));
});

