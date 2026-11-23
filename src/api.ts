// The JSON API, as one fetch handler. Bun serves it locally (src/server.ts); a Durable Object serves it on
// Cloudflare (worker/index.ts). Everyone must sign in; "who" is always the signed-in person, never a client field.
import { adoptProposal, automationSettingsSchema, automationStatus, requestAutomationRun, updateAutomationSettings } from "./automation-store.ts";
import { loginAllowed } from "./oauth.ts";
import { receiveEmail } from "./email-inbound.ts";
import { conversationHistory, createThread, enqueueMessage, getThread, updateConversationSettings } from "./conversation-store.ts";
import { conversationStatus } from "./conversations.ts";
import { createMcp, isMcpPath } from "./mcp.ts";
import { db, log, now } from "./db.ts";
import { DIMS, TRACKS, type Dim } from "./dims.ts";
import { METRICS, activity, addTask, allInterventions, allLinks, buildState, getBrief, getIntervention, getTask, markSeen, outcomeForecast, propagate, queueJudge, setBrief, setStatus, wouldUnlock } from "./state.ts";
import { actionable, directive, isKind, isLane, KINDS, LANES } from "./lanes.ts";
import { wouldCycle, type LinkKind } from "./flow.ts";
import { kigaliDay } from "./questions.ts";
import { agentFor, clearCookie, isAgent, parseAgents, parseUsers, sessionCookie, sessionUser } from "./auth.ts";
import { createProject, findProject, getProject, ingestContext, ingestReports, projectOverview, updateProject } from "./projects.ts";
import { adoptCandidate, dismissCandidate, runScan, scanStatus, updateScanSettings } from "./scan.ts";
import { buildDigest, digestStatus, sendDigests, updateDigestSettings } from "./email.ts";
import { ZodError } from "zod";
import { dealQuests, passQuest, setGameTeam } from "./game.ts";

export const RESULTS = ["much-worse", "worse", "as-expected", "better", "much-better"] as const;

export interface Config { users: string | undefined; sessionKey: string; agents?: string | undefined; mcpOrigin?: string; mcpRedirectUris?: string; judgeKey?: string }

// What an agent may do (agents are recorded as "<Name> (agent)"). Reading, proposing work, moving it along,
// reporting what was done with evidence, linking tasks, and asking a person for help (an intervention) or
// withdrawing its own request. Not: team assessments (they override Orion, so an agent must not pose as the
// team), the brief, daily check-ins, impact follow-ups, metrics, dropping or unlinking, moving a task between
// lanes, answering an intervention, reviewing a debrief, or the full export. Writes are bounded per agent per day.
export const AGENT_DAILY_WRITES = 200;
const AGENT_ROUTES: [string, RegExp][] = [
  ["GET", /^\/api\/(me|state|brief|health|automation|agent\/next|projects|scan|conversation\/status)$/],
  // Context from where the work happens: compass-sync (metadata) and agents' written project reports.
  ["POST", /^\/api\/context(\/report)?$/],
  ["POST", /^\/api\/(tasks|debriefs|links)$/],
  ["POST", /^\/api\/tasks\/[\w-]+\/judge$/],
  ["PATCH", /^\/api\/tasks\/[\w-]+$/],
  ["POST", /^\/api\/interventions$/],
  ["PATCH", /^\/api\/interventions\/\d+$/],
];
const agentMay = (method: string, path: string) => AGENT_ROUTES.some(([m, rx]) => m === method && rx.test(path));
const agentWritesToday = (who: string) =>
  (db.query("SELECT COUNT(*) n FROM events WHERE who = ? AND at >= ?").get(who, new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n;

type Body = Record<string, unknown>;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });
const bad = (msg: string) => json({ error: msg }, 400);
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const level = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4 ? (v as number) : null);

