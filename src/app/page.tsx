"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Preset, Run, RunEvent, RunSettings } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { ExplorationPanel } from "./agent-panel";
import type { ExplorationState } from "@/lib/agent-types";

const presets: { id: Preset; title: string }[] = [
  { id: "general", title: "General" }, { id: "hackathon", title: "Hackathon" }, { id: "startup", title: "Startup" }, { id: "creative", title: "Creative" }, { id: "personal", title: "Personal" },
];
const participants = ["Sam", "Alex", "Robin", "Kai"];

function cloneSettings(): RunSettings { return { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RunSettings, noveltySearch: false }; }
function participantName(message: ChatMessage) { return message.agent || (message.participant === undefined ? "Participant" : participants[message.participant] || "Participant"); }
function messageFromEvent(event: RunEvent): ChatMessage | undefined {
  if (event.kind !== "message") return undefined;
  try { const value = JSON.parse(event.message) as ChatMessage; return typeof value.content === "string" && ["user", "assistant", "system"].includes(value.role) ? value : undefined; } catch { return undefined; }
}
function runTitle(run: Run) { return run.mode === "chat" ? run.prompt : run.result?.winner?.title || run.prompt; }

export default function Home() {
  const [prompt, setPrompt] = useState("Find a funny, technically doable hackathon project for a three-person team with 24 hours.");
  const [draft, setDraft] = useState("");
  const [preset, setPreset] = useState<Preset>("hackathon");
  const [continuous, setContinuous] = useState(false);
  const [settings, setSettings] = useState<RunSettings>(cloneSettings);
  const [run, setRun] = useState<Run | null>(null);
  const [exploration, setExploration] = useState<ExplorationState | undefined>();
  const [recoverable, setRecoverable] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [history, setHistory] = useState<Run[]>([]);
  const [catalog, setCatalog] = useState<{ id: string; access: string }[]>([]);
  const [gateway, setGateway] = useState<{ connected: boolean; count?: number; error?: string }>({ connected: false });
  const [showModels, setShowModels] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const selectedRunId = useRef<string | null>(null);
  const lastEventId = useRef(0);

  const loadGateway = useCallback(async () => {
    try { const response = await fetch("/api/models", { cache: "no-store" }); const data = await response.json(); setGateway({ connected: data.connected, count: data.models?.length, error: data.error }); setCatalog(data.connected ? data.models || [] : []); }
    catch { setGateway({ connected: false, error: "Could not reach the app server." }); setCatalog([]); }
  }, []);
  const loadHistory = useCallback(async () => {
    try { const response = await fetch("/api/runs", { cache: "no-store" }); if (!response.ok) throw new Error(); setHistory((await response.json()).runs); }
    catch { setError("Could not load saved conversations."); }
  }, []);
  const openRun = useCallback(async (id: string) => {
    try { const response = await fetch(`/api/runs/${id}`, { cache: "no-store" }); if (!response.ok) throw new Error("Could not open this saved conversation."); const data = await response.json(); selectedRunId.current = id; lastEventId.current = data.events.at(-1)?.id || 0; setRun(data.run); setEvents(data.events); setExploration(data.exploration); setRecoverable(Boolean(data.recoverable)); setError(""); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Could not open the conversation."); }
  }, []);

  useEffect(() => { const initial = window.setTimeout(() => { void loadGateway(); void loadHistory(); }, 0); const refresh = window.setInterval(() => { void loadGateway(); void loadHistory(); }, 15_000); return () => { window.clearTimeout(initial); window.clearInterval(refresh); }; }, [loadGateway, loadHistory]);
  useEffect(() => {
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return;
    const id = run.id; const source = new EventSource(`/api/runs/${id}/events?after=${lastEventId.current}`);
    source.addEventListener("run", event => { try { const item = JSON.parse((event as MessageEvent).data) as RunEvent; if (selectedRunId.current !== id) return; lastEventId.current = item.id; setEvents(current => current.some(value => value.id === item.id) ? current : [...current, item]); } catch { setError("The live conversation stream returned invalid data."); } });
    const poll = window.setInterval(() => void openRun(id), 1_500);
    return () => { source.close(); window.clearInterval(poll); };
  }, [openRun, run]);

  async function startConversation() {
    setError(""); setLoading(true);
    try { const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, preset, settings: { ...settings, continuous, noveltySearch: false } }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not start the group chat."); await openRun(data.run.id); void loadHistory(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Could not start the group chat."); } finally { setLoading(false); }
  }
  async function sendMessage() {
    if (!run || !draft.trim()) return;
    setError(""); setLoading(true);
    try { const response = await fetch(`/api/runs/${run.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: draft }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not send your message."); setDraft(""); await openRun(run.id); void loadHistory(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Could not send your message."); } finally { setLoading(false); }
  }
  async function resumeChat(resume = false) {
    if (!run) return;
    setError(""); setLoading(true);
    try { const response = await fetch(`/api/runs/${run.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: run.settings.workflow === "exploration-v1" ? "Explore more distinct experimental directions." : "Continue the conversation: respond to each other and build on the most promising ideas.", resume }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not continue discussion."); await openRun(run.id); void loadHistory(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Could not continue discussion."); } finally { setLoading(false); }
  }
  async function stop() { if (!run) return; try { const response = await fetch(`/api/runs/${run.id}`, { method: "DELETE" }); if (!response.ok) throw new Error(); await openRun(run.id); } catch { setError("Could not stop this round."); } }

  const messages = events.map(messageFromEvent).filter((message): message is ChatMessage => Boolean(message));
  const legacyMessages = events.filter(event => event.kind === "message" && !messageFromEvent(event));
  const isExploration = run?.settings.workflow === "exploration-v1";
  const isSavedReport = Boolean(run && run.mode !== "chat");
  const active = Boolean(run && ["queued", "running"].includes(run.status));
  const canStart = gateway.connected && catalog.length > 0 && !loading;

  return <main>
    <nav><a className="brand" href="#top">IdeaArena</a><div className="nav-right"><span className={`gateway ${gateway.connected ? "online" : "offline"}`}>{gateway.connected ? `${gateway.count || 0} available models` : "Gateway unavailable"}</span><button className="text-button" onClick={() => void loadGateway()}>Refresh</button></div></nav>
    <div className="page" id="top">
      <header className="intro"><span className="kicker">Local AI discussion</span><h1>Talk an idea into shape.</h1><p>Bring an idea to four friends. They pitch, argue about what is best, vote, and start over when nobody agrees. There are no roles and no script. Jump in whenever you have a thought.</p></header>
      <section className="new-chat" aria-label="Start a project discussion"><div className="new-chat-main"><label htmlFor="project">What are you thinking about?</label><textarea id="project" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={15000} /><div className="preset-row">{presets.map(item => <button type="button" className={`preset ${preset === item.id ? "active" : ""}`} onClick={() => setPreset(item.id)} key={item.id}>{item.title}</button>)}</div></div><aside className="start-side"><label className="toggle-label"><input type="checkbox" checked={continuous} onChange={event => setContinuous(event.target.checked)} /><span>Continuous discussion</span></label><p>{continuous ? "The group keeps talking for a second round, then pauses for you." : "Four participants exchange ideas, then pause for your reply."}</p><button type="button" className="secondary wide" onClick={() => setShowModels(value => !value)}>{showModels ? "Hide participants" : "Choose participants"}</button><button type="button" className="primary wide" disabled={!canStart} onClick={() => void startConversation()}>{loading ? "Starting…" : "Start group chat"}</button></aside></section>
      {showModels && <section className="model-panel" aria-label="New chat participants"><div><h2>Four voices, one conversation</h2><p>Choose a model for each voice in your next chat. The names are just seats so you know who is talking. Auto only uses free-quota models and never auto-picks a billed OpenAI model. No external search is performed.</p></div><div className="model-grid">{participants.map((participant, index) => <label key={participant}>{participant}<select value={settings.models.generators[index] || "auto"} onChange={event => setSettings(current => ({ ...current, models: { ...current.models, generators: participants.map((_, slot) => slot === index ? event.target.value : current.models.generators[slot] || "auto") } }))}><option value="auto">Auto</option>{catalog.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}</select></label>)}</div></section>}
      {error && <section className="inline-error" role="alert"><b>Attention</b><span>{error}</span></section>}
      <section className="workspace">
        <aside className="history-panel"><div className="panel-title"><h2>Saved</h2><button className="text-button" onClick={() => void loadHistory()}>Refresh</button></div><div className="history-list">{history.map(item => <button key={item.id} aria-pressed={run?.id === item.id} onClick={() => void openRun(item.id)}><b>{runTitle(item)}</b><span>{item.settings.workflow === "exploration-v1" ? "Exploration" : item.mode === "chat" ? "Group chat" : "Tournament"} · {new Date(item.createdAt).toLocaleDateString()} · {item.status}</span></button>)}{!history.length && <p className="quiet">Your conversations stay here.</p>}</div></aside>
        <section className="conversation" aria-live="polite"><header className="conversation-head"><div><span className="kicker">{isSavedReport ? "Saved tournament" : isExploration ? "Saved exploration" : "Group chat"}</span><h2>{active && <span className="live-pulse" />}{run ? (active ? run.stage : run.status === "failed" ? "Needs attention" : run.status === "cancelled" ? "Stopped" : "Ready for your next thought") : "What should the group explore?"}</h2><p>{isSavedReport ? "This older run is preserved as a read-only record." : isExploration ? "This saved exploration keeps its shortlist and review history. Start a new chat for a four-participant conversation." : active ? "The group is talking it through. Add a thought or steer the conversation anytime." : "Reply to an idea, question an assumption, or let the group keep talking."}</p></div><div className="conversation-actions">{active ? <button type="button" className="danger" onClick={() => void stop()}>Stop</button> : run?.mode === "chat" ? <button type="button" className="secondary" disabled={loading} onClick={() => void resumeChat()}>{loading ? "Continuing…" : isExploration ? "Continue exploration" : "Keep talking"}</button> : null}</div></header>
          {recoverable && <button className="secondary" disabled={loading} onClick={() => void resumeChat(true)}>Resume interrupted exploration</button>}
          {exploration && run && <ExplorationPanel state={exploration} runId={run.id} active={active} reload={() => void openRun(run.id)} />}
          {run && <details className="agent-activity" open={isExploration && active}><summary>{isExploration ? "Agent activity and review decisions" : "Connection and activity details"}</summary>{events.filter(e => ["progress", "warning", "error"].includes(e.kind)).map(e => <p key={e.id}>{e.stage}: {e.message}</p>)}</details>}
          <div className="chat-feed" role="log">{messages.map((message, index) => <article className={`chat-message ${message.role === "user" ? "user-message" : ""}`} key={`${message.round}-${index}`}><header>{message.role === "user" ? <b>You</b> : message.role === "system" ? <b>Conversation update</b> : <><b>{participantName(message)}</b>{message.model && <span className="model-tag" title={message.model}>{message.model}</span>}</>}<time>{message.round ? `Round ${message.round}` : ""}</time></header>{message.detail && (isExploration || isSavedReport) ? <details><summary>View agent output</summary><pre className="agent-output">{message.content}</pre></details> : <p>{message.content}</p>}</article>)}{legacyMessages.map(event => <article className="chat-message" key={event.id}><header><b>Saved response</b><span>Legacy tournament</span></header><p>{event.message}</p></article>)}{active && !isExploration && !isSavedReport && <p className="quiet" role="status">{messages.some(message => message.role === "assistant") ? "The group is thinking about what to say next…" : "The group is reading your brief…"}</p>}{!run && <div className="empty"><div className="empty-mark">↗</div><div><h2>A thought is enough to start.</h2><p>Sam, Alex, Robin and Kai talk it out like friends: they pitch, argue, vote on the strongest idea, and start over when nobody agrees. Watch them respond to each other, then add your own. This chat does not use external search.</p></div></div>}{isSavedReport && run?.result && <article className="legacy-summary"><b>{run.result.winner ? `Winner: ${run.result.winner.title}` : "Saved tournament"}</b><p>{run.result.winner?.oneLiner || "Open this record to review its stored messages."}</p></article>}</div>
          {run?.mode === "chat" && <form className="reply-box" onSubmit={event => { event.preventDefault(); void sendMessage(); }}><textarea aria-label="Message to the group" value={draft} onChange={event => setDraft(event.target.value)} placeholder={active ? "Jump in with a thought…" : "Reply to the group…"} maxLength={15000} /><button className="primary" disabled={loading || !draft.trim()}>{loading ? "Sending…" : "Send to group"}</button></form>}
        </section>
      </section>
    </div>
    <footer>IdeaArena stores this history locally. Provider prompts leave your device only through the gateway you configure.</footer>
  </main>;
}
