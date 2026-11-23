// Reads the store and builds everything the page shows: the ranked list, today's questions, goals and learning.
import { automationStatus } from "./automation-store.ts";
import { workspaceHealth } from "./health.ts";
import { db, log, now, uid } from "./db.ts";
import { DIMS, uniform, expectedLevel, type Dim, type Dims } from "./dims.ts";
import { rank } from "./rank.ts";
import { moatVerdict } from "./value.ts";
import { calibrated, effortScale, learn, MEASURED, type Learned, type Observation } from "./calibrate.ts";
import { daily, followUps, kigaliDay, pendingDebriefs, voiQuestions, type TaskLite } from "./questions.ts";
import { fromPoint } from "../../orion/src/decision-engine/creative.ts";
import { companyContext, hash, judge, type Judgment } from "./judge.ts";
import { projectContext, projectOverview } from "./projects.ts";
import { gameState } from "./game.ts";
import { DEFAULT_BRIEF } from "./brief.ts";
import { reasons } from "./reasons.ts";
import { unlockedBy, type Link, type LinkKind } from "./flow.ts";
import type { Graph } from "./rank.ts";
import { actionable, agentLaneWeight, AGENT_SHRINK, directive, isLane, type Directive, type Intervention, type Lane } from "./lanes.ts";
import { isAgent } from "./auth.ts";

export const METRICS = [
  { name: "Argus revenue collected (USD)", goal: 50_000 },
  { name: "Paying Argus customers", goal: 25 },
  { name: "Strangers who installed Argus", goal: 25 },
  { name: "Server owners we talked to", goal: 30 },
  { name: "Capabilities live-tested (of 54)", goal: 54 },
  { name: "Owner verdicts collected", goal: 1_000 },
] as const;

/** A team answer replaces Orion's belief on that dimension with a confident point. */
const TEAM_CONFIDENCE = 0.9;

export interface TaskRow {
  id: string; title: string; detail: string; owner: string | null; track: string; status: TaskLite["status"];
  dims: string | null; judge: string; judge_error: string | null; judged_at: string | null;
  created_by: string | null; created_at: string; started_at: string | null; done_at: string | null;
  done_when: string; steps: string; lane: Lane;
  judge_revision: number; forecast_snapshot: string | null; judged_brief_hash: string | null; project_id: string | null;
}
export interface Step { text: string; done: boolean }
interface AnswerRow { task_id: string; dim: Dim; level: number; who: string | null; note: string | null; at: string }

const allTasks = () => db.query("SELECT * FROM tasks ORDER BY created_at").all() as TaskRow[];
const lite = (t: TaskRow): TaskLite => ({ id: t.id, title: t.title, owner: t.owner, status: t.status, doneAt: t.done_at, startedAt: t.started_at });

function latestAnswers(): Map<string, AnswerRow> {
  const rows = db.query("SELECT task_id, dim, level, who, note, at FROM answers ORDER BY id").all() as AnswerRow[];
  return new Map(rows.map((r) => [`${r.task_id}:${r.dim}`, r]));
}

/** Orion's belief, corrected by our track record if asked, with the team's answers on top (they always win). */
export function effectiveDims(t: TaskRow, answers: Map<string, AnswerRow>, learned?: Learned): Dims {
  const raw = t.dims ? (JSON.parse(t.dims) as Dims) : null;
  const judged = raw && learned ? calibrated(raw, learned) : raw;
  return Object.fromEntries(DIMS.map((d) => {
    const a = answers.get(`${t.id}:${d}`);
    return [d, a ? fromPoint(a.level, TEAM_CONFIDENCE) : judged?.[d] ?? uniform()];
  })) as Dims;
}

