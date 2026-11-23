// One explicit value model, in place of a vote between frameworks that all divide by the same effort.
//
//   own_i  = confidence_i × CoD_i ÷ effort_i                (cost of delay divided by duration, "CD3", risk-adjusted)
//   CoD_i  = 2·impact + 2·defensibility + urgency + leverage + quality   (each on the Fibonacci scale WSJF uses)
//            Defensibility is the prime law (founders, 18 Nov 2026): it carries the largest weight, tied with impact,
//            so being hard to copy counts as much as the outcome itself; nothing else may outweigh it.
//   V*_i   = own_i + Σ_{open j that i feeds} PASS[kind] · V*_j          (src/flow.ts: work that fuels work rises)
//
// RICE, ICE, WSJF, Leverage, Eisenhower, Moat, Craft and Flow are still computed (src/rank.ts), as views that explain a
// position, not as voters: five of them divide by effort, so a Borda count over them mostly re-weights effort.
//
// Uncertainty is kept to the end. The dimensions are independent beliefs, so E[own] factorises exactly, and flow is
// linear, so the expected order needs no sampling: E[V*] = flow(E[own]). Monte Carlo over the same beliefs (seeded, so
// the page is stable) gives what a single order cannot: P(top-k), P(first) and a likely rank range per task.
// Pure; no store, no clock.
import type { Dim, Dims } from "./dims.ts";
import { flow, PASS, type Link } from "./flow.ts";

export const FIB = [1, 2, 3, 5, 8];
/** RICE's published confidence steps: a guess still counts for half. */
export const CONF = [0.5, 0.65, 0.8, 0.9, 1];
export const COD_DIMS: Dim[] = ["impact", "urgency", "leverage", "defensibility", "quality"];
export const COD_WEIGHT: Record<string, number> = { impact: 2, urgency: 1, leverage: 1, defensibility: 2, quality: 1 };

/**
 * Whether work is moat-worthy, decided by Orion alone from Jev's defensibility belief: P(level ≥ "Clearly" harder to
 * copy) at least MOAT_P. No model text, title or proposal wording enters it, so every surface (list, agents, MCP,
 * scan, email) shows the same verdict for the same belief.
 */
export const MOAT_LEVEL = 3, MOAT_P = 0.5;
export function moatVerdict(d: Pick<Dims, "defensibility"> | null | undefined): { p: number; worthy: boolean } | null {
  if (!d?.defensibility) return null;
  const p = Math.round(d.defensibility.slice(MOAT_LEVEL).reduce((a, x) => a + x, 0) * 1000) / 1000;
  return { p, worthy: p >= MOAT_P };
}
/** How many tasks count as "the top" for P(top-k) and for value of information. */
export const TOP_K = 5;
export const SAMPLES = 800;

/** Effort in Fibonacci size units, corrected by our own track record (src/calibrate.ts). Identity by default. */
export type EffortScale = (fib: number) => number;
const identity: EffortScale = (x) => x;

const dot = (p: number[], xs: number[]) => p.reduce((a, q, i) => a + q * xs[i], 0);

/** Exact E[own] under independent beliefs: E[conf] · E[CoD] · E[1/effort]. */
export function expectedOwn(d: Dims, effort: EffortScale = identity): number {
  const cod = COD_DIMS.reduce((a, k) => a + COD_WEIGHT[k] * dot(d[k], FIB), 0);
  const invEffort = dot(d.effort, FIB.map((f) => 1 / effort(f)));
  return dot(d.confidence, CONF) * cod * invEffort;
}

export interface Item { id: string; dims: Dims; /** Optional lane-specific effort correction. */ effort?: EffortScale }
export interface Graph { links: Link[]; status: Map<string, string> }
export interface ValueRow {
  id: string;
  /** E[own value]. */
  own: number;
  /** E[own + value passed back from the open work it feeds]. */
  value: number;
  blocked: boolean;
  /** P(in the top TOP_K of the work that can start now), P(first), and the 10th–90th percentile of its rank. */
  pTop: number; pFirst: number; rankLo: number; rankHi: number;
  /** cdm's innovation measure: E[max(V − V_first, 0)], how much better than the current first choice it could be. */
  ei: number;
}

