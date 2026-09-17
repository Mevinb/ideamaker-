import { filterAvailableModels, localAvailability, type AvailabilitySnapshot } from "./model-availability";

type ChatOptions = { model: string; system: string; user: string; signal?: AbortSignal; json?: boolean; maxTokens?: number; temperature?: number };

type CompletionEnvelope = {
  choices?: { message?: { content?: string }; delta?: { content?: string }; finish_reason?: string | null }[];
  model?: string;
  error?: { message?: string };
};

const baseUrl = () => (process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");

export function parseJsonOrSse(raw: string): { content: string; model?: string } {
  const trimmed = raw.trim();
  if (!/^(?:data:|event:|id:|retry:|:)/m.test(trimmed)) {
    const data = JSON.parse(trimmed) as CompletionEnvelope;
    if (data.error?.message) throw new Error(data.error.message);
    if (["length", "content_filter"].includes(data.choices?.[0]?.finish_reason || "")) throw new Error("OmniRoute completion was truncated or filtered. No partial result was accepted.");
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OmniRoute returned no message content");
    return { content, model: data.model };
  }

  let content = "";
  let model: string | undefined;
  let sawDone = false;
  let finished = false;
  const events = trimmed.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") { sawDone = true; break; }
    const data = JSON.parse(payload) as CompletionEnvelope;
    if (data.error?.message) throw new Error(data.error.message);
    model ||= data.model;
    const choice = data.choices?.[0];
    if (["length", "content_filter"].includes(choice?.finish_reason || "")) throw new Error("OmniRoute completion was truncated or filtered. No partial result was accepted.");
    if (choice?.finish_reason === "stop") finished = true;
    content += choice?.delta?.content ?? choice?.message?.content ?? "";
  }
  if (!sawDone && !finished) throw new Error("OmniRoute stream ended before completion. No partial result was accepted.");
  if (!content) throw new Error("OmniRoute returned an empty completion");
  return { content, model };
}

const TEMPERATURE_REJECTED = /unsupported parameter.*temperature|temperature.*not supported/i;

export async function omniChat({ model, system, user, signal, json = false, maxTokens, temperature = 0.8 }: ChatOptions): Promise<{ content: string; model: string }> {
  const key = process.env.OMNIROUTE_API_KEY;
  const send = (omitTemperature: boolean) => fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      ...(omitTemperature ? {} : { temperature }),
      stream: false,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  let response = await send(false);
  if (!response.ok && response.status === 400) {
    // Newer reasoning models (e.g. openai/gpt-5.6-luna) reject the temperature
    // parameter outright. Retry the same model without it before giving up.
    const text = await response.text();
    if (TEMPERATURE_REJECTED.test(text)) response = await send(true);
    else throw new Error(`OmniRoute ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OmniRoute ${response.status}: ${text.slice(0, 300)}`);
  }
  const raw = await response.text();
  const parsed = parseJsonOrSse(raw);
  return { content: parsed.content, model: parsed.model || "Not reported by gateway" };
}

export async function availableModels(snapshot?: AvailabilitySnapshot): Promise<{ id: string; access: string }[]> {
  const key = process.env.OMNIROUTE_API_KEY;
  const response = await fetch(`${baseUrl()}/models`, {
    cache: "no-store",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Gateway responded ${response.status}`);
  const data = await response.json() as { data?: { id: string }[] };
  if (!Array.isArray(data.data)) throw new Error("Gateway returned an invalid model catalog");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl()).hostname)) throw new Error("Account availability requires the local OmniRoute gateway and its metadata database.");
  return filterAvailableModels(data.data.filter(item => typeof item?.id === "string" && item.id.trim()), snapshot || localAvailability());
}
