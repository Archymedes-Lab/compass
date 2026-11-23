// What Compass asks the team. Two moments, nothing else:
//   1. As soon as a task is done: a debrief (how it went vs what Orion expected).
//   2. Once a day, per founder: a daily check-in. It carries the tasks they have in progress, impact follow-ups for
//      tasks finished a week or more ago, and the few questions whose answer would most change the top of the list.
// Pure: the server passes in the state and the clock.
import { DIMS, QUESTIONS, DIM_LABEL, scoreConfidence, type Dim } from "./dims.ts";
import { rank, type Judged, type Graph } from "./rank.ts";
import { valueOfAnswer, type EffortScale } from "./value.ts";

/** Dimensions a person can actually answer better than a model. */
const ASKABLE: Dim[] = ["impact", "urgency", "confidence", "effort", "defensibility", "quality", "leverage"];
export const IMPACT_FOLLOW_UP_DAYS = 7;
const TOP = 6;
const MAX_VOI = 3;

export interface TaskLite { id: string; title: string; owner: string | null; status: "open" | "doing" | "done" | "dropped"; doneAt: string | null; startedAt: string | null }

export interface VoiQuestion { taskId: string; title: string; dim: Dim; prompt: string; levels: string[]; uncertainty: number; swing: number; score: number }
export interface Debrief { taskId: string; title: string }
export interface FollowUp { taskId: string; title: string; doneAt: string }
export interface Daily { who: string; date: string; inProgress: TaskLite[]; followUps: FollowUp[]; voi: VoiQuestion[] }

/** YYYY-MM-DD in Kigali (UTC+2), so "today" turns over at local midnight. */
export const kigaliDay = (now: Date) => new Date(now.getTime() + 2 * 3600_000).toISOString().slice(0, 10);

/**
 * Value of information (preposterior): for the top tasks, which single answer would change the top of the list most?
 * For each (task, askable dimension) the team has not answered, the expected number of top-5 tasks that change if
 * the team answered, weighted by how likely Orion thinks each answer is (plus 2 if the first task would change):
 * src/value.ts valueOfAnswer. A dimension Orion is already sure about has little mass on answers that move anything,
 * so uncertainty is priced in rather than multiplied on. Ask the few with the highest value, one per task, and only
 * those worth a founder's minute (MIN_VOI).
 */
export const MIN_VOI = 0.15;
let memo: { key: string; value: VoiQuestion[] } | null = null;

export function voiQuestions(items: (Judged & { title: string })[], answered: Set<string>, graph?: Graph, effort?: EffortScale): VoiQuestion[] {
  const key = JSON.stringify([
    items.map((i) => [i.id, i.title, DIMS.map((d) => i.dims[d].map((x) => Math.round(x * 1000))), i.effort ? [1, 2, 3, 5, 8].map(i.effort) : null]),
    [...answered].sort(), graph?.links ?? [], graph ? [...graph.status].sort() : [], effort ? [1, 2, 3, 5, 8].map(effort) : null,
  ]);
  if (memo?.key === key) return memo.value;
  const value = searchVoi(items, answered, graph, effort);
  memo = { key, value };
  return value;
}

function searchVoi(items: (Judged & { title: string })[], answered: Set<string>, graph?: Graph, effort?: EffortScale): VoiQuestion[] {
  if (items.length < 2) return [];
  const g = { links: graph?.links ?? [], status: graph?.status ?? new Map(items.map((i) => [i.id, "open"])) };
  for (const i of items) if (!g.status.has(i.id)) g.status.set(i.id, "open");
  const base = rank(items, g, { effort, samples: 0 });
  const top = base.rows.slice(0, TOP).map((r) => r.optionId);
  const out: VoiQuestion[] = [];
  for (const id of top) {
    const item = items.find((i) => i.id === id)!;
    for (const dim of ASKABLE) {
      if (answered.has(`${id}:${dim}`)) continue;
      const swing = valueOfAnswer(items, g, id, dim, effort);
      if (swing < MIN_VOI) continue;
      out.push({
        taskId: id, title: item.title, dim, uncertainty: round(1 - scoreConfidence(item.dims[dim])), swing: round(swing), score: round(swing),
        prompt: QUESTIONS[dim].question.replace("`option`", `"${item.title}"`), levels: QUESTIONS[dim].levels,
      });
    }
  }
  // At most one question per task, so a daily check-in spreads across the list.
  const seen = new Set<string>();
  return out.sort((a, b) => b.score - a.score || a.taskId.localeCompare(b.taskId)).filter((q) => !seen.has(q.taskId) && seen.add(q.taskId)).slice(0, MAX_VOI);
}

export function pendingDebriefs(tasks: TaskLite[], debriefed: Set<string>): Debrief[] {
  return tasks.filter((t) => t.status === "done" && !debriefed.has(t.id)).map((t) => ({ taskId: t.id, title: t.title }));
}

export function followUps(tasks: TaskLite[], followed: Set<string>, now: Date): FollowUp[] {
  const cutoff = now.getTime() - IMPACT_FOLLOW_UP_DAYS * 86_400_000;
  return tasks
    .filter((t) => t.status === "done" && t.doneAt && Date.parse(t.doneAt) <= cutoff && !followed.has(t.id))
    .map((t) => ({ taskId: t.id, title: t.title, doneAt: t.doneAt! }));
}

/** The daily check-in for one founder, or null if they have already done today's. */
export function daily(who: string, now: Date, lastCheckIn: string | null, tasks: TaskLite[], follow: FollowUp[], voi: VoiQuestion[]): Daily | null {
  const date = kigaliDay(now);
  if (lastCheckIn === date) return null;
  const inProgress = tasks.filter((t) => t.status === "doing" && (t.owner === who || !t.owner));
  const owned = new Set(tasks.filter((t) => t.owner === who).map((t) => t.id));
  // Your own follow-ups first; unowned ones go to whoever checks in first.
  const mine = follow.filter((f) => owned.has(f.taskId) || !tasks.find((t) => t.id === f.taskId)?.owner);
  return { who, date, inProgress, followUps: mine.slice(0, 3), voi };
}

export const dimLabel = (d: Dim) => DIM_LABEL[d];
export { DIMS };
const round = (x: number) => Math.round(x * 100) / 100;