/** Expected value with the flow, and whether each task still waits on an unfinished blocker. */
export function expectedValues(items: Item[], graph: Graph, effort: EffortScale = identity) {
  const own = new Map(items.map((i) => [i.id, expectedOwn(i.dims, i.effort ?? effort)]));
  return { own, flows: flow(own, graph.status, graph.links) };
}

/** Order: doable before blocked, then by expected value, then id (stable and independent of input order). */
export function order(ids: string[], value: (id: string) => number, blocked: (id: string) => boolean): string[] {
  return [...ids].sort((a, b) => Number(blocked(a)) - Number(blocked(b)) || value(b) - value(a) || (a < b ? -1 : a > b ? 1 : 0));
}

/** mulberry32: small, fast, seeded; the same beliefs always give the same page. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const draw = (p: number[], u: number) => { let c = 0; for (let i = 0; i < p.length; i++) { c += p[i]; if (u < c) return i; } return p.length - 1; };

/**
 * The flow as arrays, for the simulation: tasks in an order where every task comes after the open tasks it feeds, so
 * one backward pass gives V* = own + Σ PASS·V*(fed). Same result as flow() on a DAG (the API refuses cycles; a cycle
 * found here contributes nothing, as in flow()).
 */
function compile(ids: string[], graph: Graph) {
  const at = new Map(ids.map((id, i) => [id, i]));
  const live = (s?: string) => s === "open" || s === "doing";
  const out: { to: number; w: number }[][] = ids.map(() => []);
  for (const l of graph.links) {
    const f = at.get(l.from), t = at.get(l.to);
    if (f === undefined || t === undefined || f === t || !live(graph.status.get(l.to))) continue;
    out[f].push({ to: t, w: PASS[l.kind] });
  }
  const seq: number[] = [], state = new Uint8Array(ids.length); // 0 new, 1 visiting, 2 done
  const visit = (i: number) => {
    if (state[i]) return;
    state[i] = 1;
    out[i] = out[i].filter((e) => state[e.to] !== 1); // drop an edge that closes a cycle
    for (const e of out[i]) visit(e.to);
    state[i] = 2;
    seq.push(i);
  };
  ids.forEach((_, i) => visit(i));
  return { out, seq };
}

/**
 * Rank robustness by simulation: draw every task's levels from its beliefs, value the draw (with the flow), rank the
 * work that can start now, and count. Blocked tasks are not in the race: they cannot be done first.
 */
