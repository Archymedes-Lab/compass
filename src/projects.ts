// Projects: every product or repo the team works on, with live context pulled from where the work happens.
// Context arrives as "signals", one row per (project, source, key), always replaced by the newest reading:
//   git     — a working copy on a machine (branch, uncommitted files, unpushed commits, recent commit subjects)
//   github  — the repository on GitHub (latest commits, open PRs, CI on the default branch)
//   claude / codex — recent coding-agent sessions on a machine: title, first prompt (scrubbed, truncated), branch, time
//   site    — a live URL's status and response time, checked by the Worker
// Only metadata is accepted: no transcripts, no diffs, no file contents. Every free-text field is scrubbed of
// credential-shaped strings and email addresses here as well as in the collector (defence in depth).
// Attention items are deterministic rules over the signals. They are suggestions for people; nothing here creates tasks.
import { z } from "zod";
import { db, log, now } from "./db.ts";
import { githubSignalSchema, repoState, REPO_RX, type GithubSignal } from "./github.ts";

export const PROJECT_STATUSES = ["active", "paused", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export interface ProjectRow { id: string; name: string; brief: string; repos: string; sites: string; status: ProjectStatus; created_by: string | null; created_at: string; updated_at: string }

// --- scrubbing ------------------------------------------------------------------------------------------------
// Order matters: specific shapes first, generic ones last, so a generic rule never splits a known token.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,                       // OpenAI/Anthropic/OpenRouter/Stripe-style keys
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,  // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){0,2}/g,          // JWTs, also cut short by truncation
  /\b(?:bearer|token|password|passphrase|secret|api[_-]?key)\b\s*[:=]?\s*["']?[^\s"']{6,}/gi,
  // Prefixed underscore keys: Stripe sk_live_/rk_test_, whsec_, Resend re_, Polar polar_oat_, … (last segment 16+)
  /\b[A-Za-z][A-Za-z0-9]{0,15}_(?:[A-Za-z0-9]{1,12}_)*[A-Za-z0-9]{16,}/g,
  // A known prefix whose token was cut off by an earlier truncation: redact the fragment at the end of the text.
  /(?:\b(?:sk|pk|rk)-|\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_|\bAKIA|\bxox[abprs]-|\bAIza|\b[A-Za-z][A-Za-z0-9]{0,15}_(?=[A-Za-z0-9_]*\d)|\b[a-z]{2,10}_[a-z]{2,6}_)[A-Za-z0-9_-]{2,}$/g,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,                            // email addresses
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,                            // long opaque strings
];
export function scrub(text: unknown, max = 200, preserveWhitespace = false): string {
  let s = typeof text === "string" ? text : "";
  for (const rx of SECRET_PATTERNS) s = s.replace(rx, "[redacted]");
  s = preserveWhitespace ? s.replace(/\r\n?/g, "\n").trim() : s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// --- signal shapes --------------------------------------------------------------------------------------------
const iso = z.string().max(40);
const text = (max: number) => z.string().max(8000).transform(v => scrub(v, max));
export const gitSignalSchema = z.object({
  machine: z.string().max(64), path: z.string().max(300), branch: z.string().max(200).nullable(),
  dirty: z.number().int().min(0).max(1_000_000), ahead: z.number().int().min(0).nullable(), behind: z.number().int().min(0).nullable(),
  lastCommitAt: iso.nullable(), commits: z.array(z.object({ sha: z.string().max(12), at: iso, subject: text(200) }).strict()).max(5),
}).strict();
export const sessionSchema = z.object({ title: text(160), firstPrompt: text(240), at: iso, branch: z.string().max(200).nullable() }).strict();
export const sessionsSignalSchema = z.object({ machine: z.string().max(64), sessions: z.array(sessionSchema).max(8) }).strict();
export const siteSignalSchema = z.object({ url: z.string().url().max(400), ok: z.boolean(), status: z.number().int(), ms: z.number().int(), error: z.string().max(200).nullable() }).strict();
export type GitSignal = z.infer<typeof gitSignalSchema>;
export type SessionsSignal = z.infer<typeof sessionsSignalSchema>;
export type SiteSignal = z.infer<typeof siteSignalSchema>;

/** What a collector sends (POST /api/context). One request covers one machine and any number of projects. */
export const contextSchema = z.object({
  machine: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/),
  projects: z.array(z.object({
    key: z.string().trim().min(1).max(100).regex(/^[\w./-]+$/),
    name: z.string().trim().min(1).max(80),
    repo: z.string().regex(REPO_RX).nullable().optional(),
    git: gitSignalSchema.omit({ machine: true }).optional(),
    github: githubSignalSchema.optional(),
    claude: z.array(sessionSchema).max(8).optional(),
    codex: z.array(sessionSchema).max(8).optional(),
  }).strict()).max(60),
}).strict();
export type ContextInput = z.infer<typeof contextSchema>;

// --- registry -------------------------------------------------------------------------------------------------
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
export const allProjects = () => db.query<ProjectRow>("SELECT * FROM projects ORDER BY name").all();
export const getProject = (id: string) => db.query<ProjectRow>("SELECT * FROM projects WHERE id = ?").get(id);
const reposOf = (p: ProjectRow) => JSON.parse(p.repos) as string[];
const sitesOf = (p: ProjectRow) => JSON.parse(p.sites) as string[];

export const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brief: z.string().max(3000).default(""),
  repos: z.array(z.string().regex(REPO_RX)).max(10).default([]),
  sites: z.array(z.string().url().max(400).refine(u => /^https:\/\//.test(u), "Sites must use https")).max(10).default([]),
  status: z.enum(PROJECT_STATUSES).default("active"),
}).strict();

export function createProject(input: unknown, who: string | null): string {
  const p = projectInputSchema.parse(input);
  let id = slug(p.name), n = 2;
  while (getProject(id)) id = `${slug(p.name)}-${n++}`;
  db.query("INSERT INTO projects (id, name, brief, repos, sites, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, p.name, p.brief.trim(), JSON.stringify(p.repos), JSON.stringify(p.sites), p.status, who, now(), now());
  log("project.add", who, null, { project: id });
  return id;
}

export function updateProject(id: string, input: unknown, who: string | null) {
  const cur = getProject(id);
  if (!cur) throw new Error("Unknown project");
  const p = projectInputSchema.partial().parse(input);
  db.query("UPDATE projects SET name = ?, brief = ?, repos = ?, sites = ?, status = ?, updated_at = ? WHERE id = ?").run(
    p.name ?? cur.name, p.brief !== undefined ? p.brief.trim() : cur.brief, JSON.stringify(p.repos ?? reposOf(cur)),
    JSON.stringify(p.sites ?? sitesOf(cur)), p.status ?? cur.status, now(), id);
  log("project.edit", who, null, { project: id });
}

/** The project a collector's key or repo belongs to; created on first sight, so new repos appear without setup. */
function resolveProject(key: string, name: string, repo: string | null | undefined, who: string): string {
  if (repo) {
    const byRepo = allProjects().find(p => reposOf(p).some(r => r.toLowerCase() === repo.toLowerCase()));
    if (byRepo) return byRepo.id;
  }
  const existing = getProject(slug(key));
  if (existing && (!repo || reposOf(existing).length === 0)) {
    if (repo) db.query("UPDATE projects SET repos = ? WHERE id = ?").run(JSON.stringify([repo]), existing.id);
    return existing.id;
  }
  return createProject({ name, repos: repo ? [repo] : [] }, who);
}

function putSignal(projectId: string, source: string, key: string, payload: unknown, who: string | null, at = now()) {
  db.query("INSERT OR REPLACE INTO project_signals (project_id, source, key, payload, at, who) VALUES (?, ?, ?, ?, ?, ?)").run(projectId, source, key, JSON.stringify(payload), at, who);
}

/** Store one collector run. Synchronous after parsing, so it commits as one unit. */
export function ingestContext(input: unknown, who: string): { projects: number; created: string[] } {
  const c = contextSchema.parse(input);
  const before = new Set(allProjects().map(p => p.id));
  const touched = new Set<string>();
  db.transaction(() => {
    for (const p of c.projects) {
      const id = resolveProject(p.key, p.name, p.repo ?? p.github?.repo ?? null, who);
      if (getProject(id)?.status === "archived") continue;
      touched.add(id);
      if (p.git) putSignal(id, "git", `${c.machine}:${p.git.path}`, { ...p.git, machine: c.machine }, who);
      if (p.github) putSignal(id, "github", p.github.repo, p.github, who);
      if (p.claude) putSignal(id, "claude", c.machine, { machine: c.machine, sessions: p.claude }, who);
      if (p.codex) putSignal(id, "codex", c.machine, { machine: c.machine, sessions: p.codex }, who);
    }
  })();
  const created = [...touched].filter(id => !before.has(id));
  log("context.sync", who, null, { machine: c.machine, projects: touched.size, created: created.length });
  return { projects: touched.size, created };
}

/**
 * A coding agent's written account of a project (Codex or Claude on a schedule, through MCP compass_report_context):
 * where it stands, what is risky, what should happen next. One current report per project per reporter.
 */
export const reportSchema = z.object({
  reports: z.array(z.object({
    project: z.string().trim().min(1).max(100),
    summary: text(1500).pipe(z.string().min(20, "Write at least a sentence of summary")),
    state: text(600),
    risks: z.array(text(300)).max(6),
    nextSteps: z.array(text(300)).max(6),
  }).strict()).min(1).max(20),
}).strict();
export type ReportSignal = { summary: string; state: string; risks: string[]; nextSteps: string[] };

/** A project by id, name or repository ("owner/name"), case-insensitive. */
export function findProject(ref: string): ProjectRow | null {
  const r = ref.trim().toLowerCase();
  return allProjects().find(p => p.id === r || p.id === slug(r) || p.name.toLowerCase() === r || reposOf(p).some(x => x.toLowerCase() === r || x.toLowerCase().endsWith("/" + r))) ?? null;
}

export function ingestReports(input: unknown, who: string): { stored: string[]; unknown: string[] } {
  const c = reportSchema.parse(input);
  const stored: string[] = [], unknown: string[] = [];
  db.transaction(() => {
    for (const r of c.reports) {
      const p = findProject(r.project);
      if (!p || p.status === "archived") { unknown.push(r.project); continue; }
      putSignal(p.id, "report", who, { summary: r.summary, state: r.state, risks: r.risks, nextSteps: r.nextSteps } satisfies ReportSignal, who);
      stored.push(p.id);
    }
  })();
  log("context.report", who, null, { projects: stored.length, unknown: unknown.length });
  return { stored, unknown };
}

// --- server-side readings (Worker cron tick and the local server's interval) ----------------------------------
const SITE_INTERVAL_MS = 14 * 60_000, GITHUB_INTERVAL_MS = 30 * 60_000;
const signalAt = (projectId: string, source: string, key: string) =>
  db.query<{ at: string }>("SELECT at FROM project_signals WHERE project_id = ? AND source = ? AND key = ?").get(projectId, source, key)?.at ?? null;
const due = (at: string | null, ms: number, clock: Date) => !at || clock.getTime() - Date.parse(at) >= ms;

export async function checkSites(fetcher: typeof fetch = fetch.bind(globalThis), clock = new Date(), limit = 10): Promise<number> {
  const work = allProjects().filter(p => p.status === "active").flatMap(p => sitesOf(p).map(url => ({ p, url })))
    .filter(({ p, url }) => due(signalAt(p.id, "site", url), SITE_INTERVAL_MS, clock)).slice(0, limit);
  await Promise.all(work.map(async ({ p, url }) => {
    const start = Date.now();
    let signal: SiteSignal;
    try {
      const res = await fetcher(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "compass-site-check" } });
      await res.body?.cancel();
      signal = { url, ok: res.status < 400, status: res.status, ms: Date.now() - start, error: null };
    } catch (e) {
      signal = { url, ok: false, status: 0, ms: Date.now() - start, error: scrub(e instanceof Error ? e.message : String(e), 200) };
    }
    putSignal(p.id, "site", url, signal, null, clock.toISOString());
  }));
  return work.length;
}

