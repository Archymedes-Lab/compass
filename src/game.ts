// The game layer: run the company like a video game, with Orion as the game master.
//
//   Quests    Orion deals each person the best open team task they can start (never the same one to two people,
//             never over an existing owner). A person can pass, with a reason; Orion won't deal it to them for a week.
//   XP        Earned for moving the engine: finishing a quest (10 × Orion's value for it), closing the loop
//             (debrief, impact follow-up, daily check-in, answering Orion's questions, measuring a goal metric).
//             Quest XP comes from Orion's value, never from how well someone says it went: self-report can't inflate it.
//   Moat      A quest whose debrief shows it really made Archymedes harder to copy (defensibility ≥ "Clearly") is
//             "moat forged": ×1.5 XP and it fills the company's moat meter. Defensibility is the prime law.
//   Levels, streaks (consecutive Kigali days with a check-in), badges and a feed. Agents play too.
// Everything here is derived from rows Compass already keeps, so XP can be recomputed and never drifts.
import { db, log } from "./db.ts";
import { buildState } from "./state.ts";
import { expectedOwn } from "./value.ts";
import { kigaliDay } from "./questions.ts";
import { isAgent } from "./auth.ts";
import { actionable } from "./lanes.ts";
import type { Dims } from "./dims.ts";

export const GAME_MASTER = "Orion";
export const XP = { questPerValue: 10, questMin: 20, moatMultiplier: 1.5, debrief: 50, followup: 30, checkin: 20, answer: 10, metric: 20 } as const;
export const PASS_DAYS = 7;
const MOAT_LEVEL = 3;

let team: string[] = [];
/** The people who receive quests (COMPASS_USERS order). */
export function setGameTeam(names: string[]) { team = [...names]; }
export const gameTeam = () => team;

export const levelOf = (xp: number) => Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
export const xpForLevel = (level: number) => 100 * (level - 1) ** 2;

// ---- dealing quests -------------------------------------------------------------------------------------------
const passedRecently = (who: string, taskId: string, clock: Date) =>
  !!db.query("SELECT 1 FROM events WHERE kind = 'quest.pass' AND who = ? AND task_id = ? AND at >= ? LIMIT 1")
    .get(who, taskId, new Date(clock.getTime() - PASS_DAYS * 86_400_000).toISOString());

/**
 * Give every person without an active quest the best team task they can start now. A person "has a quest" when they
 * own an open or in-progress team task. Owners are never overwritten; two people never get the same task.
 */
export function dealQuests(clock = new Date(), people = team): { who: string; taskId: string; title: string }[] {
  if (!people.length) return [];
  const st = buildState(null, false, clock);
  const teamLane = st.list.filter(t => t.lane === "team");
  const dealt: { who: string; taskId: string; title: string }[] = [];
  const taken = new Set<string>();
  // Fair order: whoever has the least open work goes first; ties rotate by day.
  const day = Number(kigaliDay(clock).replaceAll("-", ""));
  const order = [...people].sort((a, b) => teamLane.filter(t => t.owner === a).length - teamLane.filter(t => t.owner === b).length || ((people.indexOf(a) + day) % people.length) - ((people.indexOf(b) + day) % people.length));
  db.transaction(() => {
    for (const who of order) {
      if (teamLane.some(t => t.owner === who && (t.status === "open" || t.status === "doing"))) continue;
      const pick = teamLane.find(t => t.status === "open" && !t.owner && !taken.has(t.id) && !t.row.blockedBy.length && actionable(t.directive.action) && !passedRecently(who, t.id, clock));
      if (!pick) continue;
      // Re-read inside the transaction: never take a task someone claimed a moment ago.
      const fresh = db.query<{ owner: string | null; status: string }>("SELECT owner, status FROM tasks WHERE id = ?").get(pick.id);
      if (!fresh || fresh.owner || fresh.status !== "open") continue;
      db.query("UPDATE tasks SET owner = ? WHERE id = ?").run(who, pick.id);
      log("quest.deal", GAME_MASTER, pick.id, { to: who, rank: pick.row.rank });
      taken.add(pick.id);
      dealt.push({ who, taskId: pick.id, title: pick.title });
    }
  })();
  return dealt;
}

