import type { automationStatus, AutomationSettings } from "../src/automation-store.ts";
import type { WorkspaceHealth } from "../src/health.ts";
import type { ProjectView } from "../src/projects.ts";
import type { CandidateView, scanStatus } from "../src/scan.ts";
import type { digestStatus } from "../src/email.ts";
import type { GameState } from "../src/game.ts";
import { Conversation } from "./conversation.tsx";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DIM_LABEL, DIMS, QUESTIONS, TRACKS, type Dim } from "../src/dims.ts";
import { influence, stages, type Link, type LinkKind } from "../src/flow.ts";
import { applyTheme, readTheme, THEME_KEY, type Theme } from "./theme.ts";
import { AUTHORITY, KINDS, SLA_HOURS, type Directive, type Intervention, type Kind, type Lane } from "../src/lanes.ts";

// ---------------------------------------------------------------------------------------------- types & api

type Status = "open" | "doing" | "done" | "dropped";
type Track = keyof typeof TRACKS;
interface Step { text: string; done: boolean }
interface Reason { text: string; tone: "good" | "warn" | "info" }
interface Task {
  id: string; title: string; detail: string; owner: string | null; track: Track; status: Status;
  judge: string; judgeError: string | null; judgedAt: string | null; judgedBriefHash: string | null; forecastCapturedAt: string | null; createdAt: string; startedAt: string | null; doneAt: string | null;
  dims: Record<Dim, number[]> | null; doneWhen: string; steps: Step[]; lane: Lane; createdBy: string | null; projectId: string | null;
  teamAnswers: { dim: Dim; level: number; who: string | null; at: string }[];
}
interface Row { rank: number; door: string; pFirst: number; pTop: number; rankLo: number; rankHi: number; value: number; own: number; ei: number; level: Record<Dim, number>; ranks: Record<string, number>; flow: number; blockedBy: string[]; unlocks: string[]; boosts: string[] }
interface Edge { id: string; kind: LinkKind; title: string; status: Status }
type ListTask = Task & { row: Row; reasons: Reason[]; feeds: Edge[]; fedBy: Edge[]; directive: Directive; openInterventions: number; moat: { p: number; worthy: boolean } | null };
interface Activity { id: number; kind: string; taskId: string | null; taskTitle: string; who: string; at: string; result?: string | null; asset?: string | null }
type Need = Intervention & { taskTitle: string; taskLive?: boolean; directive?: Directive };
type Predicted = { effort: number; impact: number; defensibility: number; quality: number };
interface Voi { taskId: string; title: string; dim: Dim; prompt: string; levels: string[] }
interface State {
  health: WorkspaceHealth;
  automation: ReturnType<typeof automationStatus>;
  projects: ProjectView[];
  game: GameState;
  today: string; who: string; agreement: number; calibratedView: boolean; bold: string | null;
  list: ListTask[];
  lanes: Record<Lane, string[]>;
  interventions: { open: Need[]; recent: Need[] };
  agentLearning: { bias: Record<string, { dim: Dim; n: number; bias: number; applied: boolean }>; record: { n: number; rps: number; skill: number }; shrink: number;
    unreviewed: { taskId: string; title: string; who: string; result: string }[] };
  agentActivity: Activity[];
  agentUpdates: { since: string | null; items: Activity[] } | null;
  focus: { id: string; why: string } | null;
  questions: {
    debriefs: { taskId: string; title: string; predicted: Predicted }[];
    daily: null | { who: string; date: string; inProgress: { id: string; title: string }[]; followUps: { taskId: string; title: string; doneAt: string; predictedImpact: number }[]; voi: Voi[] };
    checkedToday: string[];
  };
  metrics: { name: string; goal: number; value: number | null; at: string | null; history: { value: number; at: string }[] }[];
  learning: {
    bias: Record<string, { dim: Dim; n: number; bias: number; raw: number; mae: number; applied: boolean }>;
    effort: { n: number; a: number; b: number; ratio: number }; temperature: { n: number; t: number }; record: { n: number; rps: number; skill: number };
    judge: { forecasts: number; models: string[]; prompts: number; orderDisagreement: number };
    outcomes: { result: string; n: number }[]; lessons: string[]; dataPoints: number };
  done: (Task & { debrief: null | Record<string, string | number | null>; followup: null | Record<string, string | number | null> })[];
  dropped: { id: string; title: string }[];
  links: Link[];
}

class SignedOut extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
  const write = method !== "GET";
  const res = await fetch(path, { method, credentials: "same-origin", headers: write ? { "content-type": "application/json" } : undefined, body: write ? JSON.stringify(body ?? {}) : undefined });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") throw new SignedOut();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

let TEAM: string[] = [];
let PROJECTS: { id: string; name: string; status: string }[] = [];
const projectName = (id: string | null) => (id && PROJECTS.find(p => p.id === id)?.name) || null;
const RESULTS = [["much-worse", "Much worse"], ["worse", "Worse"], ["as-expected", "As expected"], ["better", "Better"], ["much-better", "Much better"]] as const;
const FW_LABEL: Record<string, string> = { rice: "RICE", ice: "ICE", wsjf: "WSJF", leverage: "Leverage", eisenhower: "Eisenhower", moat: "Moat", craft: "Craft", flow: "Flow" };
const KIND_WORD: Record<LinkKind, string> = { unblocks: "unblocks", boosts: "boosts" };
const TRACK_SHORT: Record<string, string> = { revenue: "Revenue", data_loop: "Data loop", paid_access: "Paid access", trust: "Trust", ownership: "Ownership", distribution: "Distribution", quality: "Quality", other: "Other" };
const level = (x: number, d: Dim) => QUESTIONS[d].levels[Math.max(0, Math.min(4, Math.round(x)))];
const ago = (iso: string) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };
const expected = (p: number[]) => p.reduce((a, x, i) => a + x * i, 0);
type Notify = (msg: string) => void;

// ---------------------------------------------------------------------------------------------- primitives

function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const sync = (e: StorageEvent) => { if (e.key === THEME_KEY || e.key === null) { const next = readTheme(); setTheme(next); applyTheme(next); } };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  return <label className="theme-picker"><span className="caps muted">Theme</span>
    <select aria-label="Color theme" value={theme} onChange={(e) => {
      const next = e.target.value as Theme;
      setTheme(next); store.set(THEME_KEY, next); applyTheme(next);
    }}><option value="auto">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
  </label>;
}

function Levels({ dim, value, onChange, expect, levels }: { dim?: Dim; value: number | null; onChange: (v: number) => void; expect?: number; levels?: string[] }) {
  const ls = levels ?? QUESTIONS[dim!].levels;
  return (
    <div className="chips">
      {ls.map((l, i) => {
        const isExp = expect !== undefined && Math.round(expect) === i;
        return <button key={i} type="button" className={`chip ${value === i ? "on" : ""} ${isExp ? "expected" : ""}`} title={isExp ? "What Orion expected" : undefined} onClick={() => onChange(i)}>{l}</button>;
      })}
    </div>
  );
}
function Head({ n, title, right }: { n: string; title: string; right?: ReactNode }) {
  return <div className="sh"><span className="mono muted">{n}</span><h2>{title}</h2><div className="right">{right}</div></div>;
}
function Reasons({ rs }: { rs: Reason[] }) {
  return <>{rs.map((r) => <span key={r.text} className={`why ${r.tone}`}>{r.text}</span>)}</>;
}
function StepsProgress({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  const d = steps.filter((s) => s.done).length;
  return <span className="mono muted" title="Steps done">{d}/{steps.length}</span>;
}
/** A belief over five levels as five cells; darker = more likely. The expected level is outlined. */
function Belief({ p }: { p: number[] }) {
  const e = Math.round(expected(p));
  return <div className="seg">{p.map((x, i) => <i key={i} className={i === e ? "exp" : ""} style={{ opacity: 0.12 + 0.88 * Math.min(1, x * 1.6) }} />)}</div>;
}
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 120, h = 28, max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(" ");
  return <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

// ---------------------------------------------------------------------------------------------- steps

function Checklist({ t, refresh, editable = true }: { t: Task; refresh: () => void; editable?: boolean }) {
  const [steps, setSteps] = useState(t.steps);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setSteps(t.steps), [t.steps]);
  const save = async (next: Step[]) => {
    setSaving(true); setSteps(next);
    try { await api(`/api/tasks/${t.id}`, "PATCH", { steps: next }); refresh(); }
    catch (e) { setSteps(t.steps); throw e; }
    finally { setSaving(false); }
  };
  return (
    <div className="checklist">
      {steps.map((s, i) => (
        <label key={i} className={`check ${s.done ? "done" : ""}`}>
          <input type="checkbox" disabled={saving} checked={s.done} onChange={() => save(steps.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))} />
          <span>{s.text}</span>
        </label>
      ))}
      {editable && (
        <form className="addstep" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { save([...steps, { text: draft.trim(), done: false }]); setDraft(""); } }}>
          <input type="text" disabled={saving} placeholder="Add a step" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- today

function FocusCard({ t, why, refresh, notify }: { t: ListTask; why: string; refresh: () => void; notify: Notify }) {
  const act = async (status: Status) => {
    const r = await api(`/api/tasks/${t.id}`, "PATCH", { status });
    notify(status === "done" ? doneMessage(r.unlocked) : "Started. It's yours today.");
  };
  return (
    <div className="focus">
      <div className="caps">Your focus · {why}</div>
      <h3>{t.title}</h3>
      <div className="whys"><Reasons rs={t.reasons} /><span className="tag">{TRACK_SHORT[t.track]}</span></div>
      {t.doneWhen && <div className="donewhen"><span className="caps muted">Done when</span><p>{t.doneWhen}</p></div>}
      {t.steps.length > 0 && <Checklist t={t} refresh={refresh} editable={false} />}
      {t.feeds.filter((e) => e.status === "open" || e.status === "doing").length > 0 && (
        <div className="fuels"><span className="caps">This fuels</span>{t.feeds.filter((e) => e.status === "open" || e.status === "doing").map((e) => <a key={e.id} href={`#tasks/${e.id}`} className={`edge ${e.kind}`}>{e.kind === "unblocks" ? "unblocks" : "boosts"} · {e.title}</a>)}</div>)}
      <div className="chips" style={{ marginTop: 16 }}>
        {t.status === "open" && <button className="btn primary" onClick={() => act("doing")}>Start today</button>}
        <button className={`btn ${t.status === "doing" ? "primary" : ""}`} onClick={() => act("done")}>Mark done</button>
        <a className="btn ghost" href={`#tasks/${t.id}`}>Details</a>
      </div>
    </div>
  );
}

function DebriefCard({ d, doneWhen, notify }: { d: State["questions"]["debriefs"][number]; doneWhen?: string; notify: Notify }) {
  const [f, setF] = useState<{ result: string | null; effort: number | null; defensibility: number | null; quality: number | null; asset: string; metric: string; surprise: string; lesson: string; next: string }>(
    { result: null, effort: null, defensibility: null, quality: null, asset: "", metric: "", surprise: "", lesson: "", next: "" });
  const ready = f.result && f.effort !== null && f.defensibility !== null && f.quality !== null;
  const submit = async () => {
    const r = await api("/api/debriefs", "POST", { taskId: d.taskId, ...f });
    const parts = ["Debrief saved."];
    if (r.rejudged?.length) parts.push(`Its result now fuels ${r.rejudged.length} task${r.rejudged.length > 1 ? "s" : ""}; Orion is re-judging them.`);
    if (r.created?.length) parts.push(`${r.created.length} new task${r.created.length > 1 ? "s" : ""} added to the flow.`);
    notify(parts.join(" "));
  };
  return (
    <div className="card ask">
      <div className="caps muted">Just finished · debrief · 1 minute</div>
      <h3>How did “{d.title}” go?</h3>
      {doneWhen && <div className="donewhen"><span className="caps muted">It was done when</span><p>{doneWhen}</p></div>}
      <div className="q"><h4>Compared with what we expected, the result was…</h4>
        <div className="chips">{RESULTS.map(([k, l]) => <button key={k} type="button" className={`chip ${f.result === k ? "on" : ""}`} onClick={() => setF({ ...f, result: k })}>{l}</button>)}</div></div>
      <div className="q"><h4>How much effort did it really take? <span className="mono muted">Orion: {level(d.predicted.effort, "effort")}</span></h4>
        <Levels dim="effort" value={f.effort} expect={d.predicted.effort} onChange={(v) => setF({ ...f, effort: v })} /></div>
      <div className="q"><h4>How much harder to copy are we now? <span className="mono muted">Orion: {level(d.predicted.defensibility, "defensibility")}</span></h4>
        <Levels dim="defensibility" value={f.defensibility} expect={d.predicted.defensibility} onChange={(v) => setF({ ...f, defensibility: v })} /></div>
      <div className="q"><h4>How much did it raise the quality of what we ship? <span className="mono muted">Orion: {level(d.predicted.quality, "quality")}</span></h4>
        <Levels dim="quality" value={f.quality} expect={d.predicted.quality} onChange={(v) => setF({ ...f, quality: v })} /></div>
      <div className="grid2 q">
        <label className="f"><span className="caps muted">What did it leave us that a competitor can't copy?</span><input type="text" value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })} placeholder="e.g. signed release key, 40 opt-in outcomes" /></label>
        <label className="f"><span className="caps muted">Did a number move?</span><input type="text" value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })} placeholder="e.g. 2 paying customers, +$158" /></label>
        <label className="f"><span className="caps muted">What surprised you?</span><textarea value={f.surprise} onChange={(e) => setF({ ...f, surprise: e.target.value })} /></label>
        <label className="f"><span className="caps muted">Lesson for next time (Orion reads these)</span><textarea value={f.lesson} onChange={(e) => setF({ ...f, lesson: e.target.value })} /></label>
      </div>
      <label className="f q"><span className="caps muted">What does this make possible next? One task per line; each starts fuelled by this one</span>
        <textarea value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} placeholder="e.g. Offer the report as a free first week to the 5 people we talked to" /></label>
      <button className="btn primary" disabled={!ready} onClick={submit}>Save debrief</button>
    </div>
  );
}

