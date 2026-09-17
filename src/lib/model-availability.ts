import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

type Connection = { id: string; provider: string; is_active: number; test_status: string; rate_limited_until: string | null; is_configured?: number; has_key?: number };
type Quota = { remainingPercentage?: number; unlimited?: boolean; resetAt?: string };
type Limits = { fetchedAt?: string; quotas?: Record<string, Quota> };
export type AvailabilitySnapshot = { connections: Connection[]; synced: Record<string, { id: string }[]>; limits: Record<string, Limits> };

// Only metadata is read. Never load credentials or modify the gateway database.
export function localAvailability(): AvailabilitySnapshot {
  const db = new Database(process.env.OMNIROUTE_DATABASE_PATH || join(homedir(), ".omniroute", "storage.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const connections = db.prepare("SELECT id, provider, is_active, test_status, rate_limited_until, (api_key IS NOT NULL OR access_token IS NOT NULL) as has_key, (api_key IS NOT NULL OR access_token IS NOT NULL OR provider = 'opencode' OR auth_type = 'noauth') as is_configured FROM provider_connections").all() as Connection[];
    const read = (namespace: string) => Object.fromEntries((db.prepare("SELECT key, value FROM key_value WHERE namespace = ?").all(namespace) as { key: string; value: string }[]).map(row => [row.key, JSON.parse(row.value)]));
    return { connections, synced: read("syncedAvailableModels"), limits: read("providerLimitsCache") };
  } finally { db.close(); }
}

const BROKEN_OPENCODE_MODELS = new Set([
  "deepseek-v4-flash-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "ling-3.0-flash-fin-free",
]);

export function filterAvailableModels(catalog: { id: string }[], snapshot: AvailabilitySnapshot, now = Date.now()): { id: string; access: string }[] {
  const allowed = new Map<string, string>();
  for (const connection of snapshot.connections) {
    if (!connection.is_active || !["active", "success", "healthy"].includes(connection.test_status)) continue;
    if (connection.is_configured === 0) continue;
    if (connection.rate_limited_until && Date.parse(connection.rate_limited_until) > now) continue;
    const limits = snapshot.limits[connection.id];
    const synced = snapshot.synced[`${connection.provider}:${connection.id}`];
    // Some connected providers (such as Kimi) do not implement account model sync.
    // Their gateway catalog is the available discovery source.
    if (connection.provider !== "antigravity" && !synced) {
      for (const model of catalog) {
        if (model.id.startsWith(`${connection.provider}/`)) {
          if (connection.provider === "opencode" && !connection.has_key) {
            const bare = model.id.slice("opencode/".length);
            if (!bare.endsWith("-free") && bare !== "big-pickle") continue;
            if (BROKEN_OPENCODE_MODELS.has(bare)) continue;
          }
          allowed.set(model.id, "Connected provider");
        }
      }
    }
    // Account-reported model quotas are stronger evidence than the static registry.
    if (connection.provider === "antigravity" && limits?.quotas) {
      for (const [id, quota] of Object.entries(limits.quotas)) {
        const isReset = Boolean(quota.resetAt && Date.parse(quota.resetAt) <= now);
        if (quota.unlimited || (quota.remainingPercentage ?? 0) > 0 || isReset) {
          allowed.set(`antigravity/${id}`, "Account quota available");
        }
      }
    }
    // Use each account's synced model list, without any pricing restriction.
    for (const model of synced || []) {
      if (connection.provider === "antigravity") continue;
      // OpenCode unauthenticated free tier only serves free-tier models (big-pickle and *-free)
      if (connection.provider === "opencode" && !connection.has_key) {
        if (!model.id.endsWith("-free") && model.id !== "big-pickle") continue;
        if (BROKEN_OPENCODE_MODELS.has(model.id)) continue;
      }
      const quota = limits?.quotas?.[model.id];
      if (quota && !quota.unlimited && (quota.remainingPercentage ?? 0) <= 0) continue;
      allowed.set(`${connection.provider}/${model.id}`, "Account-listed model");
    }
  }
  return [...new Set(catalog.map(model => model.id))].filter(id => allowed.has(id)).sort().map(id => ({ id, access: allowed.get(id)! }));
}
