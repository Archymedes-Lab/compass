// Ranking. The order comes from one explicit value model (src/value.ts): risk-adjusted cost of delay ÷ effort, plus
// what a task passes on to the open work it feeds, in expectation over Orion's beliefs. Tasks still waiting on an
// unfinished blocker sink below the ones that can be done now. Simulation over the same beliefs adds P(top-5),
// P(first) and a likely rank range, so a close call looks like one.
// Orion's prioritiser (RICE, ICE, WSJF, leverage, Eisenhower) and Archymedes' Moat, Craft and Flow are still computed,
// as views that explain a position; Kendall's W says how far they agree with each other. They no longer vote: five of
// them divide by effort, so a Borda count over them mostly re-weights effort. Pure and deterministic (seeded).
import { prioritize, type Framework as OrionFramework, type PriorityRow } from "../../orion/src/decision-engine/prioritize.ts";
import { PRIORITY_DIMENSIONS } from "../../orion/src/decision-engine/prioritize.ts";
import type { Dims } from "./dims.ts";
import { flow, type Link } from "./flow.ts";
import { boldBet, expectedValues, order, robustness, type EffortScale } from "./value.ts";

export type Framework = OrionFramework | "moat" | "craft" | "flow";
export const FRAMEWORKS: Framework[] = ["rice", "ice", "wsjf", "leverage", "eisenhower", "moat", "craft", "flow"];

export interface Judged { id: string; dims: Dims; effort?: EffortScale }
/** The links between tasks and every task's status (done ones too, so finished blockers stop blocking). */
export interface Graph { links: Link[]; status: Map<string, string> }

export interface Row extends Omit<PriorityRow, "ranks" | "level"> {
  level: Record<keyof Dims, number>;
  /** Defensibility built per unit of effort, counting what it unlocks. */
  moat: number;
  /** Quality raised per unit of effort, counting impact. */
  craft: number;
  /** Own value plus the value passed back from the open tasks it feeds. */
  flow: number;
  blockedBy: string[];
  unlocks: string[];
  boosts: string[];
  ranks: Record<Framework, number>;
  /** E[own value] and E[own + passed-on value], the number the order is built on. */
  own: number;
  value: number;
  /** Simulated over Orion's beliefs, among the work that can start now: P(top 5), P(first), 10th–90th pct rank. */
  pTop: number;
  rankLo: number;
  rankHi: number;
  /** Expected improvement over the first choice (cdm's innovation measure). */
  ei: number;
}

export interface Ranking { rows: Row[]; agreement: number; first: string | null; /** cdm's innovation slot. */ bold: string | null }

const FIB = [1, 2, 3, 5, 8];
const expect = (dist: number[], scale: number[]) => dist.reduce((a, p, i) => a + p * scale[i], 0);
const unit = (dist: number[]) => expect(dist, [0, 0.25, 0.5, 0.75, 1]);
const ranksOf = (values: number[]) => values.map((v) => 1 + values.filter((w) => w > v + 1e-9).length);

export interface RankOptions { effort?: EffortScale; samples?: number }

/** The page asks for the same ranking on every refresh; it only changes when beliefs, links or corrections do. */
let memo: { key: string; value: Ranking } | null = null;

export function rank(items: Judged[], graph?: Graph, opts: RankOptions = {}): Ranking {
  const key = JSON.stringify([items.map(i => ({ id: i.id, dims: i.dims, effort: i.effort ? [1, 2, 3, 5, 8].map(i.effort) : null })), graph?.links ?? [], graph ? [...graph.status] : null, opts.effort ? [1, 2, 3, 5, 8].map(opts.effort) : null, opts.samples ?? null]);
  if (memo?.key === key) return memo.value;
  const value = rankUncached(items, graph, opts);
  memo = { key, value };
  return value;
}

function rankUncached(items: Judged[], graph: Graph | undefined, opts: RankOptions): Ranking {
  if (!items.length) return { rows: [], agreement: 1, first: null, bold: null };
  const orion = prioritize(items.map((i) => ({
    optionId: i.id,
    dims: Object.fromEntries(PRIORITY_DIMENSIONS.map((d) => [d, i.dims[d]])) as Record<(typeof PRIORITY_DIMENSIONS)[number], number[]>,
  })));
  const byId = new Map(orion.rows.map((r) => [r.optionId, r]));
  const status = graph?.status ?? new Map(items.map((i) => [i.id, "open"]));
  for (const i of items) if (!status.has(i.id)) status.set(i.id, "open");
  const g = { links: graph?.links ?? [], status };
  const flows = flow(new Map(orion.rows.map((r) => [r.optionId, r.wsjf])), status, g.links);
  const ev = expectedValues(items, g, opts.effort);
  const sim = opts.samples === 0 ? null : robustness(items, g, opts.effort, opts.samples);
  const base = items.map((i) => {
    const r = byId.get(i.id)!;
    const effort = expect(i.dims.effort, FIB);
    const f = flows.get(i.id)!;
    return {
      ...r,
      level: { ...r.level, defensibility: unit(i.dims.defensibility), quality: unit(i.dims.quality) },
      moat: (expect(i.dims.defensibility, FIB) * (1 + r.level.leverage)) / effort,
      craft: (expect(i.dims.quality, FIB) * (1 + r.level.impact)) / effort,
      flow: f.flow, blockedBy: f.blockedBy, unlocks: f.unlocks, boosts: f.boosts,
      own: round(ev.own.get(i.id)!), value: round(ev.flows.get(i.id)!.flow),
      pFirst: sim?.get(i.id)!.pFirst ?? 0, pTop: sim?.get(i.id)!.pTop ?? 0, rankLo: sim?.get(i.id)!.rankLo ?? 0, rankHi: sim?.get(i.id)!.rankHi ?? 0, ei: sim?.get(i.id)!.ei ?? 0,
    };
  });
  const own = { moat: ranksOf(base.map((b) => b.moat)), craft: ranksOf(base.map((b) => b.craft)), flow: ranksOf(base.map((b) => b.flow)) };
  const ranks = base.map((b, k) => ({ ...b.ranks, moat: own.moat[k], craft: own.craft[k], flow: own.flow[k] }) as Record<Framework, number>);
  const n = items.length, m = FRAMEWORKS.length;
  const idx = new Map(base.map((b, i) => [b.optionId, i]));
  const sorted = order(base.map((b) => b.optionId), (id) => base[idx.get(id)!].value, (id) => base[idx.get(id)!].blockedBy.length > 0);
  const rows: Row[] = sorted.map((id, k) => { const i = idx.get(id)!; return { ...base[i], ranks: ranks[i], rank: k + 1 }; });
  // Kendall's W over the eight frameworks: 1 = they all agree on the order.
  const sums = ranks.map((r) => FRAMEWORKS.reduce((a, f) => a + r[f], 0));
  const mean = (m * (n + 1)) / 2;
  const S = sums.reduce((a, r) => a + (r - mean) ** 2, 0);
  const agreement = n < 2 ? 1 : Math.max(0, Math.min(1, (12 * S) / (m * m * (n ** 3 - n))));
  return { rows, agreement: Math.round(agreement * 100) / 100, first: rows[0]?.optionId ?? null, bold: boldBet(rows) };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