function DailyCard({ d, state, notify }: { d: NonNullable<State["questions"]["daily"]>; state: State; notify: Notify }) {
  const [updates, setUpdates] = useState<Record<string, { state?: string; note?: string }>>({});
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [follow, setFollow] = useState<Record<string, { impact?: number; metric?: string }>>({});
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [learned, setLearned] = useState("");
  const [blocker, setBlocker] = useState("");
  const up = (id: string, patch: { state?: string; note?: string }) => setUpdates({ ...updates, [id]: { ...updates[id], ...patch } });
  const total = d.inProgress.length + d.followUps.length + d.voi.length + 1;
  const answered = Object.keys(updates).length + Object.keys(follow).length + Object.keys(answers).length + (learned || blocker ? 1 : 0);
  const submit = async () => {
    await api("/api/checkins", "POST", {
      updates, learned, blocker, metrics,
      answers: Object.entries(answers).map(([k, lv]) => { const [taskId, dim] = k.split(":"); return { taskId, dim, level: lv }; }),
      followUps: Object.entries(follow).filter(([, v]) => v.impact !== undefined).map(([taskId, v]) => ({ taskId, ...v })),
    });
    notify(Object.values(updates).some((u) => u.state === "done") ? "Checked in. Debrief the finished task now." : "Checked in for today. Thank you.");
  };
  return (
    <div className="card ask">
      <div className="caps muted">Daily check-in · {d.date}</div>
      <h3>Two minutes, {d.who}.</h3>
      <div className="progress thin"><i style={{ width: `${Math.min(100, (answered / total) * 100)}%` }} /></div>

      {d.inProgress.length > 0 && <div className="q"><h4>How are your tasks in progress?</h4>
        {d.inProgress.map((t) => (
          <div key={t.id} style={{ margin: "10px 0" }}>
            <div style={{ marginBottom: 6 }}>{t.title}</div>
            <div className="chips">
              {[["on_track", "On track"], ["blocked", "Blocked"], ["done", "Done ✓"], ["drop", "Drop it"]].map(([k, l]) => (
                <button key={k} className={`chip ${updates[t.id]?.state === k ? "on" : ""}`} onClick={() => up(t.id, { state: k })}>{l}</button>))}
            </div>
            {updates[t.id]?.state === "blocked" && <input type="text" style={{ marginTop: 6 }} placeholder="What's blocking it?" onChange={(e) => up(t.id, { note: e.target.value })} />}
          </div>
        ))}
      </div>}

      {d.followUps.map((f) => (
        <div className="q" key={f.taskId}>
          <h4>“{f.title}” was finished {ago(f.doneAt)}. Has the impact shown up? <span className="mono muted">Orion: {level(f.predictedImpact, "impact")}</span></h4>
          <Levels dim="impact" value={follow[f.taskId]?.impact ?? null} expect={f.predictedImpact} onChange={(v) => setFollow({ ...follow, [f.taskId]: { ...follow[f.taskId], impact: v } })} />
          <input type="text" style={{ marginTop: 6 }} placeholder="Which number moved? (optional)" onChange={(e) => setFollow({ ...follow, [f.taskId]: { ...follow[f.taskId], metric: e.target.value } })} />
        </div>
      ))}

      {d.voi.map((v) => (
        <div className="q" key={`${v.taskId}:${v.dim}`}>
          <div className="caps muted" style={{ marginBottom: 4 }}>Orion is unsure · your answer could reorder the list</div>
          <h4>{v.prompt}</h4>
          <Levels levels={v.levels} value={answers[`${v.taskId}:${v.dim}`] ?? null} onChange={(lv) => setAnswers({ ...answers, [`${v.taskId}:${v.dim}`]: lv })} />
        </div>
      ))}

      <div className="grid2 q">
        <label className="f"><span className="caps muted">What did a customer, lead or the market teach us yesterday?</span><textarea value={learned} onChange={(e) => setLearned(e.target.value)} /></label>
        <label className="f"><span className="caps muted">Anything blocking you?</span><textarea value={blocker} onChange={(e) => setBlocker(e.target.value)} /></label>
      </div>
      <details className="q"><summary className="caps muted" style={{ cursor: "pointer" }}>Did a goal number change? (optional)</summary>
        <div className="grid2" style={{ marginTop: 10 }}>
          {state.metrics.map((m) => (
            <label className="f" key={m.name}><span className="mono muted">{m.name} · now {m.value ?? "—"}</span>
              <input type="number" inputMode="decimal" value={metrics[m.name] ?? ""} onChange={(e) => setMetrics({ ...metrics, [m.name]: e.target.value })} /></label>))}
        </div>
      </details>
      <button className="btn primary" onClick={submit}>Check in</button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- needs you

const ACTION_LABEL: Record<Directive["action"], string> = { proceed: "agent proceeds", wait: "agent waits", "work-around": "agent works around it", stop: "agent stopped" };
const hoursAgo = (iso: string) => { const h = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000); return h < 1 ? "just now" : h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`; };

/** One request from an agent (or a teammate) that only a person can answer. */
function NeedCard({ n, notify }: { n: Need; notify: Notify }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const authority = AUTHORITY.has(n.kind);
  const answer = async (resolution: "done" | "declined" | "workaround") => {
    setBusy(true);
    try {
      await api(`/api/interventions/${n.id}`, "PATCH", { resolution, note });
      notify(resolution === "workaround" ? "Sent: the agent will look for a way around it." : resolution === "declined" ? "Declined. The agent won't pursue it." : "Marked done. The agent carries on.");
    } catch (e) { notify(String((e as Error).message)); setBusy(false); }
  };
  const hours = (Date.now() - Date.parse(n.createdAt)) / 3_600_000;
  return (
    <div className={`card need ${authority ? "authority" : ""}`}>
      <div className="needhead">
        <span className={`why ${authority ? "warn" : "info"}`}>{KINDS[n.kind].split(":")[0]}</span>
        <a className="t" href={`#tasks/${n.taskId}`}>{n.taskTitle || "a task"}</a>
        <span className="mono muted right">{n.createdBy} · {hoursAgo(n.createdAt)}</span>
      </div>
      <p className="needtext">{n.need}</p>
      {n.tried && <p className="muted small">Already tried: {n.tried}</p>}
      <p className="mono muted small">{authority
        ? "Needs your authority: the agent waits and won't route around it."
        : hours >= SLA_HOURS ? `No answer in ${SLA_HOURS} h: the agent is now looking for a way around it.` : `If unanswered, the agent works around it after ${SLA_HOURS} h.`}</p>
      <div className="chips">
        <input className="grow" placeholder={authority ? "Note (optional)" : "Hint for the agent (optional)"} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn primary" disabled={busy} onClick={() => answer("done")}>Done</button>
        <button className="btn" disabled={busy} onClick={() => answer("workaround")} title={authority ? "Ask the agent for a path that does not need this" : "Ask the agent to find another way"}>Find a way around</button>
        <button className="btn ghost" disabled={busy} onClick={() => answer("declined")}>Decline</button>
      </div>
    </div>
  );
}

/** An agent's report on its own finished work, for a person to confirm or dispute. */
function ReviewCard({ u, notify }: { u: State["agentLearning"]["unreviewed"][number]; notify: Notify }) {
  const review = async (verdict: "confirmed" | "disputed") => {
    await api(`/api/debriefs/${u.taskId}/review`, "POST", { verdict });
    notify(verdict === "confirmed" ? "Confirmed: it now counts fully in what the agents learn." : "Disputed: the agents won't learn from it.");
  };
  return (
    <div className="card review">
      <div className="needhead"><span className="why info">Check</span><a className="t" href={`#tasks/${u.taskId}`}>{u.title}</a>
        <span className="mono muted right">{u.who} says: {u.result.replace("-", " ")}</span></div>
      <div className="chips"><button className="btn" onClick={() => review("confirmed")}>Confirm</button><button className="btn ghost" onClick={() => review("disputed")}>Dispute</button></div>
    </div>
  );
}