/** A person hands their quest back. The reason is kept: Orion and the team can see why work gets passed. */
export function passQuest(taskId: string, who: string, reason: string, clock = new Date()) {
  const t = db.query<{ owner: string | null; status: string; lane: string }>("SELECT owner, status, lane FROM tasks WHERE id = ?").get(taskId);
  if (!t) throw new Error("Unknown task");
  if (t.owner !== who) throw new Error("Only the quest's owner can pass it");
  if (t.status !== "open" && t.status !== "doing") throw new Error("Only open quests can be passed");
  db.query("UPDATE tasks SET owner = NULL, status = 'open', started_at = CASE WHEN status = 'doing' THEN NULL ELSE started_at END WHERE id = ?").run(taskId);
  db.query("INSERT INTO events (kind, task_id, who, at, payload) VALUES ('quest.pass', ?, ?, ?, ?)").run(taskId, who, clock.toISOString(), JSON.stringify({ reason: reason.slice(0, 300) }));
  return dealQuests(clock).find(d => d.who === who) ?? null;
}

// ---- XP, levels, streaks, the moat meter ---------------------------------------------------------------------
export interface XpEvent { who: string; at: string; xp: number; kind: "quest" | "moat" | "debrief" | "followup" | "checkin" | "answer" | "metric"; label: string; taskId?: string }