export async function refreshGithub(token: string | undefined, fetcher: typeof fetch = fetch.bind(globalThis), clock = new Date(), limit = 3): Promise<number> {
  if (!token) return 0;
  const work = allProjects().filter(p => p.status === "active").flatMap(p => reposOf(p).map(repo => ({ p, repo })))
    .filter(({ p, repo }) => due(signalAt(p.id, "github", repo), GITHUB_INTERVAL_MS, clock))
    .sort((a, b) => (signalAt(a.p.id, "github", a.repo) ?? "").localeCompare(signalAt(b.p.id, "github", b.repo) ?? "")).slice(0, limit);
  for (const { p, repo } of work) {
    try { putSignal(p.id, "github", repo, await repoState(repo, token, fetcher), null, clock.toISOString()); }
    catch (e) { log("github.error", null, null, { project: p.id, error: scrub(e instanceof Error ? e.message : String(e), 200) }); }
  }
  return work.length;
}

// --- attention: what needs a person, per project ---------------------------------------------------------------
export type Severity = "high" | "medium" | "low";
export interface Attention { kind: string; severity: Severity; text: string; task?: { title: string; detail: string } }
interface Signals { reports: (ReportSignal & { who: string; at: string })[]; git: (GitSignal & { at: string })[]; github: (GithubSignal & { at: string })[]; sessions: { source: "claude" | "codex"; machine: string; at: string; title: string; firstPrompt: string; branch: string | null }[]; sites: (SiteSignal & { at: string })[] }