export function robustness(items: Item[], graph: Graph, effort: EffortScale = identity, samples = SAMPLES, seed = 1): Map<string, Pick<ValueRow, "pTop" | "pFirst" | "rankLo" | "rankHi" | "ei">> {
  const { flows } = expectedValues(items, graph, effort);
  const out = new Map(items.map((i) => [i.id, { pTop: 0, pFirst: 0, rankLo: 0, rankHi: 0, ei: 0 }]));
  const doable = items.map((_, i) => i).filter((i) => !flows.get(items[i].id)!.blockedBy.length);
  if (!doable.length) return out;
  // The current first choice, in expectation: the bar every other task is measured against.
  const best = doable.reduce((a, i) => (flows.get(items[i].id)!.flow > flows.get(items[a].id)!.flow ? i : a), doable[0]);
  const gain = new Float64Array(items.length);
  const { out: edges, seq } = compile(items.map((i) => i.id), graph);
  const rand = rng(seed);
  const k = Math.min(TOP_K, doable.length);
  const effortOf = items.map(i => FIB.map(f => (i.effort ?? effort)(f)));
  // Cumulative beliefs, once.
  const cum = items.map((i) => Object.fromEntries([...COD_DIMS, "confidence", "effort"].map((d) => {
    let c = 0; return [d, i.dims[d as Dim].map((p) => (c += p))];
  })) as Record<string, number[]>);
  const pick = (c: number[]) => { const u = rand() * c[c.length - 1]; let j = 0; while (j < c.length - 1 && u >= c[j]) j++; return j; };
  const v = new Float64Array(items.length);
  const ranks = doable.map(() => new Uint16Array(samples));
  const top = new Float64Array(items.length), first = new Float64Array(items.length);
  const order = doable.slice();
  const slot = new Int32Array(items.length).fill(-1);
  doable.forEach((i, j) => { slot[i] = j; });
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < items.length; i++) {
      const c = cum[i];
      let cod = 0;
      for (const d of COD_DIMS) cod += COD_WEIGHT[d] * FIB[pick(c[d])];
      v[i] = (CONF[pick(c.confidence)] * cod) / effortOf[i][pick(c.effort)];
    }
    for (const i of seq) for (const e of edges[i]) v[i] += e.w * v[e.to];
    for (const i of doable) if (v[i] > v[best]) gain[i] += v[i] - v[best];
    order.sort((a, b) => v[b] - v[a]);
    for (let r = 0; r < order.length; r++) {
      const i = order[r];
      ranks[slot[i]][s] = r + 1;
      if (r < k) top[i]++;
      if (r === 0) first[i]++;
    }
  }
  doable.forEach((i, j) => {
    const rs = ranks[j].sort();
    out.set(items[i].id, {
      pTop: round(top[i] / samples), pFirst: round(first[i] / samples),
      rankLo: rs[Math.floor(0.1 * (samples - 1))], rankHi: rs[Math.ceil(0.9 * (samples - 1))], ei: round(gain[i] / samples),
    });
  });
  return out;
}

/** Confidence level (0..1) at or below which a task is unproven: "a guess" or "weak signals". */
export const UNPROVEN = 0.4;
/** The bold bet must be able to beat the first task by at least this share of its value, in expectation. */
export const MIN_EI = 0.01;

/**
 * cdm's innovation slot (MATH.md §3): besides the first choice, the one unproven task with the most upside over it,
 * E[max(V − V_first, 0)]. Unknown is not risky: an unproven task is not vetoed; it is a bet to test cheaply first.
 */
export function boldBet(rows: { optionId: string; rank: number; ei: number; value: number; blockedBy: string[]; level: { confidence: number } }[]): string | null {
  // Like cdm's novelty gate: only an upside worth acting on (MIN_EI of the first task's value) opens the slot.
  const bar = MIN_EI * (rows[0]?.value ?? 0);
  const c = rows.filter((r) => r.rank > 1 && !r.blockedBy.length && r.level.confidence <= UNPROVEN && r.ei > bar);
  return c.sort((a, b) => b.ei - a.ei || a.rank - b.rank)[0]?.optionId ?? null;
}

/**
 * Preposterior value of information for "what level is `dim` on task `id`?": over the answers Orion thinks possible,
 * weighted by its belief, how many of the top-k tasks change (plus 2 if the first one does). Exact, because the
 * expected order only needs E[own], and fixing one dimension of one task changes only that task's E[own].
 */
export function valueOfAnswer(items: Item[], graph: Graph, id: string, dim: Dim, effort: EffortScale = identity): number {
  const { own, flows } = expectedValues(items, graph, effort);
  const blocked = (x: string) => flows.get(x)!.blockedBy.length > 0;
  const ids = items.map((i) => i.id);
  const top = (o: Map<string, number>) => {
    const f = flow(o, graph.status, graph.links);
    return order(ids, (x) => f.get(x)!.flow, blocked).slice(0, TOP_K);
  };
  const base = top(own);
  const item = items.find((i) => i.id === id)!;
  return round(item.dims[dim].reduce((acc, p, level) => {
    if (p < 1e-6) return acc;
    const point = item.dims[dim].map((_, j) => (j === level ? 1 : 0));
    const next = top(new Map(own).set(id, expectedOwn({ ...item.dims, [dim]: point } as Dims, item.effort ?? effort)));
    const changed = next.filter((x) => !base.includes(x)).length + (next[0] !== base[0] ? 2 : 0);
    return acc + p * changed;
  }, 0));
}

const round = (x: number) => Math.round(x * 1000) / 1000;
