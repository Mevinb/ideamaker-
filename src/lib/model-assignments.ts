import type { RunSettings } from "./types";

export const NON_CHAT_MODELS = /(?:whisper|orpheus|embed|rerank|moderation|guard|content-safety|lyria|tts|speech|flux|stable-diffusion|translate|parse|reward|clip|deplot|vision|audio|3\.5-flash|gemini-3-flash-agent|gpt-oss-120b|zamba|palmyra|deepseek-v4-pro-0813|glm-5\.2:free|mistralai\/mistral-large|deepseek-ai\/DeepSeek-V3|qwen\/qwen3\.[68]-27b|minimax.*:free|ling-3\.0-flash-fin-free|deepseek-v4-flash-0731|big-pickle|mimo-v2\.5-free)/i;

export function sampleDistinctChatModels(
  available: string[],
  count: number,
  exclude: Set<string> = new Set()
): string[] {
  const models = [...new Set(available)];
  const autoModels = models.filter(model => !NON_CHAT_MODELS.test(model));
  if (!autoModels.length) return [];

  const unused = autoModels.filter(m => !exclude.has(m));
  const pool = unused.length >= count ? unused : autoModels;

  const provider = (model: string) => model.split("/")[0];
  const byProvider = new Map<string, string[]>();
  for (const m of pool) {
    const p = provider(m);
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(m);
  }

  for (const list of byProvider.values()) {
    list.sort(() => Math.random() - 0.5);
  }

  const selected: string[] = [];
  const preferred = ["opencode", "antigravity", "openrouter", "nvidia", "huggingface", "groq"];
  const providers = [...byProvider.keys()].sort((a, b) => {
    const aPref = preferred.indexOf(a);
    const bPref = preferred.indexOf(b);
    if (aPref !== -1 && bPref !== -1) return aPref - bPref;
    if (aPref !== -1) return -1;
    if (bPref !== -1) return 1;
    return Math.random() - 0.5;
  });
  let pIdx = 0;
  while (selected.length < count && selected.length < pool.length) {
    const p = providers[pIdx % providers.length];
    const list = byProvider.get(p);
    if (list && list.length > 0) {
      const candidate = list.pop()!;
      if (!selected.includes(candidate)) {
        selected.push(candidate);
      }
    }
    pIdx++;
    if ([...byProvider.values()].every(l => l.length === 0)) break;
  }

  if (selected.length < count && pool.length > selected.length) {
    for (const m of pool) {
      if (!selected.includes(m)) {
        selected.push(m);
        if (selected.length >= count) break;
      }
    }
  }

  return selected;
}

export function resolveAutoModels(settings: RunSettings, available: string[], randomize = false): RunSettings {
  if (!available.length) throw new Error("No available models. Refresh the gateway connection and retry.");
  const next = structuredClone(settings);
  const models = [...new Set(available)].sort();
  let autoModels = models.filter(model => !NON_CHAT_MODELS.test(model));
  if (!autoModels.length && Object.values(settings.models).flat().includes("auto")) throw new Error("No text-generation models available for Auto.");
  if (randomize) {
    autoModels = [...autoModels].sort(() => Math.random() - 0.5);
  }
  const provider = (model: string) => model.split("/")[0];
  const providerUses = new Map<string, number>();
  const modelUses = new Map<string, number>();
  const record = (model: string) => {
    providerUses.set(provider(model), (providerUses.get(provider(model)) || 0) + 1);
    modelUses.set(model, (modelUses.get(model) || 0) + 1);
  };
  // Reserve manual choices first so Auto complements the user's assignments.
  for (const model of Object.values(settings.models).flat()) {
    if (model === "auto") continue;
    if (!models.includes(model)) throw new Error(`Model is no longer available: ${model}`);
    record(model);
  }
  const choose = (model: string) => {
    if (model !== "auto") return model;
    const selected = [...autoModels].sort((a, b) =>
      (providerUses.get(provider(a)) || 0) - (providerUses.get(provider(b)) || 0) ||
      (modelUses.get(a) || 0) - (modelUses.get(b) || 0) ||
      (randomize ? 0 : a.localeCompare(b))
    )[0];
    record(selected);
    return selected;
  };
  next.models.generators = next.models.generators.map(choose);
  next.models.jury = next.models.jury.map(choose);
  for (const role of ["analyzer", "filter", "critic", "mutation"] as const) next.models[role] = choose(next.models[role]);
  return next;
}