function observations(): Observation[] {
  const obs: Observation[] = [];
  // An agent's debrief is evidence for the team to read, not ground truth for the calibrator: an agent grading its
  // own work could teach Orion its optimism. Only people's debriefs and follow-ups train the corrections.
  for (const d of db.query("SELECT * FROM debriefs WHERE who IS NULL OR who NOT LIKE '% (agent)'").all() as { predicted: string; predicted_dist: string | null; effort: number; defensibility: number; quality: number }[]) {
    const p = JSON.parse(d.predicted) as Record<string, number>;
    const dist = d.predicted_dist ? (JSON.parse(d.predicted_dist) as Record<string, number[]>) : {};
    for (const dim of ["effort", "defensibility", "quality"] as const) obs.push({ dim, predicted: p[dim], actual: d[dim], dist: dist[dim] });
  }
  for (const f of db.query("SELECT impact, predicted_impact, predicted_dist FROM followups").all() as { impact: number; predicted_impact: number; predicted_dist: string | null }[]) {
    obs.push({ dim: "impact", predicted: f.predicted_impact, actual: f.impact, dist: f.predicted_dist ? (JSON.parse(f.predicted_dist) as Record<string, number[]>).impact : undefined });
  }
  return obs;
}

/**
 * What the agent lane learns from: debriefs and follow-ups of agent-lane tasks, people's at full weight, an agent's own
 * at half until a person confirms it (src/lanes.ts). Separate from the team lane, which never sees agent self-reports.
 */
function agentObservations(): Observation[] {
  const obs: Observation[] = [];
  for (const d of db.query("SELECT d.* FROM debriefs d JOIN tasks t ON t.id = d.task_id WHERE t.lane = 'agent'").all() as { who: string | null; review: string | null; predicted: string; predicted_dist: string | null; effort: number; defensibility: number; quality: number }[]) {
    const w = agentLaneWeight(d.who, d.review, isAgent);
    const p = JSON.parse(d.predicted) as Record<string, number>;
    const dist = d.predicted_dist ? (JSON.parse(d.predicted_dist) as Record<string, number[]>) : {};
    for (const dim of ["effort", "defensibility", "quality"] as const) obs.push({ dim, predicted: p[dim], actual: d[dim], dist: dist[dim], w });
  }
  for (const f of db.query("SELECT f.impact, f.predicted_impact, f.predicted_dist FROM followups f JOIN tasks t ON t.id = f.task_id WHERE t.lane = 'agent'").all() as { impact: number; predicted_impact: number; predicted_dist: string | null }[]) {
    obs.push({ dim: "impact", predicted: f.predicted_impact, actual: f.impact, dist: f.predicted_dist ? (JSON.parse(f.predicted_dist) as Record<string, number[]>).impact : undefined });
  }
  return obs;
}

interface InterventionRow { id: number; task_id: string; kind: string; need: string; tried: string | null; status: string; created_by: string; created_at: string; resolved_by: string | null; resolved_at: string | null; resolution: string | null; note: string | null }
const toIntervention = (r: InterventionRow): Intervention => ({
  id: r.id, taskId: r.task_id, kind: r.kind as Intervention["kind"], need: r.need, tried: r.tried, status: r.status as Intervention["status"],
  createdBy: r.created_by, createdAt: r.created_at, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at,
  resolution: r.resolution as Intervention["resolution"], note: r.note,
});
export function allInterventions(): Intervention[] {
  return (db.query("SELECT * FROM interventions ORDER BY id").all() as InterventionRow[]).map(toIntervention);
}
export function getIntervention(id: number): Intervention | null {
  const r = db.query("SELECT * FROM interventions WHERE id = ?").get(id) as InterventionRow | null;
  return r ? toIntervention(r) : null;
}

export function lessons(limit = 6, includeUnconfirmedAgent = false): string[] {
  return (db.query("SELECT t.title, d.lesson, d.who, d.review FROM debriefs d JOIN tasks t ON t.id = d.task_id WHERE d.lesson IS NOT NULL AND d.lesson != '' AND (d.who IS NULL OR d.who NOT LIKE '% (agent)' OR d.review = 'confirmed' OR (? = 1 AND d.review IS NULL)) ORDER BY d.at DESC LIMIT ?").all(includeUnconfirmedAgent ? 1 : 0, limit) as { title: string; lesson: string; who: string | null; review: string | null }[])
    .map((r) => `${isAgent(r.who) && r.review !== "confirmed" ? "[Unconfirmed agent report] " : ""}${r.title}: ${r.lesson}`);
}

