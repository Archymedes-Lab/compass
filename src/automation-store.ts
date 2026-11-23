import { z } from "zod";
import { db, log, now } from "./db.ts";

export const PLAN_RESERVATION_USD = 0.025;
export const MANUAL_RETRY_REASON = "A person requested retry of a failed planning run";
export const PLANNER_MODEL = "openai/gpt-6-luna";
export const automationSettingsSchema = z.object({
  enabled: z.boolean(),
  minIntervalMinutes: z.number().int().min(15).max(1440),
  maxIntervalMinutes: z.number().int().min(15).max(1440),
  maxRunsPerDay: z.number().int().min(1).max(24),
  dailyBudgetUsd: z.number().min(PLAN_RESERVATION_USD).max(5),
  guidance: z.string().max(2000),
  researchQuery: z.string().trim().min(5).max(200),
}).strict().refine(s => s.maxIntervalMinutes >= s.minIntervalMinutes, "Maximum interval must be at least the minimum");
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;
const sources = z.array(z.string().url().max(2000)).max(3);
export const planSchema = z.object({
  summary: z.string().min(1).max(1600),
  nextRunMinutes: z.number().int().min(15).max(1440),
  nextRunReason: z.string().min(1).max(400),
  nextResearchQuery: z.string().min(5).max(200),
  recommendations: z.array(z.object({ taskId: z.string().max(80), reason: z.string().max(500), nextStep: z.string().max(500), requiresHuman: z.boolean(), sourceUrls: sources }).strict()).max(5),
  proposals: z.array(z.object({ title: z.string().min(1).max(200), detail: z.string().max(1200), doneWhen: z.string().min(1).max(400), steps: z.array(z.string().max(200)).max(6), sourceUrls: sources }).strict()).max(2),
  humanNeeds: z.array(z.object({ taskId: z.string().max(80).nullable(), kind: z.enum(["information", "decision", "approval", "credential", "spend", "legal", "access", "external"]), need: z.string().max(600) }).strict()).max(3),
}).strict();
export type Plan = z.infer<typeof planSchema>;
export interface Evidence { title: string; url: string; publishedAt: string | null; text: string }
export interface AutomationRun {
  id: string; at: string; finished_at: string | null; status: string; model: string; context_hash: string | null;
  result: string | null; evidence: string; error: string | null; reserved_usd: number; reported_usd: number | null; billing_complete: number; usage: string | null; accepted: string;
}
export interface AutomationConfig { openrouterKey?: string; exaKey?: string; enabled?: boolean; model?: string }
let config: AutomationConfig = {};
let kick: () => void = () => {};
export function onAutomationChanged(fn: () => void) { kick = fn; }
export const automationConfig = () => config;
export function setAutomationConfig(value: AutomationConfig) {
  config = value;
  if (!readSetting("automation:schedule")) saveSchedule(new Date().toISOString(), "Initial planning run");
}
function readSetting<T>(key: string): T | null {
  const row = db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) as T : null;
}
function writeSetting(key: string, value: unknown, who: string | null = null) {
  db.query("INSERT OR REPLACE INTO settings (key, value, who, at) VALUES (?, ?, ?, ?)").run(key, JSON.stringify(value), who, now());
}
export function automationSettings(): AutomationSettings {
  return readSetting<AutomationSettings>("automation:config") ?? { enabled: config.enabled ?? false, minIntervalMinutes: 30, maxIntervalMinutes: 1440, maxRunsPerDay: 8, dailyBudgetUsd: 0.25, guidance: "Prefer evidence-backed next steps on existing tasks. Ask people for decisions and protected actions. Do not invent outcomes or metrics.", researchQuery: "endpoint security server monitoring small software agencies buyer needs adoption evidence" };
}
export function saveSchedule(nextAt: string, reason: string, researchQuery?: string) { writeSetting("automation:schedule", { nextAt, reason, ...(researchQuery ? { researchQuery } : {}) }); }
export const automationSchedule = () => readSetting<{ nextAt: string; reason: string; researchQuery?: string }>("automation:schedule");
export const nextUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
export function automationUsage(clock = new Date()) {
  const day = clock.toISOString().slice(0, 10);
  const row = db.query<{ runs: number; reserved: number; reported: number | null; allowance: number; unknown: number }>("SELECT COUNT(*) runs, COALESCE(SUM(reserved_usd), 0) reserved, SUM(reported_usd) reported, COALESCE(SUM(MAX(reserved_usd, COALESCE(reported_usd, reserved_usd))), 0) allowance, COALESCE(SUM(CASE WHEN billing_complete = 0 THEN 1 ELSE 0 END), 0) unknown FROM automation_runs WHERE at >= ? AND at < ?").get(day, nextUtcDay(clock))!;
  return { day, runs: row.runs, reservedUsd: Math.round(row.reserved * 1e6) / 1e6, reportedUsd: row.reported, allowanceUsedUsd: Math.round(row.allowance * 1e6) / 1e6, unreportedRuns: row.unknown };
}
export function automationStatus(clock = new Date()) {
  const settings = automationSettings();
  const ready = !!config.openrouterKey && !!config.exaKey;
  const schedule = automationSchedule();
  const usage = automationUsage(clock);
  const runs = db.query<AutomationRun>("SELECT * FROM automation_runs ORDER BY at DESC, id DESC LIMIT 8").all().map(r => ({ id: r.id, at: r.at, finishedAt: r.finished_at, status: r.status, model: r.model, plan: r.result ? JSON.parse(r.result) as Plan : null, evidence: JSON.parse(r.evidence) as Evidence[], error: r.error, reservedUsd: r.reserved_usd, reportedUsd: r.reported_usd, usage: r.usage ? JSON.parse(r.usage) as { promptTokens: number; completionTokens: number } : null, accepted: JSON.parse(r.accepted) as Record<string, string> }));
  return { settings, model: config.model ?? PLANNER_MODEL, ready, providers: { openrouter: !!config.openrouterKey, exa: !!config.exaKey }, schedule: settings.enabled && ready ? schedule : null, usage, reservationPerRunUsd: PLAN_RESERVATION_USD, runs };
}
export function updateAutomationSettings(input: unknown, who: string) {
  const settings = automationSettingsSchema.parse(input);
  // The query goes to a public search service. Block obvious credential/private-key material.
  if (/(?:sk-or-|bearer\s|api[_ -]?key\s*[:=]|password\s*[:=]|-----BEGIN|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(settings.researchQuery)) throw new Error("Use a public research query without credentials");
  const previous = automationSettings();
  writeSetting("automation:config", settings, who);
  if (settings.researchQuery !== previous.researchQuery) saveSchedule(automationSchedule()?.nextAt ?? now(), "Public research query updated by a person", settings.researchQuery);
  log("automation.settings", who, null, { enabled: settings.enabled, maxRunsPerDay: settings.maxRunsPerDay, dailyBudgetUsd: settings.dailyBudgetUsd });
  if (settings.enabled && !automationSchedule()) saveSchedule(now(), "Enabled by a person");
  kick();
  return settings;
}
export function requestAutomationRun(who: string, clock = new Date(), retryFailed = false) {
  const s = automationSettings(), c = automationConfig(), u = automationUsage(clock);
  if (!s.enabled) throw new Error("Resume planning before requesting a run");
  if (!c.openrouterKey || !c.exaKey) throw new Error("Configure both planning providers first");
  if (u.runs >= s.maxRunsPerDay || u.allowanceUsedUsd + PLAN_RESERVATION_USD > s.dailyBudgetUsd + 1e-9) throw new Error("Today's planning allowance is exhausted");
  const recent = db.query<{ at: string; status: string }>("SELECT at, status FROM automation_runs ORDER BY at DESC LIMIT 1").get();
  const retry = retryFailed && recent && ["error", "interrupted"].includes(recent.status);
  const interval = retry ? 60000 : s.minIntervalMinutes * 60000;
  if (recent && clock.getTime() - Date.parse(recent.at) < interval) throw new Error(retry ? "Wait one minute before retrying a failed run" : "The minimum interval also applies to manual runs");
  saveSchedule(clock.toISOString(), retry ? MANUAL_RETRY_REASON : "Requested by a person", automationSchedule()?.researchQuery);
  log("automation.request", who, null); kick();
}
export function acceptedProposal(runId: string, index: number): string | null {
  const r = db.query<AutomationRun>("SELECT * FROM automation_runs WHERE id = ? AND status = 'complete'").get(runId);
  return r ? (JSON.parse(r.accepted) as Record<string, string>)[String(index)] ?? null : null;
}
export function adoptProposal(runId: string, index: number, who: string, create: (proposal: Plan["proposals"][number]) => string) {
  return db.transaction(() => {
    const row = db.query<AutomationRun>("SELECT * FROM automation_runs WHERE id = ? AND status = 'complete'").get(runId);
    if (!row?.result) throw new Error("No completed plan found");
    const plan = planSchema.parse(JSON.parse(row.result)), p = plan.proposals[index];
    if (!p) throw new Error("No such proposal");
    const accepted = JSON.parse(row.accepted) as Record<string, string>;
    if (accepted[String(index)]) return accepted[String(index)];
    const id = create(p); accepted[String(index)] = id;
    db.query("UPDATE automation_runs SET accepted = ? WHERE id = ?").run(JSON.stringify(accepted), runId);
    log("automation.adopt", who, id, { runId, index });
    return id;
  })();
}
