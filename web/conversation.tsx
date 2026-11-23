import { Markdown } from "../src/markdown.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { conversationHistory, ConversationSettings } from "../src/conversation-store.ts";
import type { conversationStatus } from "../src/conversations.ts";

type Conversation = ReturnType<typeof conversationHistory> & ReturnType<typeof conversationStatus>;
type RequestApi = (path: string, method?: string, body?: unknown) => Promise<any>;
export function Conversation({ request, onUpdated }: { request: RequestApi; onUpdated: () => void }) {
  const [data, setData] = useState<Conversation | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ConversationSettings | null>(null);
  const requestId = useRef<string | null>(null), version = useRef(""), sequence = useRef(0), log = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const next = await request(`/api/conversation${selected ? `?thread=${encodeURIComponent(selected)}` : ""}`) as Conversation;
      if (seq !== sequence.current) return;
      const signature = JSON.stringify(next.messages.map(m => [m.id, m.status, m.changes]));
      if (version.current && version.current !== signature) onUpdated();
      version.current = signature;
      setData(next); setSettings(s => s ?? next.settings);
    } catch (e) { if (seq === sequence.current) setError(e instanceof Error ? e.message : "Cannot load conversation"); }
  }, [request, selected, onUpdated]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => { sequence.current++; clearInterval(timer); };
  }, [refresh]);
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true); setError(null); requestId.current ??= crypto.randomUUID();
    try {
      const result = await request("/api/conversation", "POST", { text: draft, requestId: requestId.current, threadId: selected === "" ? undefined : selected ?? data?.threadId ?? undefined });
      setSelected(result.threadId); setDraft(""); requestId.current = null;
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Message could not be sent. Retry to send it once."); }
    finally { setSending(false); }
  };
  const messages = selected === "" ? [] : data?.messages ?? [];
  const lastMessage = messages.at(-1);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [lastMessage?.id, lastMessage?.status]);
  return <>
    <div className="hero compact"><h1>Your list, <em>in conversation.</em></h1><p>Tell Compass what happened or what needs to change. Luna updates clear requests, asks about anything ambiguous, and keeps the list in sync.</p></div>
    <div className="conversation-layout">
      <section className="card conversation-main">
        <div className="needhead"><label className="f"><span className="caps muted">Conversation</span><select aria-label="Conversation" disabled={sending} value={selected ?? data?.threadId ?? ""} onChange={e => { setSelected(e.target.value); setError(null); }}>
          <option value="">New conversation</option>
          {(data?.threads ?? []).map(t => <option key={t.id} value={t.id}>{t.channel === "email" ? "Email briefing" : "In Compass"} · {new Date(t.createdAt).toLocaleString()}</option>)}
        </select></label><span className="why info">GPT-6 Luna</span></div>
        <div className="conversation-log" ref={log} role="log" aria-label="Messages with Compass" aria-live="polite">
          {!messages.length && <div className="empty"><p>Start with a task title and tell me what changed.</p><p className="small muted">“I finished the release review.”<br />“Add a task to interview three customers.”<br />“What is blocking my next task?”</p></div>}
          {messages.map(m => <article key={m.id} className="conversation-turn">
            <div className="conversation-human"><div className="caps muted">You · {m.source === "email" ? "email reply" : "in Compass"} · {new Date(m.at).toLocaleTimeString()}</div><Markdown>{m.text}</Markdown></div>
            <div className="conversation-luna"><div className="caps muted">Luna {m.status === "queued" || m.status === "working" ? "· reading your update…" : ""}</div>
              {m.response && <Markdown>{m.response}</Markdown>}
              {m.error && <p className="why warn">{m.error}</p>}
              {!!m.changes.length && <div className="chips">{m.changes.map((c: { taskId?: string; projectId?: string; summary: string }, i: number) => <a className="chip" key={i} href={c.taskId ? `#tasks/${c.taskId}` : "#projects"}>{c.summary} ↗</a>)}</div>}
              {m.source === "email" && m.replySentAt && <span className="small muted">Confirmation sent by email</span>}
            </div>
          </article>)}
        </div>
        <form onSubmit={send} className="conversation-composer">
          <label className="f"><span className="caps muted">Tell Compass</span><textarea aria-label="Message Compass" disabled={sending} placeholder="What changed? What should happen next?" value={draft} maxLength={12000} onChange={e => { setDraft(e.target.value); requestId.current = null; }} /></label>
          {error && <p className="why warn" role="alert">{error}</p>}
          <div className="needhead"><span className="small muted">Changes save automatically. Your task list stays current.</span><button className="btn primary" disabled={sending || !draft.trim() || !data?.configured || !data.settings.enabled}>{sending ? "Sending…" : "Send update →"}</button></div>
        </form>
      </section>
      <aside className="card conversation-aside">
        <h3>Reply from your inbox</h3>
        <p className="small">{data?.emailReady ? "Reply to your next Compass briefing in plain text. Luna will respond with the changes it saved, or a question. You can keep replying." : "Email replies are being connected. You can talk to Compass here in the meantime."}</p>
        {data?.emailSetupError && <p className="why warn">{data.emailSetupError}</p>}
        {data && !data.configured && <p className="why warn">The conversation model needs to be configured.</p>}
        <p className="small muted">Updates can mark progress, revise a task, add work, or save project context. Approvals and other people’s assignments stay under their control.</p>
        {settings && <details><summary className="caps muted">Automation controls</summary><div className="conversation-controls">
          <label><input type="checkbox" checked={settings.enabled} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} /> Apply conversation updates</label>
          <label><input type="checkbox" checked={settings.emailEnabled} onChange={e => setSettings({ ...settings, emailEnabled: e.target.checked })} /> Accept email replies</label>
          <label className="f"><span className="caps muted">Messages per person / day</span><input type="number" min={1} max={100} value={settings.maxMessagesPerDay} onChange={e => setSettings({ ...settings, maxMessagesPerDay: Number(e.target.value) })} /></label>
          <label className="f"><span className="caps muted">Workspace daily allowance ($)</span><input type="number" min={0.01} max={5} step={0.01} value={settings.dailyBudgetUsd} onChange={e => setSettings({ ...settings, dailyBudgetUsd: Number(e.target.value) })} /></label>
          <button className="btn" type="button" onClick={async () => { try { await request("/api/conversation/settings", "PUT", settings); setError(null); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Cannot save settings"); } }}>Save controls</button>
          <p className="small muted">${(data?.usage.allowanceUsedUsd ?? 0).toFixed(3)} reserved or reported today. Failed model attempts retain their reservation.</p>
        </div></details>}
      </aside>
    </div>
  </>;
}
