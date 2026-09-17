import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunEvent, RunSettings, RunStatus, TournamentResult } from "./types";
import type { ExplorationState, TasteFeedback } from "./agent-types";

const directory = process.env.IDEAARENA_DATA_DIR || join(process.cwd(), "data");
mkdirSync(directory, { recursive: true });

const globalDb = globalThis as unknown as { ideaarenaDb?: Database.Database };
const db = globalDb.ideaarenaDb ?? new Database(join(directory, "ideaarena.db"));
globalDb.ideaarenaDb = db;

db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS exploration_state (run_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS execution_leases (run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS taste_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, concept_id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, concept_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    preset TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    stage TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_run_id_id ON events(run_id, id);
`);

// Existing local databases predate the chat workflow. SQLite migrations are
// deliberately additive so historical tournament reports remain readable.
const columns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
if (!columns.some(column => column.name === "mode")) db.exec("ALTER TABLE runs ADD COLUMN mode TEXT");

type DbRun = {
  id: string; prompt: string; preset: Run["preset"]; settings_json: string; status: RunStatus;
  stage: string; result_json: string | null; error: string | null; created_at: string; updated_at: string; mode?: Run["mode"] | null;
};

function mapRun(row: DbRun): Run {
  return {
    id: row.id,
    prompt: row.prompt,
    preset: row.preset,
    settings: JSON.parse(row.settings_json) as RunSettings,
    status: row.status,
    stage: row.stage,
    result: row.result_json ? JSON.parse(row.result_json) as TournamentResult : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mode: row.mode ?? "tournament",
  };
}

export function createRun(id: string, prompt: string, preset: Run["preset"], settings: RunSettings, mode: Run["mode"] = "tournament"): Run {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO runs (id,prompt,preset,settings_json,status,stage,mode,created_at,updated_at)
    VALUES (@id,@prompt,@preset,@settings,'queued','Queued',@mode,@now,@now)`).run({
    id, prompt, preset, settings: JSON.stringify(settings), mode, now,
  });
  appendEvent(id, "status", mode === "chat" ? "Group chat queued" : "Tournament queued", "Queued");
  return getRun(id)!;
}

export function getRun(id: string): Run | undefined {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRun | undefined;
  return row ? mapRun(row) : undefined;
}

export function listRuns(): Run[] {
  return (db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as DbRun[]).map(mapRun);
}

export function updateRun(id: string, update: Partial<Pick<Run, "status" | "stage" | "result" | "error">>): void {
  const current = getRun(id);
  if (!current) return;
  const now = new Date().toISOString();
  db.prepare(`UPDATE runs SET status=@status, stage=@stage, result_json=@result, error=@error, updated_at=@now WHERE id=@id`).run({
    id,
    status: update.status ?? current.status,
    stage: update.stage ?? current.stage,
    result: update.result ? JSON.stringify(update.result) : current.result ? JSON.stringify(current.result) : null,
    error: update.error ?? current.error ?? null,
    now,
  });
}

export function appendEvent(runId: string, kind: RunEvent["kind"], message: string, stage?: string): RunEvent {
  const createdAt = new Date().toISOString();
  const info = db.prepare("INSERT INTO events (run_id,kind,message,stage,created_at) VALUES (?,?,?,?,?)")
    .run(runId, kind, message, stage ?? null, createdAt);
  return { id: Number(info.lastInsertRowid), runId, kind, message, stage, createdAt };
}

export function getEvents(runId: string, after = 0): RunEvent[] {
  type DbEvent = { id: number; run_id: string; kind: RunEvent["kind"]; message: string; stage: string | null; created_at: string };
  return (db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC").all(runId, after) as DbEvent[]).map((row) => ({
    id: row.id, runId: row.run_id, kind: row.kind, message: row.message, stage: row.stage ?? undefined, createdAt: row.created_at,
  }));
}

export function getExploration(runId: string): ExplorationState | undefined {
  const row = db.prepare("SELECT state_json FROM exploration_state WHERE run_id = ?").get(runId) as { state_json: string } | undefined;
  return row ? JSON.parse(row.state_json) : undefined;
}
export function saveExploration(runId: string, state: ExplorationState): void {
  db.prepare("INSERT INTO exploration_state VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET state_json=excluded.state_json").run(runId, JSON.stringify(state));
}
export function acquireLease(runId: string, owner: string): boolean {
  return db.prepare("INSERT INTO execution_leases VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE execution_leases.expires < ?")
    .run(runId, owner, Date.now() + 30_000, Date.now()).changes === 1;
}
export function renewLease(runId: string, owner: string): boolean {
  return db.prepare("UPDATE execution_leases SET expires=? WHERE run_id=? AND owner=? AND expires>=?").run(Date.now() + 30_000, runId, owner, Date.now()).changes === 1;
}
export function releaseLease(runId: string, owner: string): void { db.prepare("DELETE FROM execution_leases WHERE run_id=? AND owner=?").run(runId, owner); }
export function hasLease(runId: string): boolean { return Boolean(db.prepare("SELECT 1 FROM execution_leases WHERE run_id=? AND expires>=?").get(runId, Date.now())); }
export function getTasteFeedback(): TasteFeedback[] {
  const rows = db.prepare("SELECT * FROM taste_feedback ORDER BY id DESC LIMIT 100").all() as { id: number; run_id: string; concept_id: string; kind: TasteFeedback["kind"]; reason: string; concept_json: string }[];
  return rows.map(row => ({ id: row.id, runId: row.run_id, conceptId: row.concept_id, kind: row.kind, reason: row.reason, concept: JSON.parse(row.concept_json) }));
}
export function addTasteFeedback(value: Omit<TasteFeedback, "id">): void { db.prepare("INSERT INTO taste_feedback (run_id,concept_id,kind,reason,concept_json) VALUES (?,?,?,?,?)").run(value.runId, value.conceptId, value.kind, value.reason, JSON.stringify(value.concept)); }
export function clearTasteFeedback(): void { db.prepare("DELETE FROM taste_feedback").run(); }
