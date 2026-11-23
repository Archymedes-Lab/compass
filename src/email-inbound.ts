// Resend signs the raw webhook body. A per-thread HMAC address and current recipient bind replies to a person.
import { z } from "zod";
import { db, log, now } from "./db.ts";
import { conversationConfig, conversationSettings, enqueueMessage, getThread, replyAddress, webhookSecret } from "./conversation-store.ts";
import { digestSettings, emailConfig } from "./email.ts";
import { providerJson } from "./provider.ts";

const mailbox = (s: string) => (s.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] ?? s.trim()).toLowerCase();
export function freshReply(text: string): string {
  return text.replace(/\r\n/g, "\n").split(/\n(?:On [\s\S]{0,300}?wrote:|Le [^\n]+écrit\s?:|Am [^\n]+schrieb|[-_]{3,}\s*(?:Original Message|Forwarded message)|Begin forwarded message:|From:\s|>)/i)[0]!.trim().slice(0, 12000);
}
async function verifyWebhook(req: Request, secret: string): Promise<unknown> {
  const timestamp = req.headers.get("svix-timestamp") ?? "", id = req.headers.get("svix-id") ?? "";
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !id || id.length > 200) throw Error("Invalid webhook");
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > 65536) throw Error("Webhook too large");
  const raw = new TextDecoder().decode(bytes);
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.replace(/^whsec_/, "")), c => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
  for (const part of (req.headers.get("svix-signature") ?? "").split(" ").slice(0, 10)) {
    if (!part.startsWith("v1,")) continue;
    try { if (await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(part.slice(3)), c => c.charCodeAt(0)), data)) return JSON.parse(raw); } catch { /* another active signature may match */ }
  }
  throw Error("Invalid webhook");
}
const receivedSchema = z.object({ type: z.literal("email.received"), data: z.object({ email_id: z.string().uuid(), from: z.string().max(500), to: z.array(z.string().max(500)).max(20) }) });
export async function receiveEmail(req: Request, team: string[], fetcher: typeof fetch = fetch.bind(globalThis)): Promise<Response> {
  const secret = webhookSecret(), s = conversationSettings();
  if (!secret || !emailConfig.resendKey || !s.emailEnabled || !s.enabled) return Response.json({ error: "Email conversations are not available" }, { status: 503 });
  let payload: unknown;
  try { payload = await verifyWebhook(req, secret); } catch { return Response.json({ error: "Invalid webhook signature" }, { status: 401 }); }
  const event = receivedSchema.safeParse(payload);
  if (!event.success) return Response.json({ ignored: true });
  const e = event.data.data;
  const matches = e.to.map(mailbox).map(address => ({ address, id: address.match(/^c\.([a-f0-9]{32})\.[a-f0-9]{24}@/)?.[1] })).filter(x => x.id);
  // A reply cannot fan out into multiple people's conversations.
  if (matches.length !== 1) return Response.json({ ignored: true });
  const match = matches[0]!, thread = getThread(match.id!);
  if (!thread || thread.channel !== "email" || !team.includes(thread.who) || Date.now() - Date.parse(thread.created_at) > 90 * 86400000) return Response.json({ ignored: true });
  if (match.address !== await replyAddress(thread) || mailbox(e.from) !== thread.recipient?.toLowerCase() || digestSettings().recipients[thread.who]?.toLowerCase() !== thread.recipient?.toLowerCase()) return Response.json({ ignored: true });
  const prior = db.query<{ id: string }>("SELECT id FROM conversation_messages WHERE source_id = ?").get(`email:${thread.who}:${e.email_id}`);
  if (prior) return Response.json({ ok: true, duplicate: true });
  try {
    const email = await providerJson(await fetcher(`https://api.resend.com/emails/receiving/${e.email_id}`, { headers: { authorization: `Bearer ${emailConfig.resendKey}` }, redirect: "manual", signal: AbortSignal.timeout(20000) }), "Resend receiving", 256 * 1024);
    if (typeof email.from !== "string" || mailbox(email.from) !== thread.recipient?.toLowerCase() || !Array.isArray(email.to) || !email.to.some((to: string) => mailbox(to) === match.address)) return Response.json({ ignored: true });
    const headers = Object.fromEntries(Object.entries(email.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    if ((headers["auto-submitted"] && headers["auto-submitted"].toLowerCase() !== "no") || /bulk|list|junk/i.test(headers.precedence ?? "") || headers["list-id"]) return Response.json({ ignored: true });
    // Plain text only: never follow links, fetch attachments, or parse an HTML-only message as instructions.
    const text = freshReply(typeof email.text === "string" ? email.text : "");
    if (!text) return Response.json({ ignored: true, reason: "A plain text reply is required" });
    const id = enqueueMessage(thread, text, "email", e.email_id);
    if (typeof email.message_id === "string" && /^<[^<>\r\n]{1,250}>$/.test(email.message_id)) db.query("UPDATE conversation_messages SET email_message_id = ? WHERE id = ?").run(email.message_id, id);
    return Response.json({ ok: true, queued: true });
  } catch { return Response.json({ error: "Unable to queue reply; retry delivery" }, { status: 503 }); }
}

let setup: Promise<void> | null = null;
/** Provision only Compass's webhook. Credentials stay in a private table, excluded from exports and tools. */
export function ensureEmailWebhook(fetcher: typeof fetch = fetch.bind(globalThis)): Promise<void> {
  if (setup) return setup;
  setup = provision(fetcher).finally(() => { setup = null; }); return setup;
}
async function provision(fetcher: typeof fetch) {
  if (webhookSecret() || !emailConfig.resendKey || !conversationSettings().receivingDomain || !conversationSettings().emailEnabled) return;
  const last = db.query<{ value: string }>("SELECT value FROM conversation_secrets WHERE key = 'setup-last-at'").get()?.value;
  if (last && Date.now() - Date.parse(last) < 15 * 60000) return;
  db.query("INSERT OR REPLACE INTO conversation_secrets (key, value) VALUES ('setup-last-at', ?)").run(now());
  const origin = emailConfig.appUrl ?? "https://compass.archymedes.xyz";
  if (!origin.startsWith("https://")) return;
  const endpoint = new URL("/api/email/inbound", origin).href;
  const call = async (path: string, method = "GET", body?: unknown) => providerJson(await fetcher(`https://api.resend.com${path}`, { method, headers: { authorization: `Bearer ${emailConfig.resendKey}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: AbortSignal.timeout(20000) }), "Resend webhooks", 64000);
  try {
    let existing: { id: string; endpoint: string; status: string; events: string[] } | undefined;
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const list = await call(`/webhooks${after ? `?after=${encodeURIComponent(after)}` : ""}`);
      existing = list.data?.find((w: { endpoint: string }) => w.endpoint === endpoint);
      if (existing || !list.has_more) break;
      after = list.data?.at(-1)?.id;
      if (!after) throw Error("Invalid webhook pagination");
      if (page === 9) throw Error("Webhook list is too large");
    }
    if (existing && (existing.status !== "enabled" || !existing.events.includes("email.received"))) throw Error("Enable the Compass email.received webhook in Resend");
    const result = existing ? await call(`/webhooks/${encodeURIComponent(existing.id)}`) : await call("/webhooks", "POST", { endpoint, events: ["email.received"] });
    if (typeof result.signing_secret !== "string" || !result.signing_secret.startsWith("whsec_")) throw Error("No signing secret returned");
    db.query("INSERT OR REPLACE INTO conversation_secrets (key, value) VALUES ('resend-webhook', ?)").run(result.signing_secret);
    db.query("DELETE FROM conversation_secrets WHERE key = 'setup-error'").run();
    log("conversation.email.ready", null, null, { endpoint });
  } catch {
    db.query("INSERT OR REPLACE INTO conversation_secrets (key, value) VALUES ('setup-error', 'Cannot configure the receiving webhook. Check Resend API key permissions or set RESEND_WEBHOOK_SECRET.')").run();
  }
}
