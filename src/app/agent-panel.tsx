"use client";
import { useState } from "react";
import { AGENT_ROLES, type ExplorationState, type TasteFeedback } from "@/lib/agent-types";
import type { RunSettings } from "@/lib/types";

export function AgentModels({ settings, catalog, onChange }: { settings: RunSettings; catalog: { id: string }[]; onChange: (settings: RunSettings) => void }) {
  return <section className="model-panel"><h2>13 agents · wild and experimental</h2><p>Eight independent explorers, a coordinator, three reviewers, and an editor. Auto distributes roles across available providers.</p><div className="model-grid">{AGENT_ROLES.map(role => <label key={role}>{role}<select value={settings.agentModels?.[role] ?? "auto"} onChange={e => onChange({ ...settings, agentModels: { ...settings.agentModels, [role]: e.target.value } })}><option value="auto">Auto</option>{catalog.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select></label>)}</div></section>;
}

export function ExplorationPanel({ state, runId, active, reload }: { state: ExplorationState; runId: string; active: boolean; reload: () => void }) {
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function request(url: string, method: string, body?: object) {
    setBusy(true); setNotice("");
    try { const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Request failed"); setNotice("Saved."); reload(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  }
  const feedback = (conceptId: string, kind: TasteFeedback["kind"]) => request("/api/feedback", "POST", { runId, conceptId, kind, reason });
  return <section className="exploration-panel"><h2>{state.done ? "Your exploration shortlist" : "Exploration in progress"}</h2><p>{state.candidates.length} concepts recorded · {state.attempts}/96 model attempts · replacement cycle {state.cycle}/3</p>
    {!state.shortlist.length && <p>{state.done ? "No ideas met the quality gates. Add direction to explore again." : "The shortlist appears after originality, taste, and feasibility checks."}</p>}
    {state.shortlist.map(c => <article className="concept-option" key={c.id}><h3>{c.title}</h3><p>{c.problem}</p><dl>{([["Experience", c.interaction], ["Mechanism", c.mechanism], ["Output", c.output], ["Memorable moment", c.moment], ["Prototype", c.prototype], ["Uncertainties", c.uncertainties]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="concept-actions"><button disabled={busy} onClick={() => void feedback(c.id, "more")}>More like this</button><button disabled={busy} onClick={() => void feedback(c.id, "familiar")}>Too familiar</button><button disabled={busy} onClick={() => void feedback(c.id, "wrong")}>Wrong direction</button><button disabled={busy || active} onClick={() => void request(`/api/runs/${runId}/messages`, "POST", { content: `Develop ${c.title}. ${reason}`, selectedConceptId: c.id })}>Develop this idea</button></div></article>)}
    <label>Optional feedback reason<input value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} placeholder="What feels exciting, familiar, or wrong?" /></label><button className="text-button" disabled={busy} onClick={() => void request("/api/feedback", "DELETE")}>Clear saved taste preferences</button><p role="status">{notice}</p>
  </section>;
}