function NeedsYou({ state, notify }: { state: State; notify: Notify }) {
  const open = state.interventions.open, unreviewed = state.agentLearning.unreviewed;
  if (!open.length && !unreviewed.length) return null;
  return (
    <section><Head n="!" title="Needs you" right={<span className="mono muted">{open.length} request{open.length === 1 ? "" : "s"}{unreviewed.length ? ` · ${unreviewed.length} to check` : ""}</span>} />
      <div className="stack">
        {open.map((n) => <NeedCard key={n.id} n={n} notify={notify} />)}
        {unreviewed.map((u) => <ReviewCard key={u.taskId} u={u} notify={notify} />)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- agents

const EVENT_WORD: Record<string, string> = {
  "task.add": "proposed", "task.doing": "started", "task.done": "finished", "task.open": "paused", "task.steps": "ticked steps on",
  "task.edit": "edited", debrief: "debriefed", "link.add": "linked", "intervention.open": "asked a person about",
  "intervention.resolve": "withdrew a request on",
};
const ACTION_TONE: Record<Directive["action"], string> = { proceed: "good", "work-around": "info", wait: "warn", stop: "warn" };
const agoShort = (iso: string) => { const m = Math.floor((Date.now() - Date.parse(iso)) / 60_000); return m < 1 ? "now" : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`; };

/** One agent event in words, with a debrief's result and what it left us. */
function ActivityLine({ e }: { e: Activity }) {
  return (
    <li><span className="mono muted when">{agoShort(e.at)}</span>
      <span><b>{e.who.replace(" (agent)", "")}</b> {EVENT_WORD[e.kind] ?? e.kind} {e.taskId ? <a href={`#tasks/${e.taskId}`}>{e.taskTitle || "a task"}</a> : null}
        {e.result && <span className={`why ${e.result.includes("better") ? "good" : e.result.includes("worse") ? "warn" : "info"}`} style={{ marginLeft: 6 }}>{e.result.replace("-", " ")}</span>}
        {e.asset && <span className="muted small"> · left us: {e.asset}</span>}</span></li>
  );
}

/** The human side of the sync: what the agents did since this person last looked, until they mark it read. */
function FromAgents({ state, notify }: { state: State; notify: Notify }) {
  const u = state.agentUpdates;
  if (!u || !u.items.length) return null;
  const n = (k: string) => u.items.filter((e) => e.kind === k).length;
  const summary = [n("task.done") && `${n("task.done")} finished`, n("debrief") && `${n("debrief")} debriefed`, n("task.add") && `${n("task.add")} proposed`,
    n("intervention.open") && `${n("intervention.open")} asked you`, n("task.doing") && `${n("task.doing")} started`].filter(Boolean).join(" · ");
  return (
    <section><Head n="↻" title="From the agents" right={<span className="mono muted">{u.since ? `since ${agoShort(u.since)} ago` : "so far"}</span>} />
      <div className="card fromagents">
        <div className="needhead"><b>{summary || `${u.items.length} updates`}</b>
          <button className="btn ghost right" onClick={async () => { await api("/api/seen", "POST"); notify("Marked as read."); }}>Mark as read</button></div>
        <ul className="feed">{u.items.slice(0, 12).map((e) => <ActivityLine key={e.id} e={e} />)}</ul>
        {u.items.length > 12 && <a className="mono muted small" href="#agents">and {u.items.length - 12} more on Agents →</a>}
      </div>
    </section>
  );
}

/** The agentic section: what needs a person, what the agents do next and why, what they did, what they learned. */
function Agents({ state, notify }: { state: State; notify: Notify }) {
  const byId = new Map(state.list.map((t) => [t.id, t]));
  const queue = state.lanes.agent.map((id) => byId.get(id)!).filter(Boolean);
  const counts = queue.reduce((a, t) => ({ ...a, [t.directive.action]: (a[t.directive.action] ?? 0) + 1 }), {} as Record<string, number>);
  const A = state.agentLearning;
  return (
    <>
      <div className="hero compact">
        <h1>The agents' lane. <em>{counts.proceed || counts["work-around"] ? `${(counts.proceed ?? 0) + (counts["work-around"] ?? 0)} ready` : "Nothing ready"}.</em></h1>
        <p>Work agents do on their own, in Orion's order. They ask here when only a person can help, and they learn from outcomes about four times faster than the team lane.</p>
      </div>
      <div className="stats">
        {([["proceed", "Ready"], ["work-around", "Working around"], ["wait", "Waiting"], ["stop", "Stopped"]] as const).map(([a, l]) => <div key={a} className="stat"><span className="v">{counts[a] ?? 0}</span><span className="caps muted">{l}</span></div>)}
        <div className="stat"><span className="v">{state.interventions.open.length}</span><span className="caps muted">need you</span></div>
      </div>
      {state.automation.ready && <a className="card agentsum" href="#planner"><span className="caps muted">Adaptive planner</span><span>{state.automation.settings.enabled ? state.automation.runs[0]?.plan?.summary.slice(0, 180) ?? "Research and recommendations will appear after the next run." : "Paused by a person."}</span><span className="mono muted right">open →</span></a>}
      <NeedsYou state={state} notify={notify} />
      <section><Head n="01" title="Next for the agents" right={<span className="mono muted">{queue.length} in the lane</span>} />
        {queue.length === 0 ? <div className="empty">Nothing in the agent lane. Open a task and choose “give to the agents”.</div> : (
          <div className="rows">{queue.map((t, i) => (
            <a key={t.id} className="row agentrow" href={`#tasks/${t.id}`}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <div className="t">{t.title}</div>
                <div className="sub"><span className={`why ${ACTION_TONE[t.directive.action]}`}>{ACTION_LABEL[t.directive.action]}</span>
                  <span className="muted small directive">{t.directive.hint ? `Hint: ${t.directive.hint}` : t.directive.why}</span></div>
              </div>
              <span className="tag hide-sm">{TRACK_SHORT[t.track]}</span>
              <span className="mono muted hide-sm right"><StepsProgress steps={t.steps} /><Odds row={t.row} /></span>
            </a>))}</div>)}
      </section>
      <div className="grid2">
        <section><Head n="02" title="What they did" right={<span className="mono muted">latest {state.agentActivity.length}</span>} />
          {state.agentActivity.length === 0 ? <div className="empty">No agent activity yet.</div> : (
            <ul className="feed">{state.agentActivity.map((e) => <ActivityLine key={e.id} e={e} />)}</ul>)}
        </section>
        <section><Head n="03" title="What they learned" right={<span className="mono muted">{A.unreviewed.length ? `${A.unreviewed.length} to check` : "all checked"}</span>} />
          <table className="t"><tbody>
            {Object.values(A.bias).map((b) => <tr key={b.dim}><td>{DIM_LABEL[b.dim]}</td><td className="mono">{b.n ? `${b.n} outcome${b.n === 1 ? "" : "s"}` : "—"}</td><td className="mono">{b.n ? `${b.bias > 0 ? "+" : ""}${b.bias} levels` : "—"}</td></tr>)}
            <tr><td>Skill vs. a blind guess</td><td className="mono" colSpan={2}>{A.record.n ? `${A.record.skill > 0 ? "+" : ""}${Math.round(A.record.skill * 100)}%` : "after the first outcome"}</td></tr>
          </tbody></table>
          <p className="muted small">From agent-lane outcomes only, always applied to agent tasks. An agent's own report counts ½ until you confirm it, 0 if you dispute it; the team lane never learns from it.</p>
        </section>
      </div>
    </>
  );
}

function Today({ state, refresh, notify }: { state: State; refresh: () => void; notify: Notify }) {
  const q = state.questions;
  const focus = state.focus && state.list.find((t) => t.id === state.focus!.id);
  const doing = state.list.filter((t) => t.status === "doing");
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const doneById = new Map(state.done.map((t) => [t.id, t.doneWhen]));
  return (
    <>
      <Hud state={state} refresh={refresh} notify={notify} />
      <div className="hero">
        <h1>{hello}, {state.who}. <em>{focus ? "One thing first." : state.list.length ? "Review what is blocked." : q.debriefs.length ? "Close the outcome loop." : "All clear."}</em></h1>
        <p>Orion ranks the work on impact, urgency, effort, leverage, defensibility and quality. Each day, and the moment something is done, Compass asks how it went.</p>
      </div>
      <NeedsYou state={state} notify={notify} />
      <FromAgents state={state} notify={notify} />
      {focus && <FocusCard t={focus} why={state.focus!.why} refresh={refresh} notify={notify} />}

      {(q.debriefs.length > 0 || q.daily) && <section><Head n="01" title="Orion asks" right={<span className="mono muted">checked in today: {q.checkedToday.join(", ") || "nobody yet"}</span>} />
        <div className="stack">
          {q.debriefs.map((d) => <DebriefCard key={d.taskId} d={d} doneWhen={doneById.get(d.taskId)} notify={notify} />)}
          {q.daily && <DailyCard key={q.daily.date} d={q.daily} state={state} notify={notify} />}
        </div>
      </section>}
      {!q.debriefs.length && !q.daily && <section><div className="card"><span className="why good">Checked in</span> <span className="muted">Nothing to answer. Your next check-in opens tomorrow, or the moment you finish a task.</span></div></section>}

      {state.lanes.agent.length > 0 && <a className="card agentsum" href="#agents">
        <span className="caps muted">Agents</span>
        <span>{state.lanes.agent.filter((id) => { const t = state.list.find((x) => x.id === id); return t && (t.directive.action === "proceed" || t.directive.action === "work-around"); }).length} ready · {state.interventions.open.length} waiting on you · {state.agentActivity.length ? `last active ${agoShort(state.agentActivity[0].at)} ago` : "no activity yet"}</span>
        <span className="mono muted right">open →</span>
      </a>}
      <section><Head n="02" title="In progress" right={<a className="mono muted" href="#tasks">all tasks →</a>} />
        {doing.length === 0 ? <div className="empty">Nobody has started anything yet. Start your focus above.</div> : (
          <div className="rows">{doing.map((t) => (
            <a key={t.id} className="row" href={`#tasks/${t.id}`}>
              <span className="n">{String(t.row.rank).padStart(2, "0")}</span>
              <div><div className="t">{t.title}</div><div className="sub"><span className="mono muted">{t.owner ?? "unassigned"}{t.startedAt ? ` · started ${ago(t.startedAt)}` : ""}</span><StepsProgress steps={t.steps} /></div></div>
            </a>))}</div>)}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- the game HUD

/** The instrument panel: you as a player. Orion deals the quest; finishing, debriefing and checking in earn XP. */
function Hud({ state, refresh, notify }: { state: State; refresh: () => void; notify: Notify }) {
  const g = state.game;
  const me = g.players.find(p => p.who === state.who);
  const [passing, setPassing] = useState(false);
  const [reason, setReason] = useState("");
  const quest = me?.quest ? state.list.find(t => t.id === me.quest!.id) : null;
  const span = me ? Math.max(1, me.levelCeil - me.levelFloor) : 1;
  const fill = me ? Math.round(((me.xp - me.levelFloor) / span) * 100) : 0;
  const act = async (fn: () => Promise<unknown>, msg: string) => { await fn(); notify(msg); refresh(); };
  const cells = Array.from({ length: Math.max(10, g.moat.forged + 2) }, (_, i) => i < g.moat.forged);
  return <section className="hud" aria-label="Your game status">
    <div className="eyebrow"><span>◎ Compass: Task Management System</span><span className="r">{state.today} · KGL · Orion is game master</span></div>
    <div className="hud-grid">
      <div>
        <div className="lvl"><small>Level</small>{me?.level ?? 1}</div>
        <div className="xpbar"><i style={{ width: `${fill}%` }} /></div>
        <div className="ro"><b>{me?.xp ?? 0}</b> XP · <b>{(me?.levelCeil ?? 100) - (me?.xp ?? 0)}</b> to level {(me?.level ?? 1) + 1}</div>
        <div className="ro" style={{ marginTop: 6 }}>Streak <b>{me?.streak ?? 0}</b> day{me?.streak === 1 ? "" : "s"}{me?.today ? <> · today <b>+{me.today}</b></> : null}</div>
        {!!me?.badges.length && <div>{me.badges.map(b => <span key={b.id} className="badge-chip">{b.name}</span>)}</div>}
      </div>
      <div>
        <div className="ro">Your quest{quest ? ` · rank #${quest.row.rank}${quest.moat?.worthy ? " · ◆ moat-worthy" : ""}` : ""}</div>
        {quest ? <>
          <div className="quest-title"><a href={`#tasks/${quest.id}`}>{quest.title}</a></div>
          <div className="ro">Worth ≈ <b>{Math.max(20, Math.round(quest.row.own * 10))}</b> XP{quest.moat?.worthy ? <> · <b>×1.5</b> if the debrief shows a moat</> : null} · first in <b>{Math.round(quest.row.pFirst * 100)}%</b> of Orion's futures</div>
          {quest.doneWhen && <div className="ro" style={{ marginTop: 6, textTransform: "none", letterSpacing: 0 }}>Done when: {quest.doneWhen}</div>}
          {passing ? <form className="chips" style={{ marginTop: 12 }} onSubmit={e => { e.preventDefault(); act(() => api(`/api/quests/${quest.id}/pass`, "POST", { reason }), "Passed. Orion dealt you another quest."); setPassing(false); setReason(""); }}>
            <input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Why pass? Orion learns from it" maxLength={300} />
            <button className="btn primary" disabled={reason.trim().length < 3}>Pass quest</button><button type="button" className="btn" onClick={() => setPassing(false)}>Keep it</button>
          </form> : <div className="chips" style={{ marginTop: 12 }}>
            {quest.status === "open" && <button className="btn primary" onClick={() => act(() => api(`/api/tasks/${quest.id}`, "PATCH", { status: "doing" }), "Quest started. Go.")}>Start quest</button>}
            {quest.status === "doing" && <button className="btn primary" onClick={() => act(() => api(`/api/tasks/${quest.id}`, "PATCH", { status: "done" }), "Quest complete. Debrief it on Today for the full XP.")}>Complete</button>}
            <button className="btn" onClick={() => setPassing(true)}>Pass</button>
          </div>}
        </> : <>
          <div className="quest-title">No quest yet.</div>
          <button className="btn primary" onClick={() => act(() => api("/api/quests/deal", "POST"), "Orion dealt the quests.")}>Ask Orion for a quest</button>
        </>}
      </div>
      <div>
        <div className="ro">Moat meter · prime law</div>
        <div className="moatmeter">{cells.map((on, i) => <span key={i} className={on ? "on" : ""} />)}</div>
        <div className="ro"><b>{g.moat.forged}</b> forged · <b>{state.list.filter(t => t.moat?.worthy).length}</b> moat-worthy open</div>
        <div className="feed">{g.feed.slice(0, 4).map((e, i) => <div key={`${e.at}${i}`}><span className="xp">+{e.xp}</span>{e.who.replace(" (agent)", "")} · {e.label.length > 34 ? e.label.slice(0, 33) + "…" : e.label}</div>)}{!g.feed.length && <div>No XP yet. Finish a quest or check in.</div>}</div>
      </div>
    </div>
    <div className="board">{g.players.map((p, i) => <div key={p.who} className={p.who === state.who ? "me" : ""}>{i + 1}. <b>{p.who.replace(" (agent)", "")}</b>{p.agent ? " ⚙" : ""} · L{p.level} · {p.xp} XP</div>)}</div>
  </section>;
}

// ---------------------------------------------------------------------------------------------- tasks

function TaskEditor({ t, onDone }: { t?: Task; onDone: (id?: string) => void }) {
  const [f, setF] = useState({ title: t?.title ?? "", detail: t?.detail ?? "", doneWhen: t?.doneWhen ?? "", steps: (t?.steps ?? []).map((s) => s.text).join("\n"), track: (t?.track ?? "revenue") as string, owner: t?.owner ?? "", projectId: t?.projectId ?? "" });
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!t) first.current?.focus(); }, [t]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    const steps = f.steps.split("\n").map((s) => s.trim()).filter(Boolean);
    if (t) {
      const kept = steps.map((text) => ({ text, done: t.steps.find((s) => s.text === text)?.done ?? false }));
      await api(`/api/tasks/${t.id}`, "PATCH", { title: f.title, detail: f.detail, doneWhen: f.doneWhen, track: f.track, owner: f.owner || null, steps: kept, ...(f.projectId !== (t.projectId ?? "") ? { projectId: f.projectId || null } : {}) });
      onDone(t.id);
    } else {
      const r = await api("/api/tasks", "POST", { ...f, steps, owner: f.owner || null, projectId: f.projectId || null });
      onDone(r.id);
    }
  };
  return (
    <form className="card editor" onSubmit={submit}>
      <div className="grid2">
        <label className="f"><span className="caps muted">Task</span><input ref={first} type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Start with a verb: Ship, Email, Fix…" /></label>
        <label className="f"><span className="caps muted">Done when (a test anyone can check)</span><input type="text" value={f.doneWhen} onChange={(e) => setF({ ...f, doneWhen: e.target.value })} placeholder="e.g. a real card pays and the licence activates" /></label>
        <label className="f"><span className="caps muted">Why / context (helps Orion judge)</span><textarea value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} /></label>
        <label className="f"><span className="caps muted">Steps, one per line</span><textarea value={f.steps} onChange={(e) => setF({ ...f, steps: e.target.value })} /></label>
        <label className="f"><span className="caps muted">Track</span><select value={f.track} onChange={(e) => setF({ ...f, track: e.target.value })}>{Object.entries(TRACKS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="f"><span className="caps muted">Owner</span><select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="">Unassigned</option>{TEAM.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label className="f"><span className="caps muted">Project</span><select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">Company-wide</option>{PROJECTS.filter(p => p.status !== "archived" || p.id === f.projectId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      <div className="chips"><button className="btn primary" type="submit">{t ? "Save and re-judge" : "Add task"}</button><button className="btn ghost" type="button" onClick={() => onDone()}>Cancel</button></div>
    </form>
  );
}

function TaskDetail({ t, all, refresh, notify }: { t: ListTask; all: { id: string; title: string }[]; refresh: () => void; notify: Notify }) {
  const [ask, setAsk] = useState<Dim | null>(null);
  const [editing, setEditing] = useState(false);
  const act = async (body: Record<string, unknown>, msg?: string) => {
    const r = await api(`/api/tasks/${t.id}`, "PATCH", body);
    if (body.status === "done") notify(doneMessage(r.unlocked)); else if (msg) notify(msg);
    refresh();
  };
  const answer = async (dim: Dim, lv: number) => { await api("/api/answers", "POST", { taskId: t.id, dim, level: lv }); setAsk(null); notify("Noted. Your answer replaces Orion's on that."); refresh(); };
  const team = new Map(t.teamAnswers.map((a) => [a.dim, a]));
  if (editing) return <div className="detail"><TaskEditor t={t} onDone={() => { setEditing(false); refresh(); }} /></div>;
  return (
    <div className="detail">
      <div className="grid2">
        <div>
          {t.doneWhen ? <div className="donewhen"><span className="caps muted">Done when</span><p>{t.doneWhen}</p></div> : <p className="muted">No “done when” yet. <button className="linkish" onClick={() => setEditing(true)}>Add one</button>: a clear test is the best predictor of finishing.</p>}
          {t.detail && <p className="muted">{t.detail}</p>}
          <div className="caps muted" style={{ margin: "14px 0 6px" }}>Steps</div>
          <Checklist t={t} refresh={refresh} />
          <div className="chips" style={{ marginTop: 16 }}>
            {t.status === "open" && <button className="btn primary" onClick={() => act({ status: "doing" }, "Started.")}>Start</button>}
            <button className="btn" onClick={() => act({ status: "done" }, "Done. The debrief is on Today.")}>Done</button>
            {t.status === "doing" && <button className="btn ghost" onClick={() => act({ status: "open" })}>Pause</button>}
            <button className="btn ghost" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn ghost" onClick={() => act({ status: "dropped" }, "Dropped.")}>Drop</button>
          </div>
          <div className="lanebox">
            <span className="caps muted">Lane</span> <b>{t.lane === "agent" ? "Agents" : "Team"}</b>
            <button className="linkish" onClick={() => act({ lane: t.lane === "agent" ? "team" : "agent" }, t.lane === "agent" ? "Moved to the team lane." : "Moved to the agent lane: agents will pick it up.")}>
              {t.lane === "agent" ? "move to the team" : "give to the agents"}</button>
            {t.lane === "agent" && <p className="mono muted small">{t.directive.why}{t.directive.hint ? ` Hint: ${t.directive.hint}` : ""}</p>}
          </div>
          <label className="f" style={{ marginTop: 14, maxWidth: 240 }}><span className="caps muted">Owner</span>
            <select value={t.owner ?? ""} onChange={(e) => act({ owner: e.target.value || null })}><option value="">Unassigned</option>{TEAM.map((p) => <option key={p}>{p}</option>)}</select></label>
          <Links t={t} all={all} refresh={refresh} notify={notify} />
        </div>
        <div>
          <div className="caps muted" style={{ marginBottom: 8 }}>Orion's read · tap a line to correct it</div>
          {t.judge === "pending" && <p className="why warn">Orion is judging…</p>}
          {t.judge === "error" && <p className="why warn">Not judged: {t.judgeError} <button className="linkish" onClick={async () => { await api(`/api/tasks/${t.id}/judge`, "POST"); refresh(); }}>retry</button></p>}
          {DIMS.map((d) => {
            const p = t.dims?.[d] ?? [0.2, 0.2, 0.2, 0.2, 0.2];
            const e = expected(p);
            return (
              <div key={d}>
                <button className="meter" onClick={() => setAsk(ask === d ? null : d)}>
                  <span>{DIM_LABEL[d]}{team.has(d) && <span className="mono" style={{ color: "var(--blue)" }}> · {team.get(d)!.who ?? "team"}</span>}</span>
                  <Belief p={p} />
                  <span className="mono muted lv">{level(e, d)}</span>
                </button>
                {ask === d && <div style={{ margin: "6px 0 12px" }}><div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>{QUESTIONS[d].question.replace("`option`", "this")}</div>
                  <Levels dim={d} value={team.get(d)?.level ?? null} expect={e} onChange={(v) => answer(d, v)} /></div>}
              </div>
            );
          })}
          <details style={{ marginTop: 12 }}><summary className="caps muted" style={{ cursor: "pointer" }}>Why here: odds and each framework's view</summary>
            <table className="t"><tbody>{Object.entries(t.row.ranks).map(([f, r]) => <tr key={f}><td>{FW_LABEL[f]}</td><td className="mono">#{r}</td></tr>)}</tbody></table>
            <p className="mono muted">{t.row.blockedBy.length ? "Waiting on a blocker, so not in the race yet" : `Likely rank #${t.row.rankLo}–#${t.row.rankHi} · top 5 in ${Math.round(t.row.pTop * 100)}% · first in ${Math.round(t.row.pFirst * 100)}%`}
              {" · "}value {t.row.value.toFixed(2)}{t.row.value > t.row.own + 0.005 ? ` (${(t.row.value - t.row.own).toFixed(2)} from work it fuels)` : ""} · {t.row.door === "one_way" ? "hard to undo: decide carefully" : "easy to undo: move fast"}</p>
          </details>
        </div>
      </div>
    </div>
  );
}

function TaskRow({ t, open, toggle }: { t: ListTask; open: boolean; toggle: () => void }) {
  return (
    <button className={`row ${t.row.rank === 1 ? "first" : ""} ${open ? "open" : ""}`} onClick={toggle} aria-expanded={open}>
      <span className="n">{String(t.row.rank).padStart(2, "0")}</span>
      <div>
        <div className="t">{t.title}</div>
        <div className="sub">{t.moat?.worthy && <span className="why good" title={`Orion: ${Math.round(t.moat.p * 100)}% that this clearly makes Archymedes harder to copy`}>◆ moat</span>}<Reasons rs={t.reasons} />{t.judge === "pending" && <span className="why warn">judging…</span>}
          {t.lane === "agent" && t.directive.action !== "proceed" && <span className={`why ${t.directive.action === "stop" ? "warn" : "info"}`} title={t.directive.why}>{ACTION_LABEL[t.directive.action]}</span>}</div>
      </div>
      <span className="tag hide-sm">{projectName(t.projectId) ?? TRACK_SHORT[t.track]}</span>
      <span className="mono muted hide-sm right">{t.owner ?? "—"} <StepsProgress steps={t.steps} /><Odds row={t.row} /></span>
    </button>
  );
}

/** How settled a task's place is: P(top 5) over Orion's beliefs, with the likely rank range on hover. */
function Odds({ row }: { row: Row }) {
  if (row.blockedBy.length) return null;
  const pct = Math.round(row.pTop * 100);
  const range = row.rankLo === row.rankHi ? `#${row.rankLo}` : `#${row.rankLo}–#${row.rankHi}`;
  return <span className={`odds ${pct >= 90 ? "sure" : pct <= 10 ? "out" : ""}`} title={`In the top 5 in ${pct}% of simulations over Orion's beliefs. Likely rank ${range}.`}>{pct}%</span>;
}

function Tasks({ state, openId, refresh, notify, calibrated, setCalibrated }: { state: State; openId: string | null; refresh: () => void; notify: Notify; calibrated: boolean; setCalibrated: (v: boolean) => void }) {
  const [adding, setAdding] = useState(false);
  const [lane, setLaneState] = useState<Lane | "all">(() => (store.get("compass.lane") as Lane | "all" | null) ?? "team");
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("all");
  const [project, setProject] = useState(() => store.get("compass.project") ?? "all");
  const pickProject = (p: string) => { setProject(p); store.set("compass.project", p); };
  const setLane = (l: Lane | "all") => { setLaneState(l); store.set("compass.lane", l); };
  const toggle = (id: string) => { location.hash = openId === id ? "tasks" : `tasks/${id}`; };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "n" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { e.preventDefault(); setAdding(true); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (openId) document.getElementById(`task-${openId}`)?.scrollIntoView({ block: "nearest" }); }, [openId]);
  const anyBias = Object.values(state.learning.bias).some((b) => b.n > 0);
  useEffect(() => {
    if (!openId) return;
    const task = [...state.list, ...state.done].find(t => t.id === openId);
    if (task) setLane(task.lane);
    setSearch(""); setOwner("all"); pickProject("all");
  }, [openId]);
  const inLane = (t: Task) => (lane === "all" || t.lane === lane) && (project === "all" || (project === "none" ? !t.projectId : t.projectId === project));
  const matches = (t: Task) => inLane(t) && (owner === "all" || (owner === "mine" ? t.owner === state.who : owner === "unassigned" ? !t.owner : t.owner === owner))
    && `${t.title} ${t.detail} ${t.doneWhen} ${t.owner ?? ""} ${t.track}`.toLowerCase().includes(search.trim().toLowerCase());
  const shown = lane === "agent" ? state.lanes.agent.map((id) => state.list.find((t) => t.id === id)!).filter(Boolean) : state.list.filter(inLane);
  const filtered = shown.filter(matches);
  const finished = state.done.filter(matches);
  const top = shown.find((t) => t.status === "open" && !t.row.blockedBy.length);
  const bold = state.list.find((t) => t.id === state.bold && inLane(t));
  const doing = filtered.filter((t) => t.status === "doing"), open = filtered.filter((t) => t.status === "open");
  const block = (ts: ListTask[]) => ts.map((t) => (
    <div key={t.id} id={`task-${t.id}`}>
      <TaskRow t={t} open={openId === t.id} toggle={() => toggle(t.id)} />
      {openId === t.id && <TaskDetail t={t} all={state.list} refresh={refresh} notify={notify} />}
    </div>));
  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={() => setAdding(true)}>New task <kbd>N</kbd></button>
        <span className="lanes" role="tablist" aria-label="Lane">
          {([["team", "Team", state.lanes.team.length], ["agent", "Agents", state.lanes.agent.length], ["all", "All", state.list.length]] as const).map(([k, l, n]) =>
            <button key={k} role="tab" aria-selected={lane === k} className={`chip ${lane === k ? "on" : ""}`} onClick={() => setLane(k)}>{l} <span className="mono muted">{n}</span></button>)}
        </span>
        <span className="spacer" />
        {top && <span className="mono muted" title={`Simulated over Orion's beliefs. The eight frameworks agree ${Math.round(state.agreement * 100)}% (Kendall's W); they explain, they don't vote.`}>
          #1 is first in {Math.round(top.row.pFirst * 100)}% of simulations{top.row.pFirst < 0.5 ? ": a close call" : ""}</span>}
        <button className={`chip ${calibrated ? "on" : ""}`} disabled={!anyBias} title={anyBias ? "Correct Orion with our own track record" : "Needs a debrief first"} onClick={() => setCalibrated(!calibrated)}>Calibrated</button>
      </div>
      <div className="task-filters">
        <label className="f"><span className="caps muted">Search tasks</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Title, detail, outcome or track" /></label>
        <label className="f"><span className="caps muted">Owner</span><select aria-label="Filter by owner" value={owner} onChange={e => setOwner(e.target.value)}><option value="all">Everyone</option><option value="mine">My tasks</option><option value="unassigned">Unassigned</option>{TEAM.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="f"><span className="caps muted">Project</span><select aria-label="Filter by project" value={project} onChange={e => pickProject(e.target.value)}><option value="all">All projects</option><option value="none">Company-wide</option>{PROJECTS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <span className="mono muted">{filtered.length} active · {finished.length} finished</span>
      </div>
      {bold && matches(bold) && <button className="bold" onClick={() => toggle(bold.id)}>
        <span className="caps">Bold bet</span><span className="t">{bold.title}</span>
        <span className="muted">Unproven, with the most upside over #1. Test it cheaply first rather than rule it out.</span>
      </button>}
      {adding && <TaskEditor onDone={(id) => { setAdding(false); if (id) { notify("Added. Orion is judging it."); location.hash = `tasks/${id}`; } refresh(); }} />}
      {doing.length > 0 && <section><Head n="01" title="In progress" /><div className="rows">{block(doing)}</div></section>}
      {lane === "agent" && <p className="muted small">The agents' lane: what they can act on now comes first. It learns from its outcomes about four times faster than the team lane, and an agent's own report counts for half until someone confirms it on Today.</p>}
      <section><Head n={doing.length ? "02" : "01"} title={lane === "agent" ? "Next for the agents" : lane === "team" ? "Next for the team, in Orion's order" : "Next, in Orion's order"} right={<span className="mono muted">{open.length} open</span>} />
        <div className="rows">{open.length ? block(open) : <div className="empty">{lane === "agent" ? "Nothing in the agent lane. Open a task and choose “give to the agents”." : "Nothing open. Press N to add a task."}</div>}</div>
      </section>
      <section><Head n="·" title="Finished" right={<span className="mono muted">{finished.length} done · {state.dropped.length} dropped overall</span>} />
        {finished.length === 0 ? <div className="empty">No finished tasks match this view.</div> : (
          <div className="rows">{finished.map((t) => (
            <div className="row static" key={t.id} id={`task-${t.id}`}>
              <span className="n">✓</span>
              <div><div className="t">{t.title}</div>{t.debrief?.asset && <div className="mono muted">left us: {t.debrief.asset}</div>}</div>
              <span className="hide-sm">{t.debrief ? <span className="why good">{String(t.debrief.result).replace("-", " ")}</span> : <span className="why warn">awaiting debrief</span>}</span>
              <span className="mono muted hide-sm right">{t.doneAt ? ago(t.doneAt) : ""}</span>
            </div>))}</div>)}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- the flow

const doneMessage = (unlocked?: { title: string }[]) => unlocked?.length
  ? `Done. Unlocked: ${unlocked.map((u) => u.title).join("; ")}. Debrief it on Today.`
  : "Done. Tell Orion how it went on Today.";

function Links({ t, all, refresh, notify }: { t: ListTask; all: { id: string; title: string }[]; refresh: () => void; notify: Notify }) {
  const [f, setF] = useState<{ dir: "feeds" | "fedBy"; kind: LinkKind; other: string }>({ dir: "feeds", kind: "boosts", other: "" });
  const remove = async (from: string, to: string) => { await api("/api/links", "DELETE", { from, to }); refresh(); };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.other) return;
    const [from, to] = f.dir === "feeds" ? [t.id, f.other] : [f.other, t.id];
    try { await api("/api/links", "POST", { from, to, kind: f.kind }); setF({ ...f, other: "" }); notify("Linked. The order now counts it."); refresh(); }
    catch (x) { notify(x instanceof Error ? x.message : String(x)); }
  };
  const linked = new Set([t.id, ...t.feeds.map((e) => e.id), ...t.fedBy.map((e) => e.id)]);
  const list = (edges: Edge[], dir: "feeds" | "fedBy") => edges.map((e) => (
    <div key={e.id} className={`linkrow ${e.status === "done" ? "done" : ""}`}>
      <span className={`edge ${e.kind}`}>{dir === "feeds" ? KIND_WORD[e.kind] : e.kind === "unblocks" ? "needs" : "boosted by"}</span>
      <a href={`#tasks/${e.id}`}>{e.title}</a>{e.status === "done" && <span className="mono muted">done</span>}
      <button className="linkish" title="Remove link" onClick={() => (dir === "feeds" ? remove(t.id, e.id) : remove(e.id, t.id))}>×</button>
    </div>));
  return (
    <div className="links">
      <div className="caps muted">Fuels</div>
      {t.feeds.length ? list(t.feeds, "feeds") : <p className="muted small">Nothing yet.</p>}
      <div className="caps muted" style={{ marginTop: 10 }}>Fuelled by</div>
      {t.fedBy.length ? list(t.fedBy, "fedBy") : <p className="muted small">Nothing yet.</p>}
      <form className="linkform" onSubmit={add}>
        <select value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value as "feeds" })}><option value="feeds">This task</option><option value="fedBy">Another task</option></select>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as LinkKind })}><option value="boosts">boosts</option><option value="unblocks">unblocks</option></select>
        <select value={f.other} onChange={(e) => setF({ ...f, other: e.target.value })}>
          <option value="">{f.dir === "feeds" ? "which task?" : "this task, from…"}</option>
          {all.filter((x) => !linked.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
        </select>
        <button className="btn" type="submit" disabled={!f.other}>Link</button>
      </form>
    </div>
  );
}

/** The tasks as a left-to-right graph: each column is a stage, each line a link. Finished work stays, faded. */
function Flow({ state }: { state: State }) {
  const [hot, setHot] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const nodes = [...state.list.map((t) => ({ id: t.id, title: t.title, status: t.status as Status, rank: t.row.rank, blocked: t.row.blockedBy.length > 0, flow: t.row.flow })),
    ...state.done.filter((t) => state.links.some((l) => l.from === t.id || l.to === t.id)).map((t) => ({ id: t.id, title: t.title, status: "done" as Status, rank: 0, blocked: false, flow: 0 }))];
  const ids = new Set(nodes.map((n) => n.id));
  const links = state.links.filter((l) => ids.has(l.from) && ids.has(l.to));
  const active = hot ?? (ids.has(selected) ? selected : null);
  const chain = active ? influence(active, links) : null;
  const related = new Set(active && chain ? [active, ...chain.upstream.keys(), ...chain.downstream.keys()] : []);
  const stage = stages([...ids], links, true);
  const cols: typeof nodes[] = [];
  for (const n of nodes) (cols[stage.get(n.id)!] ??= []).push(n);
  // Untangle: order each column by the average position of what it links to (barycenter sweeps, as in layered
  // graph drawing), starting from rank order. Down the stages by feeders, then back up by what each one fuels.
  cols.forEach((c) => c.sort((a, b) => (a.rank || 999) - (b.rank || 999)));
  const index = () => new Map(cols.flatMap((c) => c.map((n, j) => [n.id, j] as const)));
  const bary = (c: typeof nodes, nbrs: (id: string) => string[]) => {
    const at = index();
    const key = (id: string, own: number) => { const xs = nbrs(id).map((x) => at.get(x)).filter((x): x is number => x !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : own; };
    const k = new Map(c.map((n, j) => [n.id, key(n.id, j)]));
    c.sort((a, b) => k.get(a.id)! - k.get(b.id)!);
  };
  const preds = (id: string) => links.filter((l) => l.to === id).map((l) => l.from);
  const succs = (id: string) => links.filter((l) => l.from === id).map((l) => l.to);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < cols.length; i++) bary(cols[i], preds);
    for (let i = cols.length - 2; i >= 0; i--) bary(cols[i], succs);
  }
  const W = 210, H = 62, GX = 50, GY = 12, PAD = 14;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((c, i) => c.forEach((n, j) => pos.set(n.id, { x: PAD + i * (W + GX), y: PAD + j * (H + GY) })));
  const width = PAD * 2 + cols.length * W + (cols.length - 1) * GX;
  const height = PAD * 2 + Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  const maxFlow = Math.max(...nodes.map((n) => n.flow), 1);
  const lines = (title: string) => {
    const words = title.split(" "), out: string[] = [""];
    for (const w of words) { if ((out.at(-1)! + " " + w).trim().length > 27 && out.length < 2) out.push(w); else out[out.length - 1] = (out.at(-1)! + " " + w).trim(); }
    if (out[1] && out[1].length > 27) out[1] = out[1].slice(0, 26) + "…";
    return out;
  };
  return (
    <>
      <div className="hero compact"><h1>Every task <em>fuels</em> another.</h1>
        <p>Left to right is the order work flows in. A solid line means the next task can't finish without it; a dashed line means it makes the next one worth more. Value flows back along the lines, so the work that feeds the most rises in the list.</p></div>
      <section><Head n="01" title="The flow" right={<span className="legend mono muted"><i className="l-unblocks" /> unblocks <i className="l-boosts" /> boosts <i className="l-blocked" /> waiting <i className="l-done" /> done</span>} />
        <label className="f flow-select"><span className="caps muted">Trace a task and everything it influences</span>
          <select value={ids.has(selected) ? selected : ""} onChange={(e) => { setHot(null); setSelected(e.target.value); }}>
            <option value="">Show the whole system</option>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
          </select>
        </label>
        {nodes.length === 0 ? <div className="empty">No tasks yet.</div> : (
          <div className="flowwrap">
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="How the tasks feed each other">
              <defs>
                <marker id="arr-u" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--ink)" /></marker>
                <marker id="arr-b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--sky)" /></marker>
              </defs>
              {links.map((l) => {
                const a = pos.get(l.from)!, b = pos.get(l.to)!;
                const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
                const cls = active ? (related.has(l.from) && related.has(l.to) ? "hot" : "dim") : "";
                return <path key={l.from + l.to} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} className={`link ${l.kind} ${cls}`} markerEnd={`url(#arr-${l.kind === "unblocks" ? "u" : "b"})`} />;
              })}
              {nodes.map((n) => {
                const p = pos.get(n.id)!;
                const [l1, l2] = lines(n.title);
                return (
                  <a key={n.id} href={`#tasks/${n.id}`} aria-label={`${n.title}${n.status === "done" ? ", done" : ""}`} className={`node ${n.status} ${n.blocked ? "blocked" : ""} ${n.rank === 1 ? "first" : ""} ${active && !related.has(n.id) ? "dim" : ""}`}
                    onMouseEnter={() => setHot(n.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(n.id)} onBlur={() => setHot(null)}>
                    <rect x={p.x} y={p.y} width={W} height={H} />
                    {n.status !== "done" && <rect className="fuel" x={p.x} y={p.y + H - 3} width={Math.max(4, (n.flow / maxFlow) * W)} height={3} />}
                    <text x={p.x + 10} y={p.y + 18} className="nrank">{n.status === "done" ? "✓ done" : `#${n.rank}${n.blocked ? " · waiting" : n.status === "doing" ? " · in progress" : ""}`}</text>
                    <text x={p.x + 10} y={p.y + 36} className="ntitle">{l1}</text>
                    {l2 && <text x={p.x + 10} y={p.y + 51} className="ntitle">{l2}</text>}
                  </a>
                );
              })}
            </svg>
          </div>)}
        <p className="muted small">The blue bar under each task is how much value flows through it. Select a task to keep its whole influence chain highlighted; point at one to preview it. Open a task to edit its links.{width > 1100 ? " Scroll sideways to follow the flow." : ""}</p>
        {ids.has(selected) && <Influence state={state} id={selected} links={links} />}
      </section>
    </>
  );
}