export function buildState(who: string | null, useCalibration: boolean, clock = new Date()) {
  const tasks = allTasks();
  const answers = latestAnswers();
  const learned = learn(observations());
  // The agent lane learns faster and always applies what it learned to its own tasks (src/lanes.ts).
  const agentLearned = learn(agentObservations(), AGENT_SHRINK, true);
  const effort = useCalibration ? effortScale(learned.effort) : undefined;
  const live = tasks.filter((t) => t.status === "open" || t.status === "doing");
  const graph = loadGraph(tasks);
  const titleOf = new Map(tasks.map((t) => [t.id, t.title]));
  const judged = live.map((t) => {
    const lane: Lane = isLane(t.lane) ? t.lane : "team";
    return { id: t.id, title: t.title, effort: lane === "agent" ? (size: number) => size : undefined, dims: effectiveDims(t, answers, lane === "agent" ? agentLearned : useCalibration ? learned : undefined) };
  });
  const interventions = allInterventions();
  const ivsByTask = new Map<string, Intervention[]>();
  for (const iv of interventions) (ivsByTask.get(iv.taskId) ?? ivsByTask.set(iv.taskId, []).get(iv.taskId)!).push(iv);
  const ranking = rank(judged, graph, { effort });
  const dimsById = new Map(judged.map((j) => [j.id, j.dims]));

  const debriefed = new Set((db.query("SELECT task_id FROM debriefs").all() as { task_id: string }[]).map((r) => r.task_id));
  const followed = new Set((db.query("SELECT task_id FROM followups").all() as { task_id: string }[]).map((r) => r.task_id));
  const answered = new Set(answers.keys());
  const lites = tasks.map(lite);
  const today = kigaliDay(clock);
  const checkedToday = (db.query("SELECT who FROM checkins WHERE date = ?").all(today) as { who: string }[]).map((r) => r.who);
  const last = who ? (db.query("SELECT date FROM checkins WHERE who = ? ORDER BY date DESC LIMIT 1").get(who) as { date: string } | null)?.date ?? null : null;
  const dailyCheckIn = who ? daily(who, clock, last, lites, followUps(lites, followed, clock), voiQuestions(judged, answered, graph, effort)) : null;

  const metricRows = db.query("SELECT name, value, who, at FROM metrics ORDER BY at").all() as { name: string; value: number; who: string | null; at: string }[];
  const metrics = METRICS.map((m) => {
    const hist = metricRows.filter((r) => r.name === m.name);
    return { ...m, value: hist.at(-1)?.value ?? null, at: hist.at(-1)?.at ?? null, history: hist.map((h) => ({ value: h.value, at: h.at })) };
  });

  const done = tasks.filter((t) => t.status === "done").reverse().map((t) => ({
    ...pub(t, null, answers),
    debrief: db.query("SELECT * FROM debriefs WHERE task_id = ?").get(t.id) ?? null,
    followup: db.query("SELECT * FROM followups WHERE task_id = ?").get(t.id) ?? null,
  }));
  const outcomes = db.query("SELECT result, COUNT(*) n FROM debriefs GROUP BY result").all() as { result: string; n: number }[];

  const list = ranking.rows.map((r) => {
    const t = tasks.find((x) => x.id === r.optionId)!;
    const link = (l: { id: string; kind: LinkKind }) => ({ ...l, title: titleOf.get(l.id) ?? "", status: tasks.find((x) => x.id === l.id)?.status ?? "open" });
    const requestDirective = directive(ivsByTask.get(t.id) ?? [], clock);
    const d: Directive = actionable(requestDirective.action) && r.blockedBy.length
      ? { action: "wait", why: `Finish prerequisite work: ${r.blockedBy.map(id => titleOf.get(id) ?? id).join("; ")}` }
      : requestDirective;
    return {
      ...pub(t, dimsById.get(r.optionId)!, answers), row: r, directive: d, moat: moatVerdict(dimsById.get(r.optionId)),
      openInterventions: (ivsByTask.get(t.id) ?? []).filter((i) => i.status === "open").length,
      reasons: reasons(r.level, t.track, r.door, { waitingOn: r.blockedBy.length ? titleOf.get(r.blockedBy[0]) : undefined, unlocks: r.unlocks.length, boosts: r.boosts.length }),
      feeds: graph.links.filter((l) => l.from === t.id).map((l) => link({ id: l.to, kind: l.kind })),
      fedBy: graph.links.filter((l) => l.to === t.id).map((l) => link({ id: l.from, kind: l.kind })),
    };
  });

  // Each lane in Orion's order (one ranking, so the flow between lanes counts); an agent's actionable work first.
  const laneIds = (lane: Lane) => list.filter((t) => t.lane === lane).map((t) => t.id);
  const agentOrder = [...list.filter((t) => t.lane === "agent")]
    .sort((a, b) => Number(actionable(b.directive.action)) - Number(actionable(a.directive.action)) || a.row.rank - b.row.rank).map((t) => t.id);
  const live_ = new Set(live.map((t) => t.id));
  const needsYou = interventions.filter((i) => i.status === "open").map((i) => ({
    ...i, taskTitle: titleOf.get(i.taskId) ?? "", taskLive: live_.has(i.taskId), directive: directive(ivsByTask.get(i.taskId) ?? [], clock),
  }));
  const recentlyAnswered = interventions.filter((i) => i.status === "resolved").slice(-10).reverse()
    .map((i) => ({ ...i, taskTitle: titleOf.get(i.taskId) ?? "" }));

  const brief = getBrief();
  const health = workspaceHealth({
    tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, lane: t.lane, doneWhen: t.done_when, judge: t.judge, startedAt: t.started_at, judgedAt: t.judged_at, judgedBriefHash: t.judged_brief_hash })),
    blocked: list.filter(t => t.row.blockedBy.length || !actionable(t.directive.action)).length,
    debriefs: pendingDebriefs(lites, debriefed), followUps: followUps(lites, followed, clock), openInterventions: needsYou.filter(i => i.taskLive).length,
    missingMetrics: metrics.filter(m => m.value === null).length, briefAt: brief.at, briefHash: hash(brief.text),
  }, clock);
  return {
    automation: automationStatus(clock),
    projects: projectOverview(clock),
    game: gameState(clock),
    health,
    today,
    who,
    lanes: { team: laneIds("team"), agent: agentOrder },
    interventions: { open: needsYou, recent: recentlyAnswered },
    agentLearning: { ...agentLearned, shrink: AGENT_SHRINK, unreviewed: unreviewedAgentDebriefs() },
    agentActivity: agentActivity(titleOf),
    // What the agents did since this person last looked: the human side of the sync.
    agentUpdates: who && !isAgent(who) ? { since: lastSeen(who), items: activity(titleOf, true, { limit: 40, after: lastSeen(who) }) } : null,
    calibratedView: useCalibration,
    agreement: ranking.agreement,
    bold: ranking.bold,
    list,
    focus: who ? focusFor(who, list.filter((t) => t.lane === "team")) : null,
    questions: {
      debriefs: pendingDebriefs(lites, debriefed).map((d) => ({ ...d, predicted: outcomeForecast(tasks.find((t) => t.id === d.taskId)!).levels })),
      daily: dailyCheckIn ? {
        ...dailyCheckIn,
        followUps: dailyCheckIn.followUps.map((f) => ({ ...f, predictedImpact: outcomeForecast(tasks.find((t) => t.id === f.taskId)!).levels.impact })),
      } : null,
      checkedToday,
    },
    metrics,
    learning: { ...learned, outcomes, lessons: lessons(10), dataPoints: dataPoints(), judge: judgeLedger() },
    done,
    dropped: tasks.filter((t) => t.status === "dropped").map((t) => ({ id: t.id, title: t.title })),
    links: graph.links,
  };
}