export function xpEvents(): XpEvent[] {
  const out: XpEvent[] = [];
  const tasks = new Map(db.query<{ id: string; title: string; owner: string | null; dims: string | null }>("SELECT id, title, owner, dims FROM tasks").all().map(t => [t.id, t]));
  const debriefs = new Map(db.query<{ task_id: string; who: string | null; at: string; defensibility: number }>("SELECT task_id, who, at, defensibility FROM debriefs").all().map(d => [d.task_id, d]));
  // One completion per task: the first time it was marked done (re-marking can't farm XP).
  const done = db.query<{ task_id: string; who: string | null; at: string }>("SELECT task_id, who, MIN(at) at FROM events WHERE kind = 'task.done' AND task_id IS NOT NULL GROUP BY task_id").all();
  for (const e of done) {
    const t = tasks.get(e.task_id);
    if (!t) continue;
    const player = t.owner ?? e.who;
    if (!player) continue;
    const base = Math.max(XP.questMin, Math.round(XP.questPerValue * (t.dims ? expectedOwn(JSON.parse(t.dims) as Dims) : 1)));
    const forged = (debriefs.get(t.id)?.defensibility ?? 0) >= MOAT_LEVEL;
    out.push({ who: player, at: e.at, xp: base, kind: "quest", label: `Quest complete: ${t.title}`, taskId: t.id });
    if (forged) out.push({ who: player, at: debriefs.get(t.id)!.at, xp: Math.round(base * (XP.moatMultiplier - 1)), kind: "moat", label: `Moat forged: ${t.title}`, taskId: t.id });
  }
  for (const d of debriefs.values()) if (d.who) out.push({ who: d.who, at: d.at, xp: XP.debrief, kind: "debrief", label: `Debriefed: ${tasks.get(d.task_id)?.title ?? "a task"}`, taskId: d.task_id });
  for (const f of db.query<{ task_id: string; who: string | null; at: string }>("SELECT task_id, who, at FROM followups").all()) if (f.who) out.push({ who: f.who, at: f.at, xp: XP.followup, kind: "followup", label: `Impact follow-up: ${tasks.get(f.task_id)?.title ?? "a task"}`, taskId: f.task_id });
  for (const c of db.query<{ who: string; at: string; date: string }>("SELECT who, at, date FROM checkins").all()) out.push({ who: c.who, at: c.at, xp: XP.checkin, kind: "checkin", label: `Checked in (${c.date})` });
  for (const a of db.query<{ who: string | null; at: string; task_id: string }>("SELECT who, at, task_id FROM answers").all()) if (a.who) out.push({ who: a.who, at: a.at, xp: XP.answer, kind: "answer", label: `Answered Orion about ${tasks.get(a.task_id)?.title ?? "a task"}`, taskId: a.task_id });
  for (const m of db.query<{ who: string | null; at: string; name: string }>("SELECT who, at, name FROM metrics").all()) if (m.who) out.push({ who: m.who, at: m.at, xp: XP.metric, kind: "metric", label: `Measured: ${m.name}` });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Consecutive Kigali days with a check-in, ending today (or yesterday, if today's is still to come). */
export function streakOf(who: string, clock = new Date()): number {
  const days = new Set(db.query<{ date: string }>("SELECT date FROM checkins WHERE who = ?").all(who).map(r => r.date));
  const d = new Date(`${kigaliDay(clock)}T12:00:00Z`);
  if (!days.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
  let n = 0;
  while (days.has(d.toISOString().slice(0, 10))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}

export const BADGES = [
  { id: "first-quest", name: "First quest", test: (p: PlayerStats) => p.quests >= 1 },
  { id: "loop-closer", name: "Loop closer", test: (p: PlayerStats) => p.debriefs >= 1 },
  { id: "moat-forger", name: "Moat forger", test: (p: PlayerStats) => p.forged >= 1 },
  { id: "on-a-roll", name: "On a roll", test: (p: PlayerStats) => p.streak >= 3 },
  { id: "week-of-fire", name: "Week of fire", test: (p: PlayerStats) => p.streak >= 7 },
  { id: "cartographer", name: "Cartographer", test: (p: PlayerStats) => p.metrics >= 3 },
  { id: "oracle", name: "Oracle's friend", test: (p: PlayerStats) => p.answers >= 10 },
] as const;
interface PlayerStats { quests: number; debriefs: number; forged: number; streak: number; metrics: number; answers: number }

export function gameState(clock = new Date(), people = team) {
  const events = xpEvents();
  const tasks = db.query<{ id: string; title: string; owner: string | null; status: string; lane: string; project_id: string | null }>("SELECT id, title, owner, status, lane, project_id FROM tasks").all();
  const names = [...new Set([...people, ...events.map(e => e.who)])];
  const players = names.map(who => {
    const mine = events.filter(e => e.who === who);
    const xp = mine.reduce((a, e) => a + e.xp, 0), level = levelOf(xp);
    const stats: PlayerStats = { quests: mine.filter(e => e.kind === "quest").length, debriefs: mine.filter(e => e.kind === "debrief").length, forged: mine.filter(e => e.kind === "moat").length, streak: isAgent(who) ? 0 : streakOf(who, clock), metrics: mine.filter(e => e.kind === "metric").length, answers: mine.filter(e => e.kind === "answer").length };
    const quest = tasks.find(t => t.owner === who && t.lane === "team" && t.status === "doing") ?? tasks.find(t => t.owner === who && t.lane === "team" && t.status === "open");
    return {
      who, agent: isAgent(who), xp, level, levelFloor: xpForLevel(level), levelCeil: xpForLevel(level + 1), ...stats,
      quest: quest ? { id: quest.id, title: quest.title, status: quest.status, projectId: quest.project_id } : null,
      badges: BADGES.filter(b => b.test(stats)).map(b => ({ id: b.id, name: b.name })),
      today: mine.filter(e => kigaliDay(new Date(e.at)) === kigaliDay(clock)).reduce((a, e) => a + e.xp, 0),
    };
  }).sort((a, b) => b.xp - a.xp || a.who.localeCompare(b.who));
  const debriefs = db.query<{ defensibility: number }>("SELECT defensibility FROM debriefs").all();
  return {
    players,
    moat: { forged: debriefs.filter(d => d.defensibility >= MOAT_LEVEL).length, realized: debriefs.reduce((a, d) => a + d.defensibility, 0), debriefs: debriefs.length },
    feed: events.slice(0, 15),
    rules: XP,
  };
}
export type GameState = ReturnType<typeof gameState>;