function recordAnswer(taskId: string, dim: unknown, lvl: unknown, who: string, note?: unknown) {
  const l = level(lvl);
  if (!getTask(taskId) || !DIMS.includes(dim as Dim) || l === null) throw new Error("bad answer");
  db.query("INSERT INTO answers (task_id, dim, level, who, note, at) VALUES (?, ?, ?, ?, ?, ?)").run(taskId, dim as string, l, who, str(note) || null, now());
}
function recordFollowUp(taskId: string, b: Body, who: string) {
  const t = getTask(taskId);
  const impact = level(b.impact);
  if (!t || t.status !== "done" || impact === null) throw new Error("bad follow-up");
  db.query("INSERT OR REPLACE INTO followups (task_id, who, at, impact, metric, notes, predicted_impact, predicted_dist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(taskId, who, now(), impact, str(b.metric) || null, str(b.notes) || null, outcomeForecast(t).levels.impact, JSON.stringify(outcomeForecast(t).beliefs));
}
function recordMetric(name: unknown, value: unknown, who: string) {
  if (!METRICS.some((m) => m.name === name) || typeof value !== "number" || !Number.isFinite(value)) throw new Error("bad metric");
  db.query("INSERT INTO metrics (name, value, who, at) VALUES (?, ?, ?, ?)").run(name as string, value, who, now());
}

const stepTexts = (v: unknown) => (Array.isArray(v) ? v.map((s) => str(typeof s === "string" ? s : (s as { text?: unknown })?.text, 200)).filter(Boolean).slice(0, 12) : []);
const stepsOf = (v: unknown[]) => v.map((s) => {
  const o = (typeof s === "string" ? { text: s } : s) as { text?: unknown; done?: unknown };
  return { text: str(o.text, 200), done: o.done === true };
}).filter((s) => s.text).slice(0, 12);

export function createHandler(cfg: Config) {
  const users = parseUsers(cfg.users);
  if (!users.names.length) throw new Error("COMPASS_USERS is empty: set it to \"Name:passphrase,Name:passphrase\"");
  if (cfg.sessionKey.length < 16) throw new Error("SESSION_KEY must be at least 16 characters");
  const person = (v: unknown) => (users.names.includes(v as string) ? (v as string) : null);
  const agents = parseAgents(cfg.agents);
  setGameTeam(users.names);

  const mcp = createMcp(cfg, (req, who) => handle(req, who));
  return (req: Request): Promise<Response> => isMcpPath(new URL(req.url).pathname) ? mcp(req) : handle(req);

  async function handle(req: Request, internalAgent?: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname, method = req.method;
    const secure = url.protocol === "https:";
    try {
      if (path === "/api/email/inbound" && method === "POST") return receiveEmail(req, users.names);
      if (path === "/api/login" && method === "POST") {
        if (req.headers.has("origin") && req.headers.get("origin") !== url.origin) return json({ error: "Untrusted origin" }, 403);
        const b = (await req.json().catch(() => ({}))) as Body;
        const name = str(b.name, 40);
        if (!await loginAllowed(req, name)) return json({ error: "Too many sign-in attempts. Try again later." }, 429);
        if (!users.check(name, typeof b.passphrase === "string" ? b.passphrase : "")) return json({ error: "Wrong name or passphrase" }, 401);
        log("login", name, null);
        return json({ ok: true, who: name }, 200, { "set-cookie": await sessionCookie(cfg.sessionKey, name, secure) });
      }
      if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie(secure) });

      const agent = internalAgent ?? agentFor(req, agents);
      if (agent === "") return json({ error: "Unknown agent token" }, 401);
      const who = agent ?? (await sessionUser(req, cfg.sessionKey, users));
      if (!who) return json({ error: "Sign in" }, 401);
      if (agent && !agentMay(method, path)) return json({ error: `An agent may not ${method} ${path}: this is the team's to do` }, 403);
      // Parse before checking the write quota. After this await, each mutation validates and commits synchronously,
      // so parallel requests cannot all pass a stale count before any of them writes.
      if (method !== "GET" && !(req.headers.get("content-type") ?? "").includes("application/json")) return bad("JSON body required");
      const parsed: unknown = method === "GET" ? {} : await req.json().catch(() => null);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("JSON object required");
      const body = () => parsed as Body;
      if (agent && method !== "GET" && agentWritesToday(agent) >= AGENT_DAILY_WRITES) return json({ error: "Agent write limit for today reached" }, 429);

      if (path === "/api/me") return json({ who, agent: isAgent(who), team: users.names, agents: agents.names, tracks: TRACKS, results: RESULTS, lanes: LANES, kinds: KINDS });
      if (path === "/api/conversation/status" && method === "GET") return json(conversationStatus(who));
      if (path === "/api/conversation" && method === "GET" && !agent) {
        try { return json({ ...conversationHistory(who, url.searchParams.get("thread") ?? undefined), ...conversationStatus(who) }); }
        catch { return json({ error: "Conversation not found" }, 404); }
      }
      if (path === "/api/conversation" && method === "POST" && !agent) {
        const b = body();
        if (!conversationStatus(who).configured) return json({ error: "Conversation model is not configured" }, 503);
        if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 12000 || typeof b.requestId !== "string" || !/^[\w-]{16,80}$/.test(b.requestId)) return bad("Message and request ID required (maximum 12,000 characters)");
        const prior = db.query<{ id: string; thread_id: string }>("SELECT id, thread_id FROM conversation_messages WHERE source_id = ?").get(`web:${who}:${b.requestId}`);
        if (prior) return json({ id: prior.id, threadId: prior.thread_id, queued: true }, 202);
        const thread = b.threadId ? getThread(str(b.threadId, 80)) : null;
        if (b.threadId && (!thread || thread.who !== who)) return json({ error: "Conversation not found" }, 404);
        try {
          const result = db.transaction(() => {
            const t = thread ?? createThread(who, "web");
            return { id: enqueueMessage(t, b.text as string, "web", b.requestId as string), threadId: t.id, queued: true };
          })();
          return json(result, 202);
        }
        catch (e) { return json({ error: e instanceof Error ? e.message : "Cannot queue message" }, 409); }
      }
      if (path === "/api/conversation/settings" && method === "PUT" && !agent) {
        updateConversationSettings(body(), who); return json(conversationStatus(who));
      }
      // A compact reading for agents: the ranked open work, with why, what done means, steps and links.
      if (path === "/api/agent/next" && method === "GET") {
        // ?lane=agent (default): the agent lane, actionable work first, each with a directive. ?lane=team: the team's
        // lane, to read (an agent proposes support for it; it does not take it). ?lane=all: one list, Orion's order.
        const st = buildState(null, url.searchParams.get("calibrated") === "1");
        const n = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 50);
        const lane = url.searchParams.get("lane") ?? "agent";
        if (lane !== "all" && !isLane(lane)) return bad("lane must be agent, team or all");
        const byId = new Map(st.list.map((t) => [t.id, t]));
        const projectRef = url.searchParams.get("project");
        const project = projectRef ? findProject(projectRef) : null;
        if (projectRef && !project) return bad("unknown project");
        const picked = (lane === "all" ? st.list : st.lanes[lane].map((id) => byId.get(id)!)).filter((t) => !project || t.projectId === project.id);
        return json({
          planning: { schedule: st.automation.schedule, latest: st.automation.runs.find(r => r.status === "complete") ?? null },
          today: st.today, bold: st.bold, agreement: st.agreement, lane,
          needsHuman: st.interventions.open.map((i) => ({ id: i.id, taskId: i.taskId, taskTitle: i.taskTitle, kind: i.kind, need: i.need, createdBy: i.createdBy, createdAt: i.createdAt })),
          answered: st.interventions.recent.map((i) => ({ id: i.id, taskId: i.taskId, resolution: i.resolution, note: i.note, resolvedBy: i.resolvedBy, resolvedAt: i.resolvedAt })),
          // The agent side of the sync: what people changed lately (lanes, edits, starts, finishes, debriefs, answers).
          teamChanges: activity(new Map([...st.list, ...st.done].map((t) => [t.id, t.title] as [string, string])), false, { limit: 30, after: new Date(Date.now() - 7 * 86_400_000).toISOString() })
            .map(({ kind, taskId, taskTitle, who, at, result }) => ({ kind, taskId, taskTitle, who, at, ...(result ? { result } : {}) })),
          next: picked.slice(0, n).map((t, i) => ({
            rank: i + 1, overallRank: t.row.rank, lane: t.lane, directive: t.directive,
            id: t.id, title: t.title, status: t.status, owner: t.owner, track: t.track, projectId: t.projectId,
            doneWhen: t.doneWhen, steps: t.steps, reasons: t.reasons, moat: t.moat,
            value: t.row.value, pTop5: t.row.pTop, rankRange: [t.row.rankLo, t.row.rankHi], blockedBy: t.row.blockedBy,
            feeds: t.feeds.map((l) => ({ id: l.id, kind: l.kind, title: l.title })),
            fedBy: t.fedBy.map((l) => ({ id: l.id, kind: l.kind, title: l.title, status: l.status })),
          })),
          awaitingDebrief: st.questions.debriefs.map((d) => ({ taskId: d.taskId, title: d.title })),
          lessons: st.learning.lessons,
          projects: st.projects.filter((p) => p.status === "active" && (!project || p.id === project.id)).map((p) => ({ id: p.id, name: p.name, reports: p.reports.slice(0, 2), attention: p.attention.map((a) => `${a.severity}: ${a.text}`) })),
        });
      }
      // A person marks the agents' updates as read (agents may not: it is not in their routes).
      if (path === "/api/seen" && method === "POST") { markSeen(who); return json({ ok: true }); }
      if (path === "/api/automation" && method === "GET") return json(automationStatus());
      if (path === "/api/automation" && method === "PUT") {
        const parsed = automationSettingsSchema.safeParse(body());
        if (!parsed.success) return bad("Invalid planning settings or interval limits");
        try { updateAutomationSettings(parsed.data, who); } catch (e) { return bad(e instanceof Error ? e.message : "Invalid settings"); }
        return json(automationStatus());
      }
      if (path === "/api/automation/run" && method === "POST") {
        try { requestAutomationRun(who, new Date(), body().retryFailed === true); } catch (e) { return json({ error: e instanceof Error ? e.message : "Cannot queue planning" }, 409); }
        return json({ ok: true, queued: true });
      }
      // Projects: the registry, live context, and the scan's proposals (people adopt or dismiss them).
      if (path === "/api/projects" && method === "GET") return json({ projects: projectOverview(), scan: scanStatus() });
      if (path === "/api/projects" && method === "POST") return json({ id: createProject(body(), who) });
      const proj = path.match(/^\/api\/projects\/([\w-]+)$/);
      if (proj && method === "PATCH") { updateProject(proj[1], body(), who); return json({ ok: true }); }
      if (path === "/api/context" && method === "POST") return json(ingestContext(body(), who));
      if (path === "/api/context/report" && method === "POST") return json(ingestReports(body(), who));
      if (path === "/api/scan" && method === "GET") return json(scanStatus());
      if (path === "/api/scan" && method === "PUT") { updateScanSettings(body(), who); return json(scanStatus()); }
      if (path === "/api/scan/run" && method === "POST") {
        try { const id = await runScan({ who, judgeKey: cfg.judgeKey }); return json({ ok: true, runId: id, scan: scanStatus() }); }
        catch (e) { return json({ error: e instanceof Error ? e.message : "Cannot scan" }, 409); }
      }
      const cand = path.match(/^\/api\/scan\/candidates\/([\w-]+)\/(adopt|dismiss)$/);
      if (cand && method === "POST") {
        try {
          if (cand[2] === "dismiss") { dismissCandidate(cand[1], who); return json({ ok: true }); }
          const b = body();
          return json({ id: adoptCandidate(cand[1], who, isLane(b.lane) ? b.lane : undefined) });
        } catch (e) { return bad(e instanceof Error ? e.message : "Cannot decide this proposal"); }
      }
      // The game: Orion deals quests; a person can pass one back with a reason.
      if (path === "/api/quests/deal" && method === "POST" && !agent) return json({ dealt: dealQuests() });
      const qp = path.match(/^\/api\/quests\/([\w-]+)\/pass$/);
      if (qp && method === "POST" && !agent) {
        const reason = str(body().reason, 300);
        if (reason.length < 3) return bad("Say why you're passing, in a few words: Orion learns from it");
        try { return json({ ok: true, next: passQuest(qp[1], who, reason) }); } catch (e) { return bad(e instanceof Error ? e.message : "Cannot pass this quest"); }
      }
      // The daily email, per founder.
      if (path === "/api/digest" && method === "GET") return json(digestStatus());
      if (path === "/api/digest" && method === "PUT") {
        try { updateDigestSettings(body(), who, users.names); } catch (e) { if (e instanceof ZodError) throw e; return bad(e instanceof Error ? e.message : "Invalid email settings"); }
        return json(digestStatus());
      }
      if (path === "/api/digest/preview" && method === "GET" && !agent) { const d = buildDigest(who); return json({ subject: d.subject, text: d.text }); }
      if (path === "/api/digest/send" && method === "POST") {
        // Yourself by default; a teammate by name. Only to the address saved for them in the email settings.
        const to = body().to === undefined ? who : person(body().to);
        if (!to) return bad("to must be a team member");
        const r = await sendDigests({ only: to, force: true });
        return r.sent.length ? json({ ok: true, ...r }) : json({ error: digestStatus().sent[to]?.error ?? `No email address is set for ${to}, or email is not configured` }, 409);
      }
      const proposal = path.match(/^\/api\/automation\/([\w-]+)\/proposals\/([01])\/accept$/);
      if (proposal && method === "POST") {
        try {
          const id = adoptProposal(proposal[1], Number(proposal[2]), who, p => addTask({ title: p.title, detail: `${p.detail}\n\nPlanning sources: ${p.sourceUrls.join(", ") || "Workspace evidence"}`, doneWhen: p.doneWhen, steps: p.steps, lane: "agent", who }));
          return json({ id });
        } catch (e) { return bad(e instanceof Error ? e.message : "Cannot adopt this proposal"); }
      }
      if (path === "/api/health" && method === "GET") return json({ ok: true, ...buildState(who, false).health });
      if (path === "/api/state" && method === "GET") return json(buildState(who, url.searchParams.get("calibrated") === "1"));

      if (path === "/api/brief") {
        if (method === "GET") return json(getBrief());
        if (method === "PUT") {
          const text = str((body()).text, 4000);
          if (text.length < 40) return bad("The brief is too short to judge against");
          setBrief(text, who);
          return json({ ok: true });
        }
      }

      if (path === "/api/tasks" && method === "POST") {
        const b = body();
        const title = str(b.title, 200);
        if (!title) return bad("title required");
        const track = Object.hasOwn(TRACKS, b.track as string) ? (b.track as string) : "other";
        const projectId = b.projectId ? findProject(str(b.projectId, 100))?.id : null;
        if (b.projectId && !projectId) return bad("unknown project");
        return json({ id: addTask({ title, detail: str(b.detail), owner: person(b.owner), track, who, doneWhen: str(b.doneWhen, 400), steps: stepTexts(b.steps), lane: isLane(b.lane) ? b.lane : undefined, projectId }) });
      }

      const task = path.match(/^\/api\/tasks\/([\w-]+)(\/judge)?$/);
      if (task && method === "POST" && task[2]) {
        const current = getTask(task[1]);
        if (!current) return json({ error: "not found" }, 404);
        if (!["open", "doing"].includes(current.status)) return bad("only open work can be judged");
        if (current.judge === "pending") return json({ ok: true, queued: true });
        queueJudge(current.id);
        log("task.judge", who, current.id);
        return json({ ok: true });
      }
      if (task && method === "PATCH" && !task[2]) {
        const b = body(), id = task[1];
        const t = getTask(id);
        if (!t) return json({ error: "not found" }, 404);
        let unlocked: { id: string; title: string }[] = [];
        if (agent && (b.status === "dropped" || b.owner !== undefined)) return json({ error: "An agent may not drop a task or change its owner" }, 403);
        if (agent && b.lane !== undefined) return json({ error: "An agent may not move a task between lanes: raise an intervention instead" }, 403);
        if (b.lane !== undefined && !isLane(b.lane)) return bad("lane must be team or agent");
        if (b.status !== undefined && !["open", "doing", "done", "dropped"].includes(b.status as string)) return bad("bad status");
        if (b.owner !== undefined && b.owner !== null && !person(b.owner)) return bad("unknown owner");
        if (b.projectId !== undefined && b.projectId !== null && !getProject(str(b.projectId, 100))) return bad("unknown project");
        if (agent && (b.title !== undefined || b.detail !== undefined || b.track !== undefined || b.doneWhen !== undefined || b.projectId !== undefined)
            && t.created_by !== agent) return json({ error: "An agent may edit only the tasks it proposed" }, 403);
        if (agent && Array.isArray(b.steps)) {
          const current = JSON.parse(t.steps || "[]") as { text: string }[];
          const next = stepsOf(b.steps);
          if (next.length !== current.length || next.some((step, i) => step.text !== current[i].text)) return json({ error: "An agent may tick existing steps; it cannot rewrite the completion checklist" }, 403);
        }
        if (agent && (b.status === "doing" || b.status === "done" || Array.isArray(b.steps))) {
          const d = directive(allInterventions().filter(i => i.taskId === id));
          const blocked = allLinks().filter(l => l.to === id && l.kind === "unblocks" && ["open", "doing"].includes(getTask(l.from)?.status ?? ""));
          if (!actionable(d.action) || blocked.length) return json({ error: blocked.length ? "Finish prerequisite tasks before recording progress" : d.why, directive: d }, 409);
        }
        if (b.lane !== undefined) {
          db.query("UPDATE tasks SET lane = ? WHERE id = ?").run(b.lane, id);
          log("task.lane", who, id, { lane: b.lane });
        }
        if (b.status !== undefined) {
          if (b.status === "done" || b.status === "dropped") unlocked = wouldUnlock(id);
          setStatus(id, b.status as "open", who);
          // A finished or dropped quest frees its owner: Orion deals the next one right away.
          if (b.status === "done" || b.status === "dropped") dealQuests();
        }
        if (b.owner !== undefined) db.query("UPDATE tasks SET owner = ? WHERE id = ?").run(person(b.owner), id);
        // Ticking steps doesn't change what the task is, so it doesn't re-judge.
        if (Array.isArray(b.steps) && b.title === undefined && b.detail === undefined && b.doneWhen === undefined && b.track === undefined) {
          db.query("UPDATE tasks SET steps = ? WHERE id = ?").run(JSON.stringify(stepsOf(b.steps)), id);
          log("task.steps", who, id);
        }
        if (b.projectId !== undefined) {
          db.query("UPDATE tasks SET project_id = ? WHERE id = ?").run(b.projectId ? str(b.projectId, 100) : null, id);
          log("task.project", who, id, { project: b.projectId ?? null });
        }
        const edited = (b.title !== undefined && str(b.title, 200)) || b.detail !== undefined || b.track !== undefined || b.doneWhen !== undefined || b.projectId !== undefined;
        if (edited) {
          db.query("UPDATE tasks SET title = ?, detail = ?, track = ?, done_when = ?, steps = ? WHERE id = ?").run(
            str(b.title, 200) || t.title, b.detail !== undefined ? str(b.detail) : t.detail,
            Object.hasOwn(TRACKS, b.track as string) ? (b.track as string) : t.track,
            b.doneWhen !== undefined ? str(b.doneWhen, 400) : t.done_when,
            Array.isArray(b.steps) ? JSON.stringify(stepsOf(b.steps)) : t.steps, id);
          log("task.edit", who, id);
          queueJudge(id);
        }
        return json({ ok: true, unlocked });
      }

      if (path === "/api/answers" && method === "POST") {
        const b = body();
        recordAnswer(str(b.taskId), b.dim, b.level, who, b.note);
        log("answer", who, str(b.taskId), { dim: b.dim, level: b.level });
        return json({ ok: true });
      }

      // As soon as a task is done: how did it go, compared with what Orion expected?
      if (path === "/api/debriefs" && method === "POST") {
        const b = body(), t = getTask(str(b.taskId));
        if (!t || t.status !== "done") return bad("task is not done");
        if (agent) {
          const prior = db.query("SELECT who FROM debriefs WHERE task_id = ?").get(t.id) as { who: string | null } | null;
          if (prior && !isAgent(prior.who)) return json({ error: "A person already debriefed this task; an agent may not replace it" }, 403);
        }
        const effort = level(b.effort), defensibility = level(b.defensibility), quality = level(b.quality);
        if (!RESULTS.includes(b.result as (typeof RESULTS)[number]) || effort === null || defensibility === null || quality === null) return bad("result, effort, defensibility and quality are required");
        // INSERT OR REPLACE writes a new row, so a re-debrief starts unreviewed.
        db.query(`INSERT OR REPLACE INTO debriefs (task_id, who, at, result, effort, defensibility, quality, asset, metric, surprise, lesson, predicted, predicted_dist)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, who, now(), b.result as string, effort, defensibility, quality,
          str(b.asset) || null, str(b.metric) || null, str(b.surprise) || null, str(b.lesson) || null, JSON.stringify(outcomeForecast(t).levels), JSON.stringify(outcomeForecast(t).beliefs));
        log("debrief", who, t.id);
        // What this makes possible next: each line becomes a task, already fuelled by this one.
        const next = str(b.next, 1200).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 5);
        const created = next.map((title) => addTask({ title: title.slice(0, 200), track: t.track, who, fedBy: { from: t.id, kind: "boosts" } }));
        // Its evidence flows to every open task it feeds, which Orion re-judges.
        const rejudged = propagate(t.id, who);
        return json({ ok: true, created, rejudged });
      }

      // An agent asks a person for something it cannot do or decide; it shows first on the team's dashboard.
      if (path === "/api/interventions" && method === "POST") {
        const b = body(), t = getTask(str(b.taskId));
        if (!t) return bad("unknown task");
        if (!isKind(b.kind)) return bad(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
        const need = str(b.need, 600);
        if (need.length < 10) return bad("say what is needed, in a sentence");
        const open = db.query("SELECT COUNT(*) n FROM interventions WHERE task_id = ? AND status = 'open'").get(t.id) as { n: number };
        if (open.n >= 3) return bad("this task already has 3 open requests: wait, or withdraw one");
        const r = db.query("INSERT INTO interventions (task_id, kind, need, tried, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
          .get(t.id, b.kind as string, need, str(b.tried, 600) || null, who, now()) as { id: number };
        log("intervention.open", who, t.id, { id: r.id, kind: b.kind });
        return json({ id: r.id });
      }
      const iv = path.match(/^\/api\/interventions\/(\d+)$/);
      if (iv && method === "PATCH") {
        const b = body(), cur = getIntervention(Number(iv[1]));
        if (!cur) return json({ error: "not found" }, 404);
        if (cur.status !== "open") return bad("already answered");
        const resolution = b.resolution as string;
        // A person answers; an agent may only withdraw its own request (it found a way, or no longer needs it).
        if (agent ? !(resolution === "withdrawn" && cur.createdBy === agent) : !["done", "declined", "workaround", "withdrawn"].includes(resolution)) {
          return agent ? json({ error: "An agent may only withdraw its own request; a person answers it" }, 403) : bad("resolution must be done, declined, workaround or withdrawn");
        }
        if (agent && ["approval", "credential", "spend", "legal"].includes(cur.kind)) return json({ error: "A person must resolve an authority request; an agent cannot withdraw it to authorize itself" }, 403);
        db.query("UPDATE interventions SET status = 'resolved', resolution = ?, note = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
          .run(resolution, str(b.note, 600) || null, who, now(), cur.id);
        log("intervention.resolve", who, cur.taskId, { id: cur.id, resolution });
        return json({ ok: true });
      }

      // A person confirms or disputes an agent's own debrief: confirmed counts fully in the agent lane, disputed not at all.
      const rv = path.match(/^\/api\/debriefs\/([\w-]+)\/review$/);
      if (rv && method === "POST") {
        const b = body();
        const d = db.query("SELECT who FROM debriefs WHERE task_id = ?").get(rv[1]) as { who: string | null } | null;
        if (!d || !isAgent(d.who)) return bad("only an agent's debrief is reviewed");
        if (b.verdict !== "confirmed" && b.verdict !== "disputed") return bad("verdict must be confirmed or disputed");
        db.query("UPDATE debriefs SET review = ?, reviewed_by = ?, reviewed_at = ? WHERE task_id = ?").run(b.verdict as string, who, now(), rv[1]);
        log("debrief.review", who, rv[1], { verdict: b.verdict });
        const rejudged = propagate(rv[1], who);
        return json({ ok: true, rejudged });
      }

      if (path === "/api/links" && (method === "POST" || method === "DELETE")) {
        const b = body();
        const from = str(b.from), to = str(b.to);
        if (!getTask(from) || !getTask(to)) return bad("unknown task");
        if (method === "DELETE") {
          db.query("DELETE FROM links WHERE from_id = ? AND to_id = ?").run(from, to);
          log("link.remove", who, from, { to });
          return json({ ok: true });
        }
        const kind = b.kind === "unblocks" ? "unblocks" : b.kind === "boosts" ? "boosts" : null;
        if (!kind) return bad("kind must be unblocks or boosts");
        const existing = allLinks().find(l => l.from === from && l.to === to);
        if (agent && existing && existing.kind !== kind) return json({ error: "An agent may add links but cannot replace an existing dependency" }, 403);
        if (wouldCycle(allLinks().filter((l) => !(l.from === from && l.to === to)), from, to)) return bad("That link would make a loop: the second task already feeds the first");
        db.query("INSERT OR REPLACE INTO links (from_id, to_id, kind, who, at) VALUES (?, ?, ?, ?, ?)").run(from, to, kind as LinkKind, who, now());
        log("link.add", who, from, { to, kind });
        return json({ ok: true });
      }

      if (path === "/api/followups" && method === "POST") { const b = body(); recordFollowUp(str(b.taskId), b, who); return json({ ok: true }); }
      if (path === "/api/metrics" && method === "POST") { const b = body(); recordMetric(b.name, b.value, who); return json({ ok: true }); }

      // The daily check-in: one submission per person per Kigali day, carrying everything at once.
      if (path === "/api/checkins" && method === "POST") {
        const b = body();
        const updates = (b.updates ?? {}) as Record<string, { state?: string; note?: string }>;
        db.transaction(() => {
          for (const [taskId, u] of Object.entries(updates)) {
            if (!getTask(taskId)) continue;
            if (u.state === "done") setStatus(taskId, "done", who);
            else if (u.state === "drop") setStatus(taskId, "dropped", who);
            else if (u.state === "start") setStatus(taskId, "doing", who);
          }
          for (const a of (b.answers ?? []) as Body[]) recordAnswer(str(a.taskId), a.dim, a.level, who);
          for (const f of (b.followUps ?? []) as Body[]) recordFollowUp(str(f.taskId), f, who);
          for (const [name, value] of Object.entries((b.metrics ?? {}) as Record<string, unknown>)) {
            if (value !== null && value !== "" && value !== undefined) recordMetric(name, Number(value), who);
          }
          db.query("INSERT OR REPLACE INTO checkins (who, date, at, updates, learned, blocker) VALUES (?, ?, ?, ?, ?, ?)")
            .run(who, kigaliDay(new Date()), now(), JSON.stringify(updates), str(b.learned) || null, str(b.blocker) || null);
        })();
        log("checkin", who, null);
        return json({ ok: true });
      }

      // Every data point we hold, for the outcome loop and the decider model.
      if (path === "/api/export" && method === "GET") {
        const all = (t: string) => db.query(`SELECT * FROM ${t}`).all();
        return json({
          exportedAt: now(), tasks: all("tasks"), answers: all("answers"), debriefs: all("debriefs"), followups: all("followups"),
          checkins: all("checkins"), metrics: all("metrics"), events: all("events"), settings: all("settings"), links: all("links"),
          forecasts: all("forecasts"), interventions: all("interventions"), automationRuns: all("automation_runs"),
          projects: all("projects"), projectSignals: all("project_signals"), scanRuns: all("scan_runs"), scanCandidates: all("scan_candidates"),
          conversationThreads: all("conversation_threads"), conversationMessages: all("conversation_messages"), conversationAttempts: all("conversation_attempts"),
        }, 200, { "content-disposition": `attachment; filename="compass-${kigaliDay(new Date())}.json"` });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof ZodError) return bad(e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
      if (e instanceof Error && /^Unknown project$/.test(e.message)) return json({ error: e.message }, 404);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  };
}