function pub(t: TaskRow, dims: Dims | null, answers: Map<string, AnswerRow>) {
  return {
    id: t.id, title: t.title, detail: t.detail, owner: t.owner, track: t.track, status: t.status, judge: t.judge, judgeError: t.judge_error,
    lane: (isLane(t.lane) ? t.lane : "team") as Lane, createdBy: t.created_by, projectId: t.project_id ?? null,
    judgedAt: t.judged_at, judgedBriefHash: t.judged_brief_hash, forecastCapturedAt: t.forecast_snapshot ? (JSON.parse(t.forecast_snapshot) as { at: string }).at : null,
    createdAt: t.created_at, startedAt: t.started_at, doneAt: t.done_at, dims,
    doneWhen: t.done_when ?? "", steps: JSON.parse(t.steps || "[]") as Step[],
    teamAnswers: DIMS.filter((d) => answers.has(`${t.id}:${d}`)).map((d) => ({ ...answers.get(`${t.id}:${d}`)!, dim: d })),
  };
}

/** Orion's expected level (0–4) for the measured dimensions, as it stands now: the prediction a debrief is compared to. */
export function predictedLevels(t: TaskRow, answers = latestAnswers()) {
  const dims = effectiveDims(t, answers);
  const r = (d: Dim) => Math.round(expectedLevel(dims[d]) * 100) / 100;
  return { effort: r("effort"), impact: r("impact"), defensibility: r("defensibility"), quality: r("quality") };
}