function Influence({ state, id, links }: { state: State; id: string; links: Link[] }) {
  const tasks = [...state.list, ...state.done];
  const task = tasks.find((t) => t.id === id)!;
  const chain = influence(id, links);
  const evidence = state.done.filter((t) => (t.id === id || chain.upstream.has(t.id)) && (t.debrief || t.followup));
  const relationList = (distances: Map<string, number>, upstream: boolean) => {
    const entries = [...distances].sort((a, b) => a[1] - b[1]);
    return entries.length ? <ul className="influence-list">{entries.map(([other, distance]) => {
      const t = tasks.find((t) => t.id === other)!;
      const direct = links.find((l) => upstream ? l.from === other && l.to === id : l.from === id && l.to === other);
      return <li key={other}><a href={`#tasks/${other}`}>{t.title}</a><span className="mono muted">{distance === 1 ? direct?.kind : `${distance} links away`} · {t.status}</span></li>;
    })}</ul> : <p className="muted small">{upstream ? "No linked prerequisites or inputs." : "No downstream tasks linked yet."}</p>;
  };
  return <div className="card influence">
    <div className="caps muted">Influence of this task</div><h3>{task.title}</h3>
    <div className="grid2"><div><h4>What feeds it · {chain.upstream.size}</h4>{relationList(chain.upstream, true)}</div>
      <div><h4>What it affects · {chain.downstream.size}</h4>{relationList(chain.downstream, false)}</div></div>
    <div className="q"><h4>Decisions and evidence</h4>
      <p className="muted small">Team assessments replace Orion's estimate for that dimension and change this task's ranking. Finishing a prerequisite removes its block. A debrief re-judges directly linked open tasks; more distant tasks are shown as possible knock-on effects.</p>
      {task.teamAnswers.map((answer) => <p className="small" key={`${answer.dim}-${answer.at}`}><span className="tag">Team assessment</span> {answer.who ?? "Team"}: {DIM_LABEL[answer.dim]} — {level(answer.level, answer.dim)} <span className="mono muted">{ago(answer.at)}</span></p>)}
      {evidence.map((t) => <div className="evidence" key={t.id}><a href={`#tasks/${t.id}`}>{t.title}</a>
        {t.debrief && <p className="small">Result: {String(t.debrief.result ?? "recorded").replaceAll("-", " ")}{t.debrief.lesson ? ` · Lesson: ${t.debrief.lesson}` : ""}</p>}
        {t.followup && <p className="small">Follow-up impact: {level(Number(t.followup.impact), "impact")}</p>}
      </div>)}
      {!task.teamAnswers.length && !evidence.length && <p className="muted small">No team assessments or completed-work evidence recorded in this chain yet. Open the task to correct an estimate, or finish work and record a debrief.</p>}
    </div>
    <a className="btn" href={`#tasks/${id}`}>{task.status === "done" ? "View finished task" : "Open task and its links"}</a>
  </div>;
}