export function signalsFor(projectId: string): Signals {
  const rows = db.query<{ source: string; payload: string; at: string; who: string | null }>("SELECT source, payload, at, who FROM project_signals WHERE project_id = ?").all(projectId);
  const out: Signals = { reports: [], git: [], github: [], sessions: [], sites: [] };
  for (const r of rows) {
    const v = JSON.parse(r.payload);
    if (r.source === "report") out.reports.push({ ...v, who: r.who ?? "unknown", at: r.at });
    else if (r.source === "git") out.git.push({ ...v, at: r.at });
    else if (r.source === "github") out.github.push({ ...v, at: r.at });
    else if (r.source === "site") out.sites.push({ ...v, at: r.at });
    else if (r.source === "claude" || r.source === "codex") for (const s of (v as SessionsSignal).sessions) out.sessions.push({ ...s, source: r.source, machine: v.machine });
  }
  out.sessions.sort((a, b) => b.at.localeCompare(a.at));
  return out;
}

const days = (from: string | null, clock: Date) => from ? (clock.getTime() - Date.parse(from)) / 86_400_000 : Infinity;
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function attentionFor(name: string, s: Signals, clock: Date, liveTaskTitles: string[] = []): Attention[] {
  const out: Attention[] = [];
  for (const site of s.sites) {
    if (!site.ok) out.push({ kind: "site-down", severity: "high", text: `${site.url} is not answering (${site.status ? `HTTP ${site.status}` : site.error ?? "no response"})`, task: { title: `Bring ${new URL(site.url).host} back up`, detail: `Compass's site check failed at ${site.at}: ${site.status ? `HTTP ${site.status}` : site.error ?? "no response"}.` } });
    else if (site.ms > 4000) out.push({ kind: "site-slow", severity: "low", text: `${site.url} took ${(site.ms / 1000).toFixed(1)} s to answer` });
  }
  for (const g of s.github) {
    const c = g.ci;
    if (c && c.status === "completed" && c.conclusion && ["failure", "timed_out", "startup_failure"].includes(c.conclusion))
      out.push({ kind: "ci-failing", severity: "high", text: `${c.name} is failing on ${g.repo}@${g.defaultBranch}`, task: { title: `Fix failing ${c.name} on ${g.repo}`, detail: `Latest run on ${g.defaultBranch} concluded "${c.conclusion}" at ${c.at}. ${c.url}` } });
    const stale = g.openPrs.filter(p => !p.draft && days(p.updatedAt, clock) > 7);
    if (stale.length) out.push({ kind: "stale-prs", severity: "low", text: `${stale.length} open pull request${stale.length > 1 ? "s" : ""} on ${g.repo} untouched for a week (${stale.slice(0, 2).map(p => `#${p.number}`).join(", ")})`, task: { title: `Merge or close stale PRs on ${g.repo}`, detail: stale.map(p => `#${p.number} ${p.title}`).join("\n") } });
  }
  for (const g of s.git) {
    const idle = days(g.lastCommitAt, clock);
    if (g.dirty >= 15 && idle > 2) out.push({ kind: "uncommitted", severity: g.dirty >= 50 ? "medium" : "low", text: `${g.dirty} uncommitted changes on ${g.branch ?? "a detached HEAD"} (${g.machine}), last commit ${Math.floor(idle)} days ago`, task: { title: `Commit or shelve the open work in ${name} (${g.branch ?? "detached"})`, detail: `${g.dirty} uncommitted files at ${g.path} on ${g.machine}. Unsaved work is lost work and invisible to the team.` } });
    const defaults = new Set(["main", "master", ...s.github.map(h => h.defaultBranch)]);
    if (g.ahead === null && g.branch && !defaults.has(g.branch) && idle > 1) out.push({ kind: "unpushed-branch", severity: "medium", text: `Branch ${g.branch} exists only on ${g.machine} (never pushed), last commit ${Math.floor(idle)} days ago`, task: { title: `Push or merge ${g.branch} in ${name}`, detail: `${g.path} on ${g.machine} is on ${g.branch}, which has no upstream. If the machine is lost, so is this branch.` } });
    if ((g.ahead ?? 0) > 0 && idle > 1) out.push({ kind: "unpushed", severity: "medium", text: `${g.ahead} commit${g.ahead === 1 ? "" : "s"} on ${g.branch} not pushed (${g.machine})`, task: { title: `Push ${g.branch} in ${name}`, detail: `${g.ahead} local commits at ${g.path} on ${g.machine} exist only on that machine.` } });
  }
  // Agent work that Compass doesn't know about: recent sessions whose title matches no live task.
  const known = liveTaskTitles.map(t => t.toLowerCase());
  const untracked = s.sessions.filter(x => days(x.at, clock) < 2 && x.title && !known.some(k => k.includes(x.title.toLowerCase().slice(0, 24))));
  if (untracked.length) out.push({ kind: "agent-work", severity: "low", text: `${untracked.length} recent ${[...new Set(untracked.map(u => u.source === "claude" ? "Claude" : "Codex"))].join("/")} session${untracked.length > 1 ? "s" : ""} not tracked in Compass, latest: "${untracked[0].title}"`, task: { title: untracked[0].title.slice(0, 200), detail: `From a ${untracked[0].source === "claude" ? "Claude Code" : "Codex"} session on ${untracked[0].machine}${untracked[0].branch ? ` (branch ${untracked[0].branch})` : ""}. First prompt: ${untracked[0].firstPrompt}` } });
  const freshest = [...s.git.map(g => g.at), ...s.github.map(g => g.at), ...s.reports.map(g => g.at)].sort().at(-1) ?? null;
  if ((s.git.length || s.github.length) && days(freshest, clock) > 3) out.push({ kind: "stale-context", severity: "low", text: `No fresh repository context for ${Math.floor(days(freshest, clock))} days; is compass-sync running?` });
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** Everything the UI, agents, planner and email need about projects, newest activity first. */
export function projectOverview(clock = new Date()) {
  const tasks = db.query<{ id: string; title: string; status: string; project_id: string | null }>("SELECT id, title, status, project_id FROM tasks").all();
  return allProjects().map(p => {
    const s = signalsFor(p.id);
    const mine = tasks.filter(t => t.project_id === p.id);
    const live = mine.filter(t => t.status === "open" || t.status === "doing");
    const lastActivity = [...s.git.map(g => g.lastCommitAt), ...s.github.map(g => g.commits[0]?.at ?? g.pushedAt), ...s.sessions.map(x => x.at), ...s.reports.map(x => x.at)].filter((x): x is string => !!x).sort().at(-1) ?? null;
    return {
      id: p.id, name: p.name, brief: p.brief, status: p.status, repos: reposOf(p), sites: sitesOf(p), createdAt: p.created_at,
      lastActivity, openTasks: live.length, doneTasks: mine.filter(t => t.status === "done").length,
      attention: p.status === "active" ? attentionFor(p.name, s, clock, live.map(t => t.title)) : [],
      reports: s.reports.sort((a, b) => b.at.localeCompare(a.at)), git: s.git, github: s.github, sessions: s.sessions.slice(0, 8), siteChecks: s.sites,
    };
  }).sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1)
    || Number(b.attention.some(x => x.severity === "high")) - Number(a.attention.some(x => x.severity === "high"))
    || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}
export type ProjectView = ReturnType<typeof projectOverview>[number];

/** The project line Jev sees for a task, so it judges against that product as well as the company brief. */
export function projectContext(projectId: string | null): string {
  const p = projectId ? getProject(projectId) : null;
  return p ? `This task belongs to the project "${p.name}".${p.brief ? ` Project brief: ${p.brief.slice(0, 800)}` : ""}\n\n` : "";
}