/**
 * What Orion believed about the measured dimensions, before the team's answers: the forecast a proper score grades.
 * Missing (never judged) is a uniform belief, which scores as "no idea".
 */
export function predictedBeliefs(t: TaskRow): Record<string, number[]> {
  const raw = t.dims ? (JSON.parse(t.dims) as Dims) : null;
  return Object.fromEntries(MEASURED.map((d) => [d, raw?.[d] ?? uniform()]));
}

/** Captured before execution, or at completion when work was never started in Compass.
 * Legacy tasks use their previously recorded outcome forecast where available; no history is fabricated. */
export function outcomeForecast(t: TaskRow): { levels: ReturnType<typeof predictedLevels>; beliefs: Record<string, number[]>; at: string | null } {
  if (t.forecast_snapshot) return JSON.parse(t.forecast_snapshot);
  const prior = db.query<{ predicted: string; predicted_dist: string | null; at: string }>("SELECT predicted, predicted_dist, at FROM debriefs WHERE task_id = ?").get(t.id);
  return { levels: prior ? JSON.parse(prior.predicted) : predictedLevels(t), beliefs: prior?.predicted_dist ? JSON.parse(prior.predicted_dist) : predictedBeliefs(t), at: null };
}

/** The forecast ledger in brief: which models answered, and how often the two level orders disagreed. */
export function judgeLedger() {
  const rows = db.query("SELECT model, prompt_hash, disagreement FROM forecasts").all() as { model: string; prompt_hash: string; disagreement: string }[];
  const models = [...new Set(rows.map((r) => r.model))];
  const ds = rows.flatMap((r) => Object.values(JSON.parse(r.disagreement) as Record<string, number>));
  const mean = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
  return { forecasts: rows.length, models, prompts: new Set(rows.map((r) => r.prompt_hash)).size, orderDisagreement: Math.round(mean * 1000) / 1000 };
}

export interface Activity { id: number; kind: string; taskId: string | null; taskTitle: string; who: string; at: string; result?: string | null; asset?: string | null }

/**
 * Events, newest first: the kind, the task, who, when, and for a debrief its result and what it left us. No raw
 * payloads (they can hold free text). `agents` picks whose: agents' events, or people's.
 */
export function activity(titleOf: Map<string, string>, agents: boolean, opts: { limit?: number; after?: string | null } = {}): Activity[] {
  const rows = db.query(`SELECT e.id, e.kind, e.task_id, e.who, e.at, d.result, d.asset FROM events e
    LEFT JOIN debriefs d ON e.kind = 'debrief' AND d.task_id = e.task_id
    WHERE e.who ${agents ? "LIKE" : "NOT LIKE"} '% (agent)' AND e.kind NOT IN ('login', 'checkin', 'context.sync', 'context.report') AND e.at > ? ORDER BY e.id DESC LIMIT ?`)
    .all(opts.after ?? "", opts.limit ?? 25) as { id: number; kind: string; task_id: string | null; who: string; at: string; result: string | null; asset: string | null }[];
  return rows.map((e) => ({ id: e.id, kind: e.kind, taskId: e.task_id, taskTitle: e.task_id ? titleOf.get(e.task_id) ?? "" : "", who: e.who, at: e.at,
    ...(e.kind === "debrief" ? { result: e.result, asset: e.asset } : {}) }));
}
export const agentActivity = (titleOf: Map<string, string>, limit = 25) => activity(titleOf, true, { limit });

/** When a person last marked the agents' updates as read (settings row `seen:<name>`). */
export function lastSeen(who: string): string | null {
  return (db.query("SELECT value FROM settings WHERE key = ?").get(`seen:${who}`) as { value: string } | null)?.value ?? null;
}
export function markSeen(who: string, at = now()) {
  db.query("INSERT OR REPLACE INTO settings (key, value, who, at) VALUES (?, ?, ?, ?)").run(`seen:${who}`, at, who, at);
}