// ---------------------------------------------------------------------------------------------- goals & learning

function Goals({ state, notify }: { state: State; notify: Notify }) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = async (name: string) => {
    const value = Number(edit[name]);
    if (!Number.isFinite(value)) return;
    await api("/api/metrics", "POST", { name, value });
    setEdit({ ...edit, [name]: "" }); notify("Updated.");
  };
  return (
    <>
      <div className="hero compact"><h1>Rung one: <em>someone pays</em>.</h1><p>First paying customers, then $50K collected. Update a number the moment it changes; the daily check-in asks too.</p></div>
      <section><Head n="01" title="Goal numbers" />
        <div className="cells grid3">
          {state.metrics.map((m) => (
            <div className="cell" key={m.name}>
              <div className="caps muted">{m.name}</div>
              <div className="metric"><b>{m.value === null ? "—" : m.value.toLocaleString()}</b><Spark values={m.history.map((h) => h.value)} /></div>
              <div className="mono muted">goal {m.goal.toLocaleString()} · {m.at ? `updated ${ago(m.at)}` : "never updated"}</div>
              <div className="progress"><i style={{ width: `${Math.min(100, ((m.value ?? 0) / m.goal) * 100)}%` }} /></div>
              <form className="inline" onSubmit={(e) => { e.preventDefault(); save(m.name); }}>
                <input type="number" inputMode="decimal" placeholder="New value" value={edit[m.name] ?? ""} onChange={(e) => setEdit({ ...edit, [m.name]: e.target.value })} />
                <button className="btn" type="submit" disabled={!edit[m.name]}>Save</button>
              </form>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Brief({ notify }: { notify: Notify }) {
  const [b, setB] = useState<{ text: string; who: string | null; at: string | null } | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => { api("/api/brief").then((x) => { setB(x); setDraft(x.text); }).catch(() => {}); }, []);
  if (!b) return null;
  const save = async () => { await api("/api/brief", "PUT", { text: draft }); setB({ ...b, text: draft, at: new Date().toISOString() }); notify("Brief saved. Review System for estimates that need a fresh judgment."); };
  return (
    <section><Head n="02" title="Company brief" right={<span className="mono muted">{b.at ? `edited ${ago(b.at)}${b.who ? ` by ${b.who}` : ""}` : "default"} · {draft.length}/4000</span>} />
      <p className="muted" style={{ marginTop: 0 }}>Orion judges every task against this. Keep it true: prices, goals, what is blocked.</p>
      <textarea className="brief" value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)} />
      <div className="chips" style={{ marginTop: 10 }}><button className="btn primary" disabled={draft === b.text} onClick={save}>Save brief</button></div>
    </section>
  );
}

function Learning({ state, notify }: { state: State; notify: Notify }) {
  const L = state.learning;
  return (
    <>
      <div className="hero compact"><h1>Every answer is <em>a data point</em> only we hold.</h1><p>Debriefs and check-ins compare what Orion expected with what happened. Here is how far off it has been.</p></div>
      <section><Head n="01" title="What Orion is learning" right={<a className="mono muted" href="/api/export">export {L.dataPoints} data points</a>} />
        <div className="grid2">
          <div>
            <table className="t">
              <thead><tr><th>Dimension</th><th>Data</th><th>Seen</th><th>Correction</th><th>Avg miss</th></tr></thead>
              <tbody>{Object.values(L.bias).map((b) => (
                <tr key={b.dim}><td>{DIM_LABEL[b.dim]}</td><td className="mono">{b.n}</td>
                  <td className="mono">{b.n ? `${b.raw > 0 ? "+" : ""}${b.raw} levels` : "—"}</td>
                  <td className="mono">{b.dim === "effort" ? (L.effort.n ? `×${L.effort.ratio} time` : "—") : b.n ? `${b.bias > 0 ? "+" : ""}${b.bias} levels` : "—"}</td>
                  <td className="mono">{b.n ? b.mae : "—"}</td></tr>))}</tbody>
            </table>
            <p className="muted small">“Seen” is the average gap between what happened and what Orion expected. The correction starts small and grows as the pattern repeats (shrinkage), so one surprising task can't swing the list. Effort is corrected as a ratio: ×1.5 means work takes half again as long as Orion thinks. “Calibrated” on the Tasks tab applies it.</p>
            <div className="caps muted" style={{ margin: "18px 0 8px" }}>Orion's track record</div>
            <table className="t"><tbody>
              <tr><td>Skill vs. a blind guess</td><td className="mono">{L.record.n ? `${L.record.skill > 0 ? "+" : ""}${Math.round(L.record.skill * 100)}%` : "—"}</td>
                <td className="muted small">{L.record.n ? `ranked probability score ${L.record.rps}, over ${L.record.n} outcomes` : "after the first debrief"}</td></tr>
              <tr><td>Fitted temperature</td><td className="mono">{L.temperature.n ? L.temperature.t : "—"}</td>
                <td className="muted small">{!L.temperature.n ? "after the first debrief" : L.temperature.t > 1.05 ? "Orion is too sure of itself; calibrated view softens it" : L.temperature.t < 0.95 ? "Orion is too timid; calibrated view sharpens it" : "about right"}</td></tr>
              <tr><td>Judgments logged</td><td className="mono">{L.judge.forecasts}</td>
                <td className="muted small">{L.judge.models.join(", ") || "none yet"}{L.judge.prompts > 1 ? ` · ${L.judge.prompts} question versions` : ""}</td></tr>
              <tr><td>Level-order disagreement</td><td className="mono">{L.judge.forecasts ? L.judge.orderDisagreement : "—"}</td>
                <td className="muted small">How much Jev's answer changes when the levels are reversed (0 = never). Near 0 means the second ordering can be dropped.</td></tr>
            </tbody></table>
            {L.outcomes.length > 0 && <p className="mono">{L.outcomes.map((o) => `${o.result.replace("-", " ")}: ${o.n}`).join(" · ")}</p>}
            <p className="muted small" style={{ marginTop: 18 }}>The agent lane learns separately and faster: see <a href="#agents">Agents</a>.</p>
          </div>
          <div>
            <div className="caps muted" style={{ marginBottom: 8 }}>Lessons, sent to Orion as context</div>
            {L.lessons.length ? L.lessons.map((l, i) => <div className="q" key={i}>{l}</div>) : <div className="empty">No lessons yet. They come from debriefs.</div>}
          </div>
        </div>
      </section>
      <Brief notify={notify} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------- adaptive planning

function Planner({ state, notify }: { state: State; notify: Notify }) {
  const a = state.automation;
  const [draft, setDraft] = useState<AutomationSettings>(a.settings);
  const [busy, setBusy] = useState(false);
  const saved = JSON.stringify(a.settings);
  useEffect(() => { setDraft(a.settings); }, [saved]);
  const change = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) => setDraft(d => ({ ...d, [key]: value }));
  const action = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await fn(); notify(message); } finally { setBusy(false); }
  };
  const running = a.runs.some(r => r.status === "running");
  return <>
    <div className="hero compact"><h1>Research, decide, <em>keep learning</em>.</h1><p>GPT-6 Luna reviews Compass and public research from Exa. It recommends what to do next and chooses when to look again. People retain approvals; Codex and Claude can read the plan and work through MCP.</p></div>
    <div className="card planner-status">
      <div className="chips"><span className={`why ${a.ready && a.settings.enabled ? "good" : "warn"}`}>{!a.ready ? "Providers not configured" : a.settings.enabled ? running ? "Planning now" : "Adaptive planning on" : "Paused"}</span><span className="mono muted">{a.model}</span></div>
      <p>{a.schedule ? `Next run: ${new Date(a.schedule.nextAt).toLocaleString()} · ${a.schedule.reason}` : a.ready ? "Resume when you want Compass to plan again." : "Configure OpenRouter and Exa as server secrets to enable planning."}</p>
      <p className="small muted">{a.usage.runs}/{a.settings.maxRunsPerDay} attempts today (UTC) · ${a.usage.reservedUsd.toFixed(3)} reserved / ${a.settings.dailyBudgetUsd.toFixed(2)} daily allowance · provider-reported cost {a.usage.reportedUsd === null ? "not reported yet" : `$${a.usage.reportedUsd.toFixed(4)}`}{a.usage.unreportedRuns ? ` · ${a.usage.unreportedRuns} attempt(s) without complete billing data` : ""}.</p>
      <div className="chips"><button className="btn primary" disabled={busy || !a.ready} onClick={() => action(() => api("/api/automation", "PUT", { ...a.settings, enabled: !a.settings.enabled }), a.settings.enabled ? "Planning paused. An in-flight result cannot change your workspace." : "Adaptive planning resumed.")}>{a.settings.enabled ? "Pause planning" : "Resume planning"}</button><button className="btn" disabled={busy || !a.ready || !a.settings.enabled || running} onClick={() => action(() => api("/api/automation/run", "POST", { retryFailed: ["error", "interrupted"].includes(a.runs[0]?.status) }), "Planning run queued within your limits.")}>{["error", "interrupted"].includes(a.runs[0]?.status) ? "Retry failed run" : "Run now"}</button><a className="btn ghost" href="/oauth/connections">Manage tool connections</a></div>
    </div>
    <DailyEmail notify={notify} />
    <section><Head n="02" title="Planning limits" />
      <form className="card planner-settings" onSubmit={e => { e.preventDefault(); action(() => api("/api/automation", "PUT", draft), "Planning guidance and limits saved."); }}>
        <div className="grid2"><label className="f"><span className="caps muted">Minimum minutes between runs</span><input type="number" min={15} max={1440} value={draft.minIntervalMinutes} onChange={e => change("minIntervalMinutes", Number(e.target.value))} /></label><label className="f"><span className="caps muted">Maximum minutes between runs</span><input type="number" min={15} max={1440} value={draft.maxIntervalMinutes} onChange={e => change("maxIntervalMinutes", Number(e.target.value))} /></label><label className="f"><span className="caps muted">Maximum attempts per UTC day</span><input type="number" min={1} max={24} value={draft.maxRunsPerDay} onChange={e => change("maxRunsPerDay", Number(e.target.value))} /></label><label className="f"><span className="caps muted">Daily planning allowance (USD)</span><input type="number" min={0.025} max={5} step={0.025} value={draft.dailyBudgetUsd} onChange={e => change("dailyBudgetUsd", Number(e.target.value))} /></label></div>
        <label className="f q"><span className="caps muted">Guidance for Compass</span><textarea maxLength={2000} value={draft.guidance} onChange={e => change("guidance", e.target.value)} /></label>
        <label className="f q"><span className="caps muted">Public research query (sent to Exa)</span><input type="text" minLength={5} maxLength={200} value={draft.researchQuery} onChange={e => change("researchQuery", e.target.value)} /></label>
        <p className="small muted">Every attempt reserves ${a.reservationPerRunUsd.toFixed(3)}, including failures. Run now uses the same interval and allowance. A person can retry a failed run after one minute; the daily allowance still applies. The model cannot raise your limits, approve work or alter goal measurements. This allowance covers planning calls; task judgments and other applications using these keys have separate usage.</p>
        <button className="btn" disabled={busy || JSON.stringify(draft) === saved}>Save planning settings</button>
      </form>
    </section>
    <section><Head n="03" title="Research and planning history" />
      {!a.runs.length && <div className="empty">No planning runs yet. Once configured and enabled, the first run will appear here.</div>}
      <div className="stack">{a.runs.map(r => <article className="card plan-run" key={r.id}>
        <div className="needhead"><span className={`why ${r.status === "complete" ? "good" : r.status === "running" ? "info" : "warn"}`}>{r.status}</span><span className="mono muted">{new Date(r.at).toLocaleString()}</span><span className="mono muted right">{r.reportedUsd === null ? "Billing incomplete" : `$${r.reportedUsd.toFixed(4)} reported`}</span></div>
        {r.error && <p>{r.error}</p>}
        {r.plan && <><h3>{r.plan.summary}</h3>{r.status !== "complete" && <p className="why warn">Retained for context. The workspace or human settings changed during this run.</p>}
          <p className="small muted">Next review requested in {r.plan.nextRunMinutes} minutes: {r.plan.nextRunReason}</p>
          {r.plan.recommendations.map((n, i) => <div className="q" key={i}><a href={`#tasks/${n.taskId}`}>{state.list.find(t => t.id === n.taskId)?.title ?? "View task"}</a>{n.requiresHuman && <span className="why warn">Needs a person</span>}<p>{n.reason}</p><p><strong>Next step:</strong> {n.nextStep}</p><div className="chips">{n.sourceUrls.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{new URL(url).hostname}</a>)}</div></div>)}
          {r.plan.humanNeeds.map((n, i) => <div className="q" key={i}><span className="why warn">{KINDS[n.kind].split(":")[0]}</span><p>{n.need}</p>{n.taskId && <a href={`#tasks/${n.taskId}`}>Open task</a>}</div>)}
          {r.plan.proposals.map((p, i) => <div className="q" key={i}><h4>Proposed: {p.title}</h4><p>{p.detail}</p><p className="small"><strong>Done when:</strong> {p.doneWhen}</p>{r.accepted[String(i)] ? <a href={`#tasks/${r.accepted[String(i)]}`}>Open adopted task</a> : <button className="btn" disabled={busy || r.status !== "complete"} onClick={() => action(() => api(`/api/automation/${r.id}/proposals/${i}/accept`, "POST"), "Proposal added to the agent lane for execution.")}>Add to agent lane</button>}</div>)}
        </>}
        {!!r.evidence.length && <details className="q"><summary>Public research · {r.evidence.length} sources</summary>{r.evidence.map(e => <div className="q" key={e.url}><a href={e.url} target="_blank" rel="noreferrer">{e.title}</a>{e.publishedAt && <span className="mono muted"> · {e.publishedAt.slice(0, 10)}</span>}<p className="small muted">{e.text}</p></div>)}</details>}
      </article>)}</div>
    </section>
  </>;
}

