// The daily email: each founder gets their own list of what to do today, built from the same state the app shows.
//   Your focus · your next tasks · what needs a person (agents' requests, owed debriefs, today's check-in)
//   · project alerts (sites, CI, at-risk work) · the strongest scan proposals with Orion's odds · what the agents are on.
// A fixed template: no model call, no extra cost, and it says only what Compass holds. Sent through Resend
// (RESEND_API_KEY, a server secret; RESEND_FROM a verified sender) once per person per UTC day after sendHourUtc,
// from the Worker's alarm/cron tick or the "Send now" button. Nothing in it approves, buys or deploys anything.
import { z } from "zod";
import { createThread, replyAddress, webhookSecret } from "./conversation-store.ts";
import { db, log, now } from "./db.ts";
import { buildState, getBrief } from "./state.ts";
import { scanStatus } from "./scan.ts";
import { providerJson, redact } from "./provider.ts";
import { isAgent } from "./auth.ts";

const SETTINGS_KEY = "digest:config", SENT_KEY = "digest:sent";
const MAX_ATTEMPTS = 3;

export const digestSettingsSchema = z.object({
  enabled: z.boolean(),
  sendHourUtc: z.number().int().min(0).max(23),
  recipients: z.record(z.string().min(1).max(40), z.union([z.literal(""), z.string().email().max(200)])),
}).strict();
export type DigestSettings = z.infer<typeof digestSettingsSchema>;
type SentLog = Record<string, { day: string; attempts: number; sentAt: string | null; error: string | null }>;

export interface EmailConfig { resendKey?: string; from?: string; appUrl?: string }
export const emailConfig: EmailConfig = {};
export function setEmailConfig(value: EmailConfig) { Object.assign(emailConfig, value); }

const read = <T>(key: string): T | null => { const r = db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(key); return r ? JSON.parse(r.value) as T : null; };
const write = (key: string, value: unknown, who: string | null) => db.query("INSERT OR REPLACE INTO settings (key, value, who, at) VALUES (?, ?, ?, ?)").run(key, JSON.stringify(value), who, now());

export function digestSettings(): DigestSettings {
  const parsed = digestSettingsSchema.safeParse(read(SETTINGS_KEY));
  return parsed.success ? parsed.data : { enabled: false, sendHourUtc: 5, recipients: {} };
}
/** People only; recipients must be on the team. */
export function updateDigestSettings(input: unknown, who: string, team: string[]): DigestSettings {
  const s = digestSettingsSchema.parse(input);
  for (const name of Object.keys(s.recipients)) if (!team.includes(name)) throw new Error(`${name} is not on the team`);
  write(SETTINGS_KEY, s, who);
  log("digest.settings", who, null, { enabled: s.enabled, hour: s.sendHourUtc, recipients: Object.values(s.recipients).filter(Boolean).length });
  return s;
}
export const digestSent = (): SentLog => read<SentLog>(SENT_KEY) ?? {};
export function digestStatus() {
  return { settings: digestSettings(), configured: !!emailConfig.resendKey, from: emailConfig.from ?? null, sent: digestSent() };
}

// --- content --------------------------------------------------------------------------------------------------
interface Section { title: string; items: string[] }
export interface Digest { subject: string; sections: Section[]; text: string; html: string }
const pct = (p: number | null | undefined) => p === null || p === undefined ? "?" : `${Math.round(p * 100)}%`;
type Moat = { worthy: boolean; p: number } | null | undefined;
interface Card { rank?: number; title: string; project?: string; moat?: Moat; odds?: number | null; range?: [number, number] | null; note?: string; chips?: string[]; steps?: [number, number] }
interface Line { label: string; text: string; strong?: boolean }