/** Agents' own debriefs no person has confirmed or disputed yet: they teach the agent lane at half weight. */
export function unreviewedAgentDebriefs(): { taskId: string; title: string; who: string; result: string }[] {
  return (db.query("SELECT d.task_id, t.title, d.who, d.result FROM debriefs d JOIN tasks t ON t.id = d.task_id WHERE d.who LIKE '% (agent)' AND d.review IS NULL ORDER BY d.at DESC").all() as { task_id: string; title: string; who: string; result: string }[])
    .map((r) => ({ taskId: r.task_id, title: r.title, who: r.who, result: r.result }));
}

export function dataPoints(): number {
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
  return n("SELECT COUNT(*) n FROM answers") + n("SELECT COUNT(*) n FROM debriefs") + n("SELECT COUNT(*) n FROM followups") + n("SELECT COUNT(*) n FROM checkins");
}

// --- mutations --------------------------------------------------------------------------------------------------

export function getTask(id: string) {
  return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
}

export function addTask(input: { title: string; detail?: string; owner?: string | null; track?: string; who?: string | null; doneWhen?: string; steps?: string[]; fedBy?: { from: string; kind: LinkKind }; lane?: Lane; projectId?: string | null; judged?: Judgment }) {
  const id = uid();
  const steps: Step[] = (input.steps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 12).map((text) => ({ text, done: false }));
  // An agent's proposals start in the agent lane; a person's in the team lane unless they say otherwise.
  const lane: Lane = isAgent(input.who ?? null) ? "agent" : input.lane ?? "team";
  db.query("INSERT INTO tasks (id, title, detail, owner, track, created_by, created_at, done_when, steps, lane, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title.trim(), (input.detail ?? "").trim(), input.owner || null, input.track || "other", input.who ?? null, now(),
      (input.doneWhen ?? "").trim(), JSON.stringify(steps), lane, input.projectId ?? null);
  // Link before judging, so the judge already sees the finished work that fuels this task.
  if (input.fedBy) db.query("INSERT OR IGNORE INTO links (from_id, to_id, kind, who, at) VALUES (?, ?, ?, ?, ?)").run(input.fedBy.from, id, input.fedBy.kind, input.who ?? null, now());
  log("task.add", input.who ?? null, id, { title: input.title });
  // Already judged (an adopted scan candidate): keep that judgment and its ledger entry instead of paying for another.
  if (input.judged) {
    const at = now(), briefHash = hash(getBrief().text);
    db.query("UPDATE tasks SET dims = ?, judge = 'jev', judged_at = ?, judged_brief_hash = ? WHERE id = ?").run(JSON.stringify(input.judged.dims), at, briefHash, id);
    db.query("INSERT INTO forecasts (task_id, at, model, prompt_hash, dims, disagreement, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, at, input.judged.model, input.judged.promptHash, JSON.stringify(input.judged.dims), JSON.stringify(input.judged.disagreement), input.judged.tokens);
  } else queueJudge(id);
  return id;
}

export function setStatus(id: string, status: TaskLite["status"], who: string | null) {
  const t = getTask(id);
  if (!t) throw new Error("no such task");
  if (t.status === status) return; // Retries must not move completion time or duplicate activity.
  const at = now();
  if ((status === "doing" || status === "done") && !t.forecast_snapshot) {
    db.query("UPDATE tasks SET forecast_snapshot = ? WHERE id = ? AND forecast_snapshot IS NULL").run(JSON.stringify({ levels: predictedLevels(t), beliefs: predictedBeliefs(t), at }), id);
  }
  db.query(`UPDATE tasks SET status = ?, started_at = CASE WHEN ? = 'doing' AND started_at IS NULL THEN ? ELSE started_at END,
    done_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END WHERE id = ?`).run(status, status, at, status, at, id);
  if (status === "doing" && who && !isAgent(who) && !t.owner) db.query("UPDATE tasks SET owner = ? WHERE id = ? AND owner IS NULL").run(who, id);
  log(`task.${status}`, who, id);
  if (["open", "doing"].includes(status) && t.judge === "pending") kick();
}

// --- judging -----------------------------------------------------------------------------------------------------
// queueJudge marks a task pending and calls `kick`; the host decides when judgePending runs (Bun: right away, in the
// background; the Durable Object: from an alarm, which survives restarts and retries). Three requests at a time.

let kick: () => void = () => {};
export function onJudgeQueued(fn: () => void) { kick = fn; }
let apiKey: string | undefined;
export function setJudgeKey(key: string | undefined) { apiKey = key; }

export function queueJudge(id: string) {
  db.query("UPDATE tasks SET judge = 'pending', judge_error = NULL, judge_revision = judge_revision + 1 WHERE id = ?").run(id);
  kick();
}

const CONCURRENCY = 3;
export const JUDGE_BATCH = 12;
let draining: Promise<number> | null = null;
/** One drain at a time. Small batches fit host lifetimes; remaining work gets another alarm. */
export function judgePending(options: { judgeTask?: typeof judge; batch?: number } = {}): Promise<number> {
  if (draining) return draining;
  draining = drainJudgments(options).finally(() => { draining = null; });
  return draining;
}
async function drainJudgments(options: { judgeTask?: typeof judge; batch?: number }): Promise<number> {
  const ids = (db.query("SELECT id FROM tasks WHERE judge = 'pending' AND status IN ('open', 'doing') ORDER BY created_at LIMIT ?").all(options.batch ?? JUDGE_BATCH) as { id: string }[]).map((r) => r.id);
  const brief = getBrief().text, briefHash = hash(brief);
  const runJudge = options.judgeTask ?? judge;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const t = getTask(ids[next++]);
      if (!t || t.judge !== "pending" || !["open", "doing"].includes(t.status)) continue;
      try {
        const j = await runJudge(t, projectContext(t.project_id) + companyContext(brief, lessons(6, t.lane === "agent"), upstreamEvidence(t.id)), apiKey);
        // Edits can arrive while the provider is answering. Only the exact queued revision may commit.
        db.transaction(() => {
          const current = getTask(t.id);
          if (!current || current.judge !== "pending" || current.judge_revision !== t.judge_revision || !["open", "doing"].includes(current.status) || hash(getBrief().text) !== briefHash) return;
          const at = now();
          db.query("UPDATE tasks SET dims = ?, judge = 'jev', judge_error = NULL, judged_at = ?, judged_brief_hash = ? WHERE id = ?").run(JSON.stringify(j.dims), at, briefHash, t.id);
          db.query("INSERT INTO forecasts (task_id, at, model, prompt_hash, dims, disagreement, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(t.id, at, j.model, j.promptHash, JSON.stringify(j.dims), JSON.stringify(j.disagreement), j.tokens);
        })();
      } catch (e) {
        // An old failure must not erase a newer pending request either.
        db.query("UPDATE tasks SET judge = 'error', judge_error = ? WHERE id = ? AND judge = 'pending' AND judge_revision = ?")
          .run(String(e instanceof Error ? e.message : e).slice(0, 300), t.id, t.judge_revision);
      }
    }
  };
  try { await Promise.all(Array.from({ length: CONCURRENCY }, worker)); }
  finally { if (db.query("SELECT id FROM tasks WHERE judge = 'pending' AND status IN ('open', 'doing') LIMIT 1").get()) kick(); }
  return ids.length;
}