// ---------------------------------------------------------------------------------------------- projects

type Scan = ReturnType<typeof scanStatus>;
const SEVERITY_TONE = { high: "warn", medium: "info", low: "" } as const;
const pctOf = (p: number | null) => p === null ? "?" : `${Math.round(p * 100)}%`;

/** Every project, the context pulled from where the work happens, and the scan's proposals for people to adopt. */
function Projects({ state, notify }: { state: State; notify: Notify }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => { api("/api/scan").then(setScan); }, []);
  useEffect(() => { load(); }, [load, state.list.length]);
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await fn(); notify(message); load(); } finally { setBusy(false); }
  };
  const active = state.projects.filter(p => p.status === "active");
  const others = state.projects.filter(p => p.status !== "active");
  const last = scan?.runs[0];
  const assessment = (id: string) => scan?.runs.find(r => r.status === "complete")?.assessments.find(a => a.projectId === id)?.assessment;
  return <>
    <div className="hero compact"><h1>Every project, <em>one list</em>.</h1><p>Context from your machines (git, Claude and Codex sessions), GitHub, live sites and the agents' own reports. GPT-6 Luna reads it all and proposes work; Orion judges and ranks each proposal against today's list. You decide what goes on it.</p></div>

    <section><Head n="01" title="What Compass proposes" right={scan ? <span className="mono muted">{scan.usage.runs} scan(s) today · ${scan.usage.usedUsd.toFixed(3)} of ${scan.settings.dailyBudgetUsd.toFixed(2)}</span> : null} />
      <div className="card">
        <div className="chips">
          <span className={`why ${!scan?.ready ? "warn" : last?.status === "error" ? "warn" : "good"}`}>{!scan ? "Loading…" : !scan.ready ? "OpenRouter not configured" : last ? `Last scan ${last.status} · ${new Date(last.at).toLocaleString()}` : "No scan yet"}</span>
          {scan?.settings.enabled && <span className="mono muted">daily after {String(scan.settings.hourUtc).padStart(2, "0")}:00 UTC</span>}
          <span className="spacer" />
          <button className="btn primary" disabled={busy || !scan?.ready || !active.length} onClick={() => act(() => api("/api/scan/run", "POST"), "Scan finished. Proposals are ranked below.")}>{busy ? "Scanning…" : "Scan now"}</button>
        </div>
        {last?.error && <p className="why warn">{last.error}</p>}
        {last?.overview && <p>{last.overview}</p>}
        {scan && <ScanSettings scan={scan} onSaved={() => { load(); notify("Scan settings saved."); }} />}
      </div>
      <div className="stack">
        {scan?.proposals.map(c => <Proposal key={c.id} c={c} busy={busy} act={act} />)}
        {scan && !scan.proposals.length && <div className="empty">No open proposals. {active.length ? "Run a scan, or wait for the daily one." : "Projects appear once compass-sync or an agent reports context."}</div>}
      </div>
    </section>

    <section><Head n="02" title="Projects" right={<button className="btn ghost" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Add project"}</button>} />
      {adding && <ProjectForm onDone={(id) => { setAdding(false); if (id) notify("Project added."); }} />}
      <div className="stack">{active.map(p => <ProjectCard key={p.id} p={p} assessment={assessment(p.id)} notify={notify} />)}</div>
      {!active.length && !adding && <div className="empty">No projects yet. Run <code>bun scripts/compass-sync.ts</code> on a machine, or add one.</div>}
      {!!others.length && <button className="linkish" onClick={() => setShowAll(!showAll)}>{showAll ? "Hide" : "Show"} {others.length} paused or archived</button>}
      {showAll && <div className="stack">{others.map(p => <ProjectCard key={p.id} p={p} notify={notify} />)}</div>}
    </section>

    <section><Head n="03" title="Feeding Compass" /><div className="card small">
      <p><b>This machine:</b> <code>bun scripts/compass-sync.ts --dry-run</code> shows exactly what is sent (metadata only: branches, counts, commit subjects, session titles and first prompts, scrubbed). Schedule it hourly with cron.</p>
      <p><b>Codex / Claude:</b> connect to <code>{location.origin}/mcp</code> with write permission and schedule a task: “review each repository you work in and call <code>compass_report_context</code> with its summary, state, risks and next steps.” Reports replace the previous one per agent and project.</p>
      <p><b>GitHub and sites:</b> the server checks live sites every 15 minutes and refreshes GitHub every 30 when <code>GITHUB_TOKEN</code> is set.</p>
    </div></section>
  </>;
}