export function buildDigest(who: string, clock = new Date()): Digest {
  const st = buildState(who, false, clock);
  const scan = scanStatus(clock);
  const projectName = new Map(st.projects.map(p => [p.id, p.name]));
  const proj = (id: string | null | undefined) => (id && projectName.get(id)) || undefined;
  const tag = (projectId: string | null | undefined) => proj(projectId) ? `[${proj(projectId)}] ` : "";
  // Orion's moat verdict, the same one every other surface shows.
  const moat = (m: Moat) => m?.worthy ? ` ◆ moat-worthy (Orion ${pct(m.p)})` : "";
  const team = st.list.filter(t => t.lane === "team");
  const focus = st.focus ? st.list.find(t => t.id === st.focus!.id) : null;
  const sections: Section[] = [];

  // ---- the model the email renders: plain text (sections) and the designed HTML share it
  const focusCard: Card | null = focus ? { rank: focus.row.rank, title: focus.title, project: proj(focus.projectId), moat: focus.moat, odds: focus.row.pFirst, range: [focus.row.rankLo, focus.row.rankHi],
    chips: [`≈ ${Math.max(20, Math.round(focus.row.own * 10))} XP`], note: `${focus.owner === who ? "Orion dealt you this quest" : st.focus!.why}.${focus.doneWhen ? ` Done when: ${focus.doneWhen}` : ""}`, steps: focus.steps.length ? [focus.steps.filter(s => s.done).length, focus.steps.length] : undefined } : null;
  sections.push({ title: "Your focus today", items: focus
    ? [`${tag(focus.projectId)}${focus.title}${moat(focus.moat)} — ${st.focus!.why}.${focus.doneWhen ? ` Done when: ${focus.doneWhen}` : ""}${focus.steps.length ? ` (${focus.steps.filter(s => s.done).length}/${focus.steps.length} steps)` : ""}`]
    : ["Nothing is assigned to you or open for you. Pick one of the proposals below or ask Compass for the next task."] });

  const next = team.filter(t => t.id !== focus?.id && t.status === "open" && (t.owner === who || !t.owner) && !t.row.blockedBy.length).slice(0, 4);
  const nextCards: Card[] = next.map(t => ({ rank: t.row.rank, title: t.title, project: proj(t.projectId), moat: t.moat, odds: t.row.pTop, range: [t.row.rankLo, t.row.rankHi], chips: t.owner ? [] : ["unclaimed"] }));
  if (next.length) sections.push({ title: "After that", items: next.map(t => `#${t.row.rank} ${tag(t.projectId)}${t.title}${moat(t.moat)}${t.owner ? "" : " (unclaimed)"} — P(top 5) ${pct(t.row.pTop)}`) });

  const needs: string[] = [], needLines: Line[] = [];
  for (const n of st.interventions.open.filter(i => i.taskLive).slice(0, 4)) {
    needs.push(`${n.createdBy.replace(" (agent)", "")} needs ${n.kind}: ${n.need} (on "${n.taskTitle}")`);
    needLines.push({ label: n.kind, strong: ["approval", "credential", "spend", "legal"].includes(n.kind), text: `${n.createdBy.replace(" (agent)", "")}: ${n.need}` });
  }
  for (const d of st.questions.debriefs.slice(0, 3)) { needs.push(`Debrief "${d.title}": how did it go compared with what Orion expected?`); needLines.push({ label: "debrief", text: `"${d.title}": how did it go compared with what Orion expected?` }); }
  if (!st.questions.checkedToday.includes(who) && st.questions.daily) { needs.push("Your daily check-in is open (tasks in progress, follow-ups, a few questions)."); needLines.push({ label: "check-in", text: "Your daily check-in is open: two minutes, and Orion learns from it." }); }
  const unset = st.metrics.filter(m => m.value === null).length;
  if (unset) { needs.push(`${unset} of ${st.metrics.length} goal metrics have no measurement yet; enter what you know on Goals.`); needLines.push({ label: "metrics", text: `${unset} of ${st.metrics.length} goal metrics are unmeasured. Orion is flying without instruments there.` }); }
  if (needs.length) sections.push({ title: "Needs you", items: needs });

  const alerts = st.projects.flatMap(p => p.attention.filter(a => a.severity !== "low").map(a => ({ ...a, project: p.name })))
    .sort((a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1)).slice(0, 6);
  if (alerts.length) sections.push({ title: "Project alerts", items: alerts.map(a => `[${a.project}] ${a.text}`) });

  const proposals = scan.proposals.filter(c => c.judged).slice(0, 3);
  const proposalCards: Card[] = proposals.map(c => ({ rank: c.rank ?? undefined, title: c.title, project: proj(c.projectId), moat: c.moat, odds: c.pTop5, range: c.rankRange, note: c.why, chips: [`would rank #${c.rank} of ${c.ofTotal}`, ...(c.bold ? ["bold bet"] : []), `${c.lane} lane`] }));
  if (proposals.length) sections.push({ title: "Compass suggests (adopt or dismiss on Projects)", items: proposals.map(c =>
    `${tag(c.projectId)}${c.title}${moat(c.moat)} — would rank #${c.rank} of ${c.ofTotal}, P(top 5) ${pct(c.pTop5)}${c.bold ? ", the bold bet" : ""}. ${c.why}`) });

  const agents = st.list.filter(t => t.lane === "agent" && t.status === "doing").slice(0, 4);
  const agentDone = (st.agentUpdates?.items ?? []).filter(e => e.kind === "task.done").length;
  const agentQueue = st.list.filter(t => t.lane === "agent" && t.status === "open").length;
  if (agents.length || agentDone) sections.push({ title: "The agents", items: [...agents.map(t => `${tag(t.projectId)}${t.title} (in progress)`), ...(agentDone ? [`${agentDone} task(s) finished by agents since you last looked.`] : [])] });

  const day = clock.toISOString().slice(0, 10);
  const url = emailConfig.appUrl ?? "https://compass.archymedes.xyz";
  const subject = focus ? `Compass · ${focus.title.slice(0, 70)}` : `Compass · ${day}`;
  const footer = `Open Compass: ${url} · Brief last edited ${getBrief().at?.slice(0, 10) ?? "never (default)"}. Nothing here approves, buys or deploys anything.`;
  const text = [`Good morning ${who}. Compass for ${day}.`, "", ...sections.flatMap(s => [s.title.toUpperCase(), ...s.items.map(i => `- ${i}`), ""]), footer].join("\n");
  const html = renderHtml({
    who, day, url, briefAt: getBrief().at,
    stats: (() => { const me = st.game.players.find(p => p.who === who); return [["Level", String(me?.level ?? 1)], ["XP", String(me?.xp ?? 0)], ["Streak", `${me?.streak ?? 0}d`], ["Moat-worthy", String(st.list.filter(t => t.moat?.worthy).length)]] as [string, string][]; })(),
    focus: focusCard, next: nextCards, needs: needLines, alerts: alerts.map(a => ({ label: a.severity, strong: a.severity === "high", text: `${a.project} — ${a.text}` })),
    proposals: proposalCards, agents: { doing: agents.map(t => ({ title: t.title, project: proj(t.projectId) })), done: agentDone, queue: agentQueue },
  });
  return { subject, sections, text, html };
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// ---- the designed email: Archymedes design system (paper, ink, hairlines, one blue; night panel for the instrument
// header). Email-safe: tables and inline styles only; web fonts fall back to Helvetica / Menlo where clients block them.
const C = { canvas: "#f7f7f4", paper: "#fcfcfa", ink: "#111214", muted: "#74777c", hair: "#dadde0", blue: "#3478e5", black: "#08090a", onBlack: "#f2f2ee", onBlackMuted: "#8a8d91", hairBlack: "#2a2c2f", track: "#e8eaec" };
const F = {
  display: "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif",
  impact: "Anton,'Arial Black',Impact,sans-serif",
  body: "'Zen Kaku Gothic New','Helvetica Neue',Helvetica,Arial,sans-serif",
  mono: "'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace",
};
const eyebrow = (n: string, title: string, aside = "") =>
  `<tr><td style="padding:34px 32px 10px;border-top:1px solid ${C.hair}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`
  + `<td style="font:500 11px/1 ${F.mono};letter-spacing:.16em;text-transform:uppercase;color:${C.ink}"><span style="color:${C.blue}">${n}</span>&nbsp;&nbsp;${esc(title)}</td>`
  + `<td align="right" style="font:400 11px/1 ${F.mono};letter-spacing:.08em;color:${C.muted}">${aside}</td></tr></table></td></tr>`;
/** A 4px odds bar: Orion's simulated probability, filled in Archymedes blue on a hairline track. */
const bar = (p: number | null | undefined, w = 120) => {
  const f = Math.max(0, Math.min(1, p ?? 0)), fill = Math.round(w * f);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;vertical-align:middle"><tr>`
    + (fill ? `<td width="${fill}" height="4" style="background:${C.blue};font-size:0;line-height:0">&nbsp;</td>` : "")
    + (w - fill ? `<td width="${w - fill}" height="4" style="background:${C.track};font-size:0;line-height:0">&nbsp;</td>` : "")
    + `</tr></table>`;
};
const chip = (text: string, tone: "blue" | "ink" | "muted" = "muted") => {
  const color = tone === "blue" ? C.blue : tone === "ink" ? C.ink : C.muted;
  return `<span style="display:inline-block;margin:0 6px 4px 0;padding:3px 7px;border:1px solid ${color};font:500 10px/1.2 ${F.mono};letter-spacing:.1em;text-transform:uppercase;color:${color}">${esc(text)}</span>`;
};
const moatChip = (m: Moat) => m?.worthy ? chip(`◆ moat ${pct(m.p)}`, "blue") : "";
const steps = (s?: [number, number]) => s ? `<span style="font:400 12px ${F.mono};color:${C.muted};letter-spacing:.06em">${"■".repeat(s[0])}${"□".repeat(Math.max(0, s[1] - s[0]))}&nbsp; ${s[0]}/${s[1]} steps</span>` : "";

function card(c: Card, big = false): string {
  const rank = c.rank !== undefined ? String(c.rank).padStart(2, "0") : "··";
  return `<tr><td style="padding:${big ? "6px 32px 4px" : "14px 32px 0"}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${big ? `border-left:3px solid ${C.blue};background:${C.paper}` : ""}"><tr>`
    + `<td width="${big ? 74 : 56}" valign="top" style="padding:${big ? "16px 0 16px 18px" : "2px 0 0"};font:400 ${big ? 44 : 30}px/1 ${F.impact};color:${big ? C.blue : C.ink};letter-spacing:.01em">${rank}</td>`
    + `<td valign="top" style="padding:${big ? "16px 18px 16px 6px" : "0 0 14px"};${big ? "" : `border-bottom:1px solid ${C.hair}`}">`
    + `<div style="margin:0 0 6px">${c.project ? chip(c.project, "ink") : ""}${moatChip(c.moat)}${(c.chips ?? []).map(x => chip(x)).join("")}</div>`
    + `<div style="font:700 ${big ? 22 : 16}px/1.25 ${F.display};letter-spacing:-.01em;color:${C.ink}">${esc(c.title)}</div>`
    + (c.note ? `<div style="margin-top:8px;font:400 14px/1.55 ${F.body};color:${big ? C.ink : C.muted}">${esc(c.note)}</div>` : "")
    + `<div style="margin-top:10px">${c.odds !== undefined ? `${bar(c.odds, big ? 160 : 110)}<span style="font:500 11px ${F.mono};color:${C.muted};letter-spacing:.06em">&nbsp;&nbsp;${big ? "FIRST IN" : "TOP 5 IN"} ${pct(c.odds)}${c.range ? ` · LIKELY #${c.range[0]}${c.range[1] !== c.range[0] ? `–${c.range[1]}` : ""}` : ""}</span>` : ""}</div>`
    + (c.steps ? `<div style="margin-top:8px">${steps(c.steps)}</div>` : "")
    + `</td></tr></table></td></tr>`;
}
const lines = (xs: Line[]) => xs.map(l => `<tr><td style="padding:10px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`
  + `<td width="104" valign="top" style="padding:2px 0 12px"><span style="display:inline-block;padding:3px 6px;font:500 10px/1.2 ${F.mono};letter-spacing:.1em;text-transform:uppercase;${l.strong ? `background:${C.ink};color:${C.paper}` : `border:1px solid ${C.hair};color:${C.muted}`}">${esc(l.label)}</span></td>`
  + `<td valign="top" style="padding:0 0 12px;border-bottom:1px solid ${C.hair};font:400 14px/1.55 ${F.body};color:${C.ink}">${esc(l.text)}</td></tr></table></td></tr>`).join("");

function renderHtml(m: { who: string; day: string; url: string; briefAt: string | null; stats: [string, string][]; focus: Card | null; next: Card[]; needs: Line[]; alerts: Line[]; proposals: Card[]; agents: { doing: { title: string; project?: string }[]; done: number; queue: number } }): string {
  let n = 0; const num = () => String(++n).padStart(2, "0");
  const greet = m.focus ? `Your quest is loaded.` : `No quest dealt yet. Open Compass and ask Orion for one.`;
  const stats = m.stats.map(([k, v], i) => `<td style="padding:14px 0 0;${i ? `border-left:1px solid ${C.hairBlack};padding-left:14px` : ""}"><div style="font:400 30px/1 ${F.impact};color:${C.onBlack}">${esc(v)}</div><div style="margin-top:6px;font:500 10px/1 ${F.mono};letter-spacing:.14em;text-transform:uppercase;color:${C.onBlackMuted}">${esc(k)}</div></td>`).join("");
  const body = [
    m.focus ? eyebrow(num(), "Your quest", "dealt by orion") + card(m.focus, true)
      : eyebrow(num(), "Your quest") + `<tr><td style="padding:6px 32px 0;font:400 15px/1.6 ${F.body};color:${C.ink}">Nothing is assigned to you or open for you. Adopt a proposal below, or open Compass for the next task.</td></tr>`,
    m.next.length ? eyebrow(num(), "After that", "p(top 5) · simulated") + m.next.map(c => card(c)).join("") : "",
    m.needs.length ? eyebrow(num(), "Needs you", `${m.needs.length} open`) + lines(m.needs) : "",
    m.alerts.length ? eyebrow(num(), "Signals from the projects", "live context") + lines(m.alerts) : "",
    m.proposals.length ? eyebrow(num(), "Compass proposes", "luna proposes · orion ranks") + m.proposals.map(c => card(c)).join("")
      + `<tr><td style="padding:12px 32px 0;font:400 12px/1.5 ${F.mono};color:${C.muted}">Adopt or dismiss on Projects. Nothing joins the list without a person.</td></tr>` : "",
    (m.agents.doing.length || m.agents.done || m.agents.queue) ? eyebrow(num(), "The agents", `${m.agents.queue} queued`)
      + `<tr><td style="padding:6px 32px 0;font:400 14px/1.6 ${F.body};color:${C.ink}">${m.agents.doing.length ? m.agents.doing.map(a => `<div>▸ ${a.project ? `<span style="font:500 11px ${F.mono};color:${C.muted}">${esc(a.project.toUpperCase())}</span> ` : ""}${esc(a.title)}</div>`).join("") : `<div style="color:${C.muted}">No agent work in progress right now.</div>`}${m.agents.done ? `<div style="margin-top:6px;color:${C.blue}">${m.agents.done} finished since you last looked.</div>` : ""}</td></tr>` : "",
  ].join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">`
    + `<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@500;700&family=IBM+Plex+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@400;500&display=swap" rel="stylesheet">`
    + `<title>Compass: Task Management System</title></head><body style="margin:0;padding:0;background:${C.canvas}">`
    + `<div style="display:none;max-height:0;overflow:hidden">${esc(m.focus ? `Focus: ${m.focus.title}` : "Your Compass briefing")}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas}"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:${C.paper};border:1px solid ${C.hair}">`
    // instrument header, night palette
    + `<tr><td style="background:${C.black};padding:26px 32px 24px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font:500 11px/1 ${F.mono};letter-spacing:.18em;text-transform:uppercase;color:${C.blue}">◎ Compass: Task Management System</td>`
    + `<td align="right" style="font:400 11px/1 ${F.mono};letter-spacing:.1em;color:${C.onBlackMuted}">${esc(m.day)} · KGL</td></tr></table>`
    + `<div style="margin-top:22px;font:700 34px/1.05 ${F.display};letter-spacing:-.02em;color:${C.onBlack}">Good morning, ${esc(m.who)}.</div>`
    + `<div style="margin-top:8px;font:400 15px/1.5 ${F.body};color:${C.onBlackMuted}">${greet} Orion ranked the list; defensibility is the prime law.</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid ${C.hairBlack}"><tr>${stats}</tr></table>`
    + `</td></tr><tr><td height="3" style="background:${C.blue};font-size:0;line-height:0">&nbsp;</td></tr>`
    + body
    // footer
    + `<tr><td style="padding:34px 32px 30px;border-top:1px solid ${C.hair}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.ink}"><a href="${esc(m.url)}" style="display:inline-block;padding:13px 20px;font:500 12px/1 ${F.mono};letter-spacing:.14em;text-transform:uppercase;color:${C.paper};text-decoration:none">Open Compass&nbsp;&nbsp;→</a></td></tr></table>`
    + `<div style="margin-top:18px;font:400 11px/1.6 ${F.mono};color:${C.muted};letter-spacing:.04em"><!-- reply-hint -->END OF BRIEFING · ARCHYMEDES · Brief last edited ${esc(m.briefAt?.slice(0, 10) ?? "never (default)")}.<br>Nothing here approves, buys or deploys anything. People own those decisions.</div></td></tr>`
    + `</table></td></tr></table></body></html>`;
}

// --- sending --------------------------------------------------------------------------------------------------
async function deliver(who: string, to: string, d: Digest, fetcher: typeof fetch): Promise<string | null> {
  if (!emailConfig.resendKey) throw new Error("Set RESEND_API_KEY as a server secret to send email");
  let replyTo: string | null = null;
  if (webhookSecret()) {
    const st = buildState(who, false);
    const thread = createThread(who, "email", to.toLowerCase(), JSON.stringify({ briefing: d.text, focusTaskId: st.focus?.id, taskReferences: st.list.map(t => ({ id: t.id, title: t.title, rank: t.row.rank, owner: t.owner })) }));
    replyTo = await replyAddress(thread);
  }
  const replyHint = replyTo ? "Reply to this email in your own words. Luna will update clear task requests and ask about anything ambiguous." : "";
  const body = await providerJson(await fetcher("https://api.resend.com/emails", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${emailConfig.resendKey}` },
    body: JSON.stringify({ from: emailConfig.from ?? "Compass <compass@archymedes.xyz>", to: [to], subject: d.subject, ...(replyTo ? { reply_to: replyTo } : {}), html: replyTo ? d.html.replace("<!-- reply-hint -->", `<p style="font:400 14px/1.6 Helvetica,Arial,sans-serif">${esc(replyHint)}</p>`) : d.html, text: d.text + (replyHint ? "\n\n" + replyHint : "") }),
  }), "Resend", 16 * 1024);
  return typeof body?.id === "string" ? body.id : null;
}

/**
 * Sends today's email to everyone due. Scheduled: after sendHourUtc, once per person per UTC day, at most
 * MAX_ATTEMPTS tries. The attempt is recorded before sending, so two ticks cannot both send. `only` + `force`
 * is the "Send now" button: one person, regardless of the hour or an earlier send today.
 */
// The alarm and the cron can tick together in the one Durable Object: queue the calls, so each sees the last one's log.
let queue: Promise<unknown> = Promise.resolve();
export function sendDigests(opts: { fetch?: typeof fetch; clock?: Date; only?: string; force?: boolean } = {}): Promise<{ sent: string[]; failed: string[] }> {
  const run = queue.then(() => sendNow(opts));
  queue = run.catch(() => undefined);
  return run;
}
async function sendNow(opts: { fetch?: typeof fetch; clock?: Date; only?: string; force?: boolean }): Promise<{ sent: string[]; failed: string[] }> {
  const s = digestSettings(), clock = opts.clock ?? new Date(), day = clock.toISOString().slice(0, 10);
  const fetcher = opts.fetch ?? fetch.bind(globalThis);
  const out = { sent: [] as string[], failed: [] as string[] };
  if (!opts.force && (!s.enabled || clock.getUTCHours() < s.sendHourUtc || !emailConfig.resendKey)) return out;
  for (const [who, to] of Object.entries(s.recipients)) {
    if (!to || isAgent(who) || (opts.only && opts.only !== who)) continue;
    const log0 = digestSent(), prev = log0[who]?.day === day ? log0[who] : { day, attempts: 0, sentAt: null, error: null };
    if (!opts.force && (prev.sentAt || prev.attempts >= MAX_ATTEMPTS)) continue;
    write(SENT_KEY, { ...log0, [who]: { ...prev, attempts: prev.attempts + 1 } }, null);
    try {
      await deliver(who, to, buildDigest(who, clock), fetcher);
      write(SENT_KEY, { ...digestSent(), [who]: { day, attempts: prev.attempts + 1, sentAt: clock.toISOString(), error: null } }, null);
      log("digest.send", null, null, { to: who, day });
      out.sent.push(who);
    } catch (e) {
      const error = redact(e instanceof Error ? e.message : String(e), [emailConfig.resendKey]).slice(0, 200);
      write(SENT_KEY, { ...digestSent(), [who]: { day, attempts: prev.attempts + 1, sentAt: null, error } }, null);
      log("digest.error", null, null, { to: who, error });
      out.failed.push(who);
    }
  }
  return out;
}