// --- company brief ------------------------------------------------------------------------------------------------

export function getBrief(): { text: string; who: string | null; at: string | null } {
  const row = db.query("SELECT value, who, at FROM settings WHERE key = 'brief'").get() as { value: string; who: string | null; at: string } | null;
  return row ? { text: row.value, who: row.who, at: row.at } : { text: DEFAULT_BRIEF, who: null, at: null };
}

export function setBrief(text: string, who: string | null) {
  db.query("INSERT OR REPLACE INTO settings (key, value, who, at) VALUES ('brief', ?, ?, ?)").run(text, who, now());
  log("brief", who, null);
}

/** The one task to put in front of a person: what they already have in progress, else the highest-ranked task that
 * is theirs or nobody's. */
export function focusFor<T extends { id: string; owner: string | null; status: string; row?: { blockedBy: string[] } }>(who: string, list: T[]): { id: string; why: string } | null {
  const doing = list.find((t) => t.status === "doing" && t.owner === who);
  if (doing) return { id: doing.id, why: "You have this in progress" };
  const i = list.findIndex((t) => t.status === "open" && (t.owner === who || !t.owner) && !t.row?.blockedBy.length);
  if (i < 0) return null;
  return { id: list[i].id, why: i === 0 ? "Orion ranks this first for the company" : `Orion's top task for you (#${i + 1} overall)` };
}