function Proposal({ c, busy, act }: { c: CandidateView; busy: boolean; act: (fn: () => Promise<unknown>, msg: string) => Promise<void> }) {
  return <article className="card proposal">
    <div className="needhead">
      {c.projectId && <span className="tag">{projectName(c.projectId) ?? c.projectId}</span>}
      {c.moat?.worthy && <span className="why good" title={`Orion: ${pctOf(c.moat.p)} that it clearly makes Archymedes harder to copy`}>◆ moat-worthy</span>}
      {c.bold && <span className="why info">bold bet</span>}
      <span className={`why ${c.lane === "agent" ? "info" : ""}`}>{c.lane === "agent" ? "agent lane" : "team lane"}</span>
      <span className="mono muted right">{c.judged && c.rank !== null ? `would rank #${c.rank} of ${c.ofTotal} · top 5 in ${pctOf(c.pTop5)}${c.rankRange ? ` · likely #${c.rankRange[0]}–#${c.rankRange[1]}` : ""}` : c.judgeError ? "not judged" : "judging…"}</span>
    </div>
    <h3>{c.title}</h3>
    <p>{c.why}</p>
    {c.detail && <p className="muted small">{c.detail}</p>}
    <p className="small"><b>Done when:</b> {c.doneWhen}</p>
    {!!c.steps.length && <ol className="small">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
    {!!c.evidence.length && <div className="chips">{c.evidence.map((e, i) => <span key={i} className="mono muted small">· {e}</span>)}</div>}
    {c.judgeError && <p className="why warn small">Orion could not judge this: {c.judgeError}. Adopting it queues a fresh judgment.</p>}
    <div className="chips">
      <button className="btn primary" disabled={busy} onClick={() => act(() => api(`/api/scan/candidates/${c.id}/adopt`, "POST", {}), c.lane === "agent" ? "Added to the agent lane." : "Added to the team's list.")}>Adopt</button>
      <button className="btn" disabled={busy} onClick={() => act(() => api(`/api/scan/candidates/${c.id}/adopt`, "POST", { lane: c.lane === "agent" ? "team" : "agent" }), "Added.")}>Adopt to {c.lane === "agent" ? "team" : "agents"}</button>
      <button className="btn ghost" disabled={busy} onClick={() => act(() => api(`/api/scan/candidates/${c.id}/dismiss`, "POST", {}), "Dismissed.")}>Dismiss</button>
    </div>
  </article>;
}

function ScanSettings({ scan, onSaved }: { scan: Scan; onSaved: () => void }) {
  const [d, setD] = useState(scan.settings);
  const saved = JSON.stringify(scan.settings);
  useEffect(() => { setD(scan.settings); }, [saved]);
  return <details className="q"><summary className="caps muted">Scan settings</summary>
    <form onSubmit={async e => { e.preventDefault(); await api("/api/scan", "PUT", d); onSaved(); }}>
      <div className="grid2">
        <label className="f"><span className="caps muted">Daily scan</span><select value={d.enabled ? "on" : "off"} onChange={e => setD({ ...d, enabled: e.target.value === "on" })}><option value="on">On</option><option value="off">Off (manual only)</option></select></label>
        <label className="f"><span className="caps muted">After (UTC hour)</span><input type="number" min={0} max={23} value={d.hourUtc} onChange={e => setD({ ...d, hourUtc: Number(e.target.value) })} /></label>
        <label className="f"><span className="caps muted">Daily allowance (USD)</span><input type="number" min={scan.reservationUsd} max={2} step={0.01} value={d.dailyBudgetUsd} onChange={e => setD({ ...d, dailyBudgetUsd: Number(e.target.value) })} /></label>
      </div>
      <label className="f q"><span className="caps muted">What to look for</span><textarea maxLength={2000} value={d.guidance} onChange={e => setD({ ...d, guidance: e.target.value })} /></label>
      <p className="small muted">Each scan reserves ${scan.reservationUsd.toFixed(2)} for GPT-6 Luna, plus one Jev judgment per proposal (at most 8). Set the scan an hour before the daily email so the email carries fresh proposals.</p>
      <button className="btn" disabled={JSON.stringify(d) === saved}>Save</button>
    </form>
  </details>;
}

function ProjectCard({ p, assessment, notify }: { p: ProjectView; assessment?: string; notify: Notify }) {
  const [editing, setEditing] = useState(false);
  const report = p.reports[0];
  const makeTask = async (t: { title: string; detail: string }) => {
    const r = await api("/api/tasks", "POST", { title: t.title, detail: t.detail, projectId: p.id });
    notify("Task added. Orion is judging it."); location.hash = `tasks/${r.id}`;
  };
  return <article className="card project">
    <div className="needhead">
      <h3 style={{ margin: 0 }}>{p.name}</h3>
      {p.status !== "active" && <span className="why">{p.status}</span>}
      <span className="mono muted">{p.openTasks} open · {p.doneTasks} done{p.lastActivity ? ` · active ${ago(p.lastActivity)}` : ""}</span>
      <span className="spacer" />
      <a className="linkish" href="#tasks" onClick={() => store.set("compass.project", p.id)}>tasks</a>
      <button className="linkish" onClick={() => setEditing(!editing)}>{editing ? "close" : "edit"}</button>
    </div>
    {editing && <ProjectForm p={p} onDone={() => { setEditing(false); notify("Project saved."); }} />}
    {p.brief && <p className="muted small">{p.brief}</p>}
    {assessment && <p><b>Scan:</b> {assessment}</p>}
    {p.attention.map((a, i) => <div className="q attention" key={i}>
      <span className={`why ${SEVERITY_TONE[a.severity]}`}>{a.severity}</span> {a.text}
      {a.task && <> <button className="linkish" onClick={() => makeTask(a.task!)}>make it a task</button></>}
    </div>)}
    {report && <div className="q"><span className="caps muted">{report.who.replace(" (agent)", "")} reported {ago(report.at)}</span><p>{report.summary}</p>
      {report.state && <p className="small"><b>State:</b> {report.state}</p>}
      {!!report.risks.length && <p className="small"><b>Risks:</b> {report.risks.join(" · ")}</p>}
      {!!report.nextSteps.length && <p className="small"><b>Next:</b> {report.nextSteps.join(" · ")}</p>}
    </div>}
    <details className="q"><summary className="caps muted">Context · {p.github.length} repo · {p.git.length} working cop{p.git.length === 1 ? "y" : "ies"} · {p.sessions.length} session(s) · {p.siteChecks.length} site(s)</summary>
      {p.github.map(g => <div key={g.repo} className="q small">
        <a href={`https://github.com/${g.repo}`} target="_blank" rel="noreferrer">{g.repo}</a>{g.ci && <> · <a href={g.ci.url} target="_blank" rel="noreferrer" className={`why ${g.ci.conclusion === "success" ? "good" : g.ci.conclusion ? "warn" : "info"}`}>{g.ci.name}: {g.ci.conclusion ?? g.ci.status}</a></>}
        <ul>{g.commits.slice(0, 3).map(c => <li key={c.sha} className="mono">{c.at.slice(0, 10)} {c.subject}</li>)}</ul>
        {!!g.openPrs.length && <p>Open PRs: {g.openPrs.map(pr => <a key={pr.number} href={`https://github.com/${g.repo}/pull/${pr.number}`} target="_blank" rel="noreferrer">#{pr.number} {pr.title} </a>)}</p>}
      </div>)}
      {p.git.map(g => <p key={`${g.machine}${g.path}`} className="mono small">{g.machine}:{g.path} · {g.branch ?? "detached"} · {g.dirty} uncommitted{g.ahead ? ` · ${g.ahead} unpushed` : g.ahead === null ? " · no upstream" : ""}{g.lastCommitAt ? ` · last commit ${ago(g.lastCommitAt)}` : ""}</p>)}
      {p.sessions.map((x, i) => <p key={i} className="small"><span className="mono muted">{x.source} · {ago(x.at)}</span> {x.title}</p>)}
      {p.siteChecks.map(x => <p key={x.url} className="small"><span className={`why ${x.ok ? "good" : "warn"}`}>{x.ok ? `${x.status} · ${x.ms} ms` : `down · ${x.status || x.error}`}</span> {x.url}</p>)}
    </details>
  </article>;
}

function ProjectForm({ p, onDone }: { p?: ProjectView; onDone: (id?: string) => void }) {
  const [f, setF] = useState({ name: p?.name ?? "", brief: p?.brief ?? "", repos: (p?.repos ?? []).join("\n"), sites: (p?.sites ?? []).join("\n"), status: p?.status ?? "active" });
  const lines = (s: string) => s.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name: f.name, brief: f.brief, repos: lines(f.repos), sites: lines(f.sites), status: f.status };
    if (p) { await api(`/api/projects/${p.id}`, "PATCH", body); onDone(p.id); }
    else onDone((await api("/api/projects", "POST", body)).id);
  };
  return <form className="card editor" onSubmit={submit}>
    <div className="grid2">
      <label className="f"><span className="caps muted">Name</span><input type="text" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
      <label className="f"><span className="caps muted">Status</span><select value={f.status} onChange={e => setF({ ...f, status: e.target.value as typeof f.status })}><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived (ignore its context)</option></select></label>
      <label className="f"><span className="caps muted">GitHub repositories (owner/name, one per line)</span><textarea value={f.repos} onChange={e => setF({ ...f, repos: e.target.value })} /></label>
      <label className="f"><span className="caps muted">Live sites (https, one per line)</span><textarea value={f.sites} onChange={e => setF({ ...f, sites: e.target.value })} /></label>
    </div>
    <label className="f q"><span className="caps muted">Project brief (Orion judges this project's tasks against it and the company brief)</span><textarea maxLength={3000} value={f.brief} onChange={e => setF({ ...f, brief: e.target.value })} placeholder="What it is, who it is for, what success looks like now." /></label>
    <div className="chips"><button className="btn primary">{p ? "Save" : "Add project"}</button><button type="button" className="btn ghost" onClick={() => onDone()}>Cancel</button></div>
  </form>;
}

/** The daily email: one per founder, their own focus and next tasks plus shared alerts and proposals. */
function DailyEmail({ notify }: { notify: Notify }) {
  const [st, setSt] = useState<ReturnType<typeof digestStatus> | null>(null);
  const [d, setD] = useState<{ enabled: boolean; sendHourUtc: number; recipients: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const load = useCallback(() => { api("/api/digest").then((s) => { setSt(s); setD({ ...s.settings, recipients: Object.fromEntries(TEAM.map(n => [n, s.settings.recipients[n] ?? ""])) }); }); }, []);
  useEffect(() => { load(); }, [load]);
  if (!st || !d) return null;
  const today = new Date().toISOString().slice(0, 10);
  return <section><Head n="01" title="Daily email" />
    <form className="card" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api("/api/digest", "PUT", d); notify("Email settings saved."); load(); } finally { setBusy(false); } }}>
      <p className="small muted">Each person gets their own list: their focus and next tasks, what needs them, project alerts, Compass's strongest proposals with Orion's odds, and what the agents are doing. Built from Compass's data with a fixed template (no model cost).</p>
      <div className="grid2">
        {TEAM.map(n => <label className="f" key={n}><span className="caps muted">{n}'s address</span><input type="email" value={d.recipients[n] ?? ""} onChange={e => setD({ ...d, recipients: { ...d.recipients, [n]: e.target.value } })} placeholder="leave empty for no email" /></label>)}
        <label className="f"><span className="caps muted">Send after (UTC hour)</span><input type="number" min={0} max={23} value={d.sendHourUtc} onChange={e => setD({ ...d, sendHourUtc: Number(e.target.value) })} /></label>
        <label className="f"><span className="caps muted">Daily sending</span><select value={d.enabled ? "on" : "off"} onChange={e => setD({ ...d, enabled: e.target.value === "on" })}><option value="on">On</option><option value="off">Off</option></select></label>
      </div>
      <div className="chips">
        <span className={`why ${st.configured ? "good" : "warn"}`}>{st.configured ? `Resend configured${st.from ? ` · from ${st.from}` : ""}` : "RESEND_API_KEY not set on the server"}</span>
        {Object.entries(st.sent).map(([n, s]) => <span key={n} className="mono muted small">{n}: {s.day === today ? s.sentAt ? `sent ${new Date(s.sentAt).toLocaleTimeString()}` : `failed (${s.attempts}×) ${s.error ?? ""}` : `last ${s.day}`}</span>)}
        <span className="spacer" />
        <button className="btn" disabled={busy}>Save</button>
        <button type="button" className="btn ghost" onClick={async () => setPreview(preview ? null : (await api("/api/digest/preview")).text)}>{preview ? "Hide preview" : "Preview mine"}</button>
        <button type="button" className="btn primary" disabled={busy || !st.configured} onClick={async () => { setBusy(true); try { await api("/api/digest/send", "POST"); notify("Sent you today's email."); load(); } finally { setBusy(false); } }}>Send me today's now</button>
      </div>
      {preview && <pre className="q small" style={{ whiteSpace: "pre-wrap" }}>{preview}</pre>}
    </form>
  </section>;
}

// ---------------------------------------------------------------------------------------------- workspace health

function System({ state, notify }: { state: State; notify: Notify }) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const h = state.health;
  const retry = async (id: string) => {
    setRetrying(id);
    try { await api(`/api/tasks/${id}/judge`, "POST"); notify("Queued a fresh judgment. This uses the judgment provider."); }
    finally { setRetrying(null); }
  };
  const review = state.list.filter(t => t.judge === "error" || (t.judgedBriefHash && t.judgedBriefHash !== h.brief.hash));
  return <>
    <div className="hero compact"><h1>Keep the system <em>honest</em>.</h1><p>Missing evidence, work that needs attention, and connections to other tools. Unknown goal numbers stay unknown.</p></div>
    <div className="stats">{[["Open", h.counts.open], ["In progress", h.counts.doing], ["Blocked", h.counts.blocked], ["Judgments queued", h.counts.pendingJudgments], ["Need a retry", h.counts.failedJudgments]].map(([label, n]) => <div className="stat" key={label}><span className="caps muted">{label}</span><span className="v">{n}</span></div>)}</div>
    <section><Head n="01" title="Workspace health" right={<span className="mono muted">checked {new Date(h.at).toLocaleTimeString()}</span>} />
      {h.issues.length ? <div className="health-grid">{h.issues.map(i => <article className="card health-issue" key={i.key}>
        <span className={`why ${i.severity === "attention" ? "warn" : "info"}`}>{i.count} · {i.severity === "attention" ? "Needs attention" : "Review"}</span><h3>{i.title}</h3><p>{i.detail}</p>
        {!!i.tasks.length && <ul>{i.tasks.map(t => <li key={t.id}><a href={`#tasks/${t.id}`}>{t.title}</a></li>)}</ul>}
        {i.href !== "#system" && <a className="btn ghost" href={i.href}>Review</a>}
      </article>)}</div> : <p className="muted">No workspace issues detected by these checks.</p>}
    </section>
    <section><Head n="02" title="Judgments to review" />
      <p className="muted">Refreshing a judgment uses the provider. Existing scores stay visible while queued; estimates are applied only to the task revision that was judged.</p>
      {review.length ? review.map(t => <div className="card judgment-review" key={t.id}><div><a href={`#tasks/${t.id}`}>{t.title}</a><p className="small muted">{t.judgeError || "Judged against an earlier company brief"}</p></div><button className="btn" disabled={!!retrying || t.judge === "pending"} onClick={() => retry(t.id)}>{t.judge === "pending" ? "Queued" : retrying === t.id ? "Queuing…" : "Re-judge"}</button></div>) : <p className="muted">No failed judgments or known brief mismatches. Older estimates without recorded provenance are listed above.</p>}
    </section>
    <section><Head n="03" title="Connections and data" /><div className="card">
      <p>Connect a tool with OAuth at <code>{location.origin}/mcp</code>. Connections start with read permission; agent writes require a separate scope.</p>
      <div className="chips"><a className="btn" href="/oauth/connections">Manage MCP connections</a><a className="btn" href="/api/export">Export workspace data</a><a className="btn ghost" href="#learning">Review the company brief</a></div>
      <p className="muted small">An export is a manual copy. Scheduled backups and a tested restore are still needed. New work captures its forecast when started; legacy outcomes are kept as recorded.</p>
    </div></section>
  </>;
}

// ---------------------------------------------------------------------------------------------- shell

function Login({ onIn }: { onIn: (m: { who: string; team: string[] }) => void }) {
  const [name, setName] = useState("");
  const [passphrase, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/api/login", "POST", { name, passphrase }); onIn(await api("/api/me")); }
    catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
  };
  return (
    <div className="wrap">
      <header className="top"><div className="mark" /><span className="word">Compass</span><span className="mono muted hide-sm">Task Management System</span><span className="spacer" /><ThemePicker /></header>
      <div className="hero"><h1>Paid, good and <em>hard to copy</em>.</h1><p>Sign in to see what Orion puts first today.</p></div>
      <form onSubmit={submit} className="login">
        <label className="f"><span className="caps muted">Name</span><input type="text" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="f"><span className="caps muted">Passphrase</span><input type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPass(e.target.value)} /></label>
        {err && <p className="why warn">{err}</p>}
        <button className="btn primary" type="submit">Sign in</button>
      </form>
    </div>
  );
}

type Tab = "today" | "tasks" | "projects" | "agents" | "flow" | "goals" | "learning" | "system" | "planner" | "conversation";
const parseHash = (): { tab: Tab; id: string | null } => {
  const [tab, id] = location.hash.replace(/^#/, "").split("/");
  return { tab: (["today", "tasks", "projects", "agents", "flow", "goals", "learning", "system", "planner", "conversation"].includes(tab) ? tab : "today") as Tab, id: id || null };
};

function App() {
  const [who, setWho] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [calibrated, setCal] = useState(store.get("compass.calibrated") === "1");
  const [state, setState] = useState<State | null>(null);
  const [route, setRoute] = useState(parseHash());
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => { const f = () => setRoute(parseHash()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  useEffect(() => {
    scrollTo({ top: 0 });
    const tab = document.querySelector<HTMLElement>(".tabs .on"), nav = tab?.parentElement;
    if (tab && nav) nav.scrollTo({ left: Math.max(0, tab.offsetLeft - nav.offsetLeft - 16) });
  }, [route.tab, !!state]);
  const refresh = useCallback(() => {
    if (!who) return;
    const sequence = ++refreshSequence.current;
    api(`/api/state?calibrated=${calibrated ? "1" : "0"}`).then((s) => { if (sequence === refreshSequence.current) { setState(s); setError(null); } })
      .catch((e) => { if (sequence !== refreshSequence.current) return; if (e instanceof SignedOut) { setWho(null); setState(null); setSignedOut(true); } else setError(String(e.message ?? e)); });
  }, [who, calibrated]);
  useEffect(() => { api("/api/me").then((m) => { TEAM = m.team; setWho(m.who); }).catch(() => setSignedOut(true)); }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 10_000);
    addEventListener("focus", refresh);
    return () => { refreshSequence.current++; clearInterval(t); removeEventListener("focus", refresh); };
  }, [refresh]);
  useEffect(() => {
    const failed = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      if (event.reason instanceof SignedOut) { refreshSequence.current++; setWho(null); setState(null); setSignedOut(true); }
      else setActionError(`Action failed: ${String(event.reason?.message ?? event.reason)}`);
    };
    addEventListener("unhandledrejection", failed);
    return () => removeEventListener("unhandledrejection", failed);
  }, []);
  const notify: Notify = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500); refresh(); };
  const setCalibrated = (v: boolean) => { setCal(v); store.set("compass.calibrated", v ? "1" : "0"); };

  if (signedOut && !who) return <Login onIn={(m) => { TEAM = m.team; setSignedOut(false); setWho(m.who); }} />;
  if (!state) return <div className="wrap"><header className="top"><div className="mark busy" /><span className="word">Compass</span><span className="mono muted hide-sm">Task Management System</span><span className="spacer" /><ThemePicker /></header><p className="muted" style={{ padding: "40px 0" }}>{error ?? "Loading…"}</p></div>;

  PROJECTS = state.projects.map(p => ({ id: p.id, name: p.name, status: p.status }));
  const alerts = state.projects.reduce((n, p) => n + p.attention.filter(a => a.severity === "high").length, 0);
  const q = state.questions;
  // Today counts what a person answers there; the Agents tab counts the agents' requests.
  const asks = q.debriefs.length + (q.daily ? 1 : 0) + state.interventions.open.length + state.agentLearning.unreviewed.length + (state.agentUpdates?.items.length ? 1 : 0);
  const busy = state.list.some((t) => t.judge === "pending");
  const tabs: [Tab, string, ReactNode][] = [
    ["today", "Today", asks ? <b className="badge">{asks}</b> : null],
    ["conversation", "Talk to Compass", null],
    ["tasks", "Team", <span className="mono muted">{state.lanes.team.length}</span>],
    ["projects", "Projects", alerts ? <b className="badge">{alerts}</b> : <span className="mono muted">{state.projects.filter(p => p.status === "active").length}</span>],
    ["agents", "Agents", state.interventions.open.length ? <b className="badge">{state.interventions.open.length}</b> : <span className="mono muted">{state.lanes.agent.length}</span>],
    ["flow", "Flow", <span className="mono muted">{state.links.length}</span>],
    ["goals", "Goals", null],
    ["learning", "Learning", <span className="mono muted">{state.learning.dataPoints}</span>],
    ["planner", "Planner", state.automation.settings.enabled ? <span className="mono muted">on</span> : null],
    ["system", "System", state.health.issues.some(i => i.severity === "attention") ? <b className="badge">{state.health.issues.filter(i => i.severity === "attention").length}</b> : null],
  ];
  return (
    <div className="wrap">
      <header className="top">
        <div className={`mark ${busy ? "busy" : ""}`} title={busy ? "Orion is judging" : undefined} /><span className="word">Compass</span><span className="mono muted hide-sm">Task Management System</span>
        
        <span className="spacer" />
        <ThemePicker />
        <span className="team hide-sm">{TEAM.map((p) => <span key={p} className={q.checkedToday.includes(p) ? "in" : ""} title={q.checkedToday.includes(p) ? "Checked in today" : "Not checked in yet"}>{p}</span>)}</span>
        <span className="caps">{who}</span>
        <button className="btn ghost" onClick={async () => { await api("/api/logout", "POST"); refreshSequence.current++; setWho(null); setState(null); setSignedOut(true); }}>Sign out</button>
      </header>
      <nav className="tabs">{tabs.map(([k, l, extra]) => <a key={k} href={`#${k}`} className={route.tab === k ? "on" : ""}>{l} {extra}</a>)}</nav>
      {(error || actionError) && <div className="error-banner" role="alert"><span>{actionError || error}</span><button className="btn ghost" onClick={() => { setError(null); setActionError(null); }}>Dismiss</button></div>}
      <main>
        {route.tab === "today" && <Today state={state} refresh={refresh} notify={notify} />}
        {route.tab === "conversation" && <Conversation request={api} onUpdated={refresh} />}
        {route.tab === "tasks" && <Tasks state={state} openId={route.id} refresh={refresh} notify={notify} calibrated={calibrated} setCalibrated={setCalibrated} />}
        {route.tab === "projects" && <Projects state={state} notify={notify} />}
        {route.tab === "agents" && <Agents state={state} notify={notify} />}
        {route.tab === "flow" && <Flow state={state} />}
        {route.tab === "goals" && <Goals state={state} notify={notify} />}
        {route.tab === "learning" && <Learning state={state} notify={notify} />}
        {route.tab === "system" && <System state={state} notify={notify} />}
        {route.tab === "planner" && <Planner state={state} notify={notify} />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
