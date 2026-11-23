import { z } from "zod";
import { db, log, now } from "./db.ts";
import { scrub } from "./projects.ts";

export const conversationSettingsSchema = z.object({
  enabled: z.boolean(), emailEnabled: z.boolean(),
  receivingDomain: z.string().max(200).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/).or(z.literal("")),
  maxMessagesPerDay: z.number().int().min(1).max(100), dailyBudgetUsd: z.number().min(0.01).max(5),
}).strict();
export type ConversationSettings = z.infer<typeof conversationSettingsSchema>;
export interface Thread { id: string; who: string; channel: string; recipient: string | null; context: string; created_at: string }
export interface Message {
  id: string; thread_id: string; who: string; source: string; source_id: string | null; text: string; at: string;
  status: string; attempts: number; available_at: string; lease_until: string | null; response: string | null;
  changes: string; error: string | null; reserved_usd: number; reported_usd: number | null;
  reply_sent_at: string | null; reply_attempts: number; reply_next_at: string | null;
  email_message_id: string | null;
}
export const MESSAGE_RESERVATION = 0.01;
let config: { sessionKey?: string; webhookSecret?: string; receivingDomain?: string } = {};
let kick = () => {};
export const setConversationConfig = (value: typeof config) => { config = value; };
export const conversationConfig = () => config;
export const webhookSecret = () => config.webhookSecret ?? db.query<{ value: string }>("SELECT value FROM conversation_secrets WHERE key = 'resend-webhook'").get()?.value;
export const onConversationQueued = (fn: () => void) => { kick = fn; };
export function conversationSettings(): ConversationSettings {
  const row = db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'conversation:config'").get();
  return row ? conversationSettingsSchema.parse(JSON.parse(row.value)) : { enabled: true, emailEnabled: true, receivingDomain: config.receivingDomain ?? "", maxMessagesPerDay: 30, dailyBudgetUsd: 0.3 };
}
export function updateConversationSettings(value: unknown, who: string) {
  const s = conversationSettingsSchema.parse(value);
  db.query("INSERT OR REPLACE INTO settings (key, value, who, at) VALUES ('conversation:config', ?, ?, ?)").run(JSON.stringify(s), who, now());
  log("conversation.settings", who, null, { enabled: s.enabled, emailEnabled: s.emailEnabled });
  kick();
}
export function createThread(who: string, channel: "web" | "email", recipient: string | null = null, context = ""): Thread {
  const t = { id: crypto.randomUUID().replaceAll("-", ""), who, channel, recipient, context: context.slice(0, 16000), created_at: now() };
  db.query("INSERT INTO conversation_threads (id, who, channel, recipient, context, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(t.id, who, channel, recipient, t.context, t.created_at);
  return t;
}
export const getThread = (id: string) => db.query<Thread>("SELECT * FROM conversation_threads WHERE id = ?").get(id);
export const getMessage = (id: string) => db.query<Message>("SELECT * FROM conversation_messages WHERE id = ?").get(id);
export function enqueueMessage(thread: Thread, text: string, source: "web" | "email", sourceId: string) {
  const existing = db.query<Message>("SELECT * FROM conversation_messages WHERE source_id = ?").get(`${source}:${thread.who}:${sourceId}`);
  if (existing) return existing.id;
  const settings = conversationSettings();
  if (!settings.enabled || (source === "email" && !settings.emailEnabled)) throw Error("Conversation updates are paused");
  const cleaned = scrub(text, 12000, true);
  if (!cleaned) throw Error("Write a message for Compass");
  const day = now().slice(0, 10);
  const n = db.query<{ n: number }>("SELECT COUNT(*) n FROM conversation_messages WHERE who = ? AND at >= ?").get(thread.who, day)!.n;
  if (n >= settings.maxMessagesPerDay) throw Error("Today's conversation message limit is reached");
  const id = crypto.randomUUID(), at = now();
  db.query("INSERT INTO conversation_messages (id, thread_id, who, source, source_id, text, at, available_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, thread.id, thread.who, source, `${source}:${thread.who}:${sourceId}`, cleaned, at, at);
  log("conversation.receive", thread.who, null, { messageId: id, source });
  kick();
  return id;
}
export function conversationHistory(who: string, threadId?: string) {
  const threads = db.query<Thread>("SELECT * FROM conversation_threads WHERE who = ? ORDER BY created_at DESC LIMIT 20").all(who);
  const requested = threadId ? getThread(threadId) : null;
  const selected = threadId ? requested?.who === who ? requested : null : threads.find(t => t.channel === "web") ?? threads[0];
  if (threadId && !selected) throw Error("Conversation not found");
  if (selected && !threads.some(t => t.id === selected.id)) threads.unshift(selected);
  const messages = selected ? db.query<Message>("SELECT * FROM conversation_messages WHERE thread_id = ? ORDER BY at DESC, rowid DESC LIMIT 40").all(selected.id).reverse() : [];
  return { threads: threads.map(t => ({ id: t.id, channel: t.channel, createdAt: t.created_at })), threadId: selected?.id ?? null,
    messages: messages.map(m => ({ id: m.id, text: m.text, at: m.at, status: m.status, response: m.response, changes: JSON.parse(m.changes), error: m.error, source: m.source, replySentAt: m.reply_sent_at })) };
}
export function conversationWakeAt(): number | null {
  const s = conversationSettings();
  if (!s.enabled) return null;
  const rows = db.query<{ at: string }>(`SELECT CASE WHEN m.status = 'working' THEN m.lease_until ELSE m.available_at END at FROM conversation_messages m
    WHERE (m.source != 'email' OR ? = 1) AND (m.status = 'working' OR (m.status = 'queued' AND NOT EXISTS
      (SELECT 1 FROM conversation_messages older WHERE older.thread_id = m.thread_id AND older.rowid < m.rowid AND older.status IN ('queued', 'working'))))
    UNION ALL SELECT reply_next_at at FROM conversation_messages WHERE source = 'email' AND status = 'complete' AND reply_sent_at IS NULL AND reply_attempts < 3 AND ? = 1`).all(Number(s.emailEnabled), Number(s.emailEnabled));
  return rows.length ? Math.min(...rows.map(r => r.at ? Date.parse(r.at) : Date.now())) : null;
}
export async function replyAddress(thread: Thread): Promise<string | null> {
  const s = conversationSettings();
  if (!s.enabled || !s.emailEnabled || !s.receivingDomain || !config.sessionKey) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.sessionKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`compass-reply:${thread.id}:${thread.who}`));
  const token = Array.from(new Uint8Array(sig).slice(0, 12), b => b.toString(16).padStart(2, "0")).join("");
  return `c.${thread.id}.${token}@${s.receivingDomain}`;
}
