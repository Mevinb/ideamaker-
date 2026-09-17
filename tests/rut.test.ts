import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.IDEAARENA_DATA_DIR = mkdtempSync(join(tmpdir(), "ideaarena-rut-tests-"));

test("empty history starts fresh without naming any territory", async () => {
  const { exhaustedTerritories } = await import("../src/lib/chat");
  assert.match(exhaustedTerritories("rut-fresh"), /start fresh/);
});

test("repeated prior ideas surface as abstract territories, never pasted pitches", async () => {
  const { createRun, appendEvent } = await import("../src/lib/db");
  const { exhaustedTerritories } = await import("../src/lib/chat");
  const { DEFAULT_SETTINGS } = await import("../src/lib/types");
  for (let i = 0; i < 4; i++) {
    const id = `rut-seed-${i}`;
    createRun(id, "A hackathon project please", "hackathon", DEFAULT_SETTINGS, "chat");
    appendEvent(id, "message", JSON.stringify({
      role: "assistant",
      agent: "Explorer",
      participant: 0,
      content: "Pitch: Codex Copilot for Pull Request Reviews. A developer pastes a GitHub pull request link and gets a senior code review with inline suggestions.",
      round: 1,
    }), "Round 1");
  }
  const territories = exhaustedTerritories("rut-check");
  assert.match(territories, /pull request/);
  assert.match(territories, /github pull/);
  assert.ok(!territories.includes("Codex Copilot for Pull Request Reviews"), "full prior pitches must not be fed back as examples");
  assert.ok(territories.length < 1000, "rut signal stays compact");
});