// --- the flow between tasks ---------------------------------------------------------------------------------------

export function allLinks(): Link[] {
  return (db.query("SELECT from_id, to_id, kind FROM links ORDER BY at").all() as { from_id: string; to_id: string; kind: LinkKind }[])
    .map((l) => ({ from: l.from_id, to: l.to_id, kind: l.kind }));
}

function loadGraph(tasks: TaskRow[]): Graph {
  return { links: allLinks(), status: new Map(tasks.map((t) => [t.id, t.status])) };
}

/** What finished feeder tasks tell the judge about this one: their result, what they left us, their lesson. */
export function upstreamEvidence(id: string): string[] {
  const rows = db.query(`SELECT t.title, l.kind, d.result, d.asset, d.lesson, d.surprise, d.who, d.review FROM links l
    JOIN tasks t ON t.id = l.from_id LEFT JOIN debriefs d ON d.task_id = t.id AND (d.who IS NULL OR d.who NOT LIKE '% (agent)' OR d.review = 'confirmed' OR (? = 1 AND d.review IS NULL))
    WHERE l.to_id = ? AND t.status = 'done'`).all(getTask(id)?.lane === "agent" ? 1 : 0, id) as { title: string; kind: LinkKind; result: string | null; asset: string | null; lesson: string | null; surprise: string | null; who: string | null; review: string | null }[];
  return rows.map((r) => [
    `"${r.title}" (${r.kind === "unblocks" ? "was a prerequisite" : "boosts this"}) is recorded done`,
    r.result ? `result ${r.result.replace("-", " ")} than expected` : "",
    r.asset ? `left us: ${r.asset}` : "", r.surprise ? `surprise: ${r.surprise}` : "", r.lesson ? `${isAgent(r.who) && r.review !== "confirmed" ? "unconfirmed agent lesson" : "lesson"}: ${r.lesson}` : "",
  ].filter(Boolean).join("; "));
}

/** After a debrief, the open tasks it feeds are re-judged with its evidence. Returns their ids. */
export function propagate(id: string, who: string | null): string[] {
  const status = new Map((db.query("SELECT id, status FROM tasks").all() as { id: string; status: string }[]).map((r) => [r.id, r.status]));
  const downstream = [...new Set(allLinks().filter((l) => l.from === id && (status.get(l.to) === "open" || status.get(l.to) === "doing")).map((l) => l.to))];
  for (const t of downstream) queueJudge(t);
  if (downstream.length) log("flow.propagate", who, id, { rejudged: downstream });
  return downstream;
}

/** Open tasks whose last unfinished blocker is `id` (call before marking it done). */
export function wouldUnlock(id: string): { id: string; title: string }[] {
  const rows = db.query("SELECT id, status, title FROM tasks").all() as { id: string; status: string; title: string }[];
  const status = new Map(rows.map((r) => [r.id, r.status]));
  return unlockedBy(id, status, allLinks()).map((u) => ({ id: u, title: rows.find((r) => r.id === u)!.title }));
}

/**
 * Where hypothetical tasks would land in today's ranking (Orion's value model, cdm's simulation and bold bet), without
 * adding them: the live list plus the candidates, ranked together. Uncalibrated, like the default view.
 */
export function rankWithCandidates(extra: { id: string; dims: Dims }[]) {
  const tasks = allTasks(), answers = latestAnswers();
  const judged = tasks.filter((t) => t.status === "open" || t.status === "doing").map((t) => ({ id: t.id, dims: effectiveDims(t, answers) }));
  const r = rank([...judged, ...extra], loadGraph(tasks));
  const ids = new Set(extra.map((e) => e.id));
  return { total: r.rows.length, bold: r.bold && ids.has(r.bold) ? r.bold : null, rows: r.rows.filter((x) => ids.has(x.optionId)) };
}
