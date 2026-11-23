// How tasks fuel each other. A link says A feeds B, in one of two ways:
//   unblocks  B cannot be finished until A is done
//   boosts    A's output makes B more valuable or more likely to work
// Value flows upstream: a task is worth its own value plus a discounted share of what it feeds (Katz-style
// centrality on the graph), so the work that powers the most downstream value rises. Only open work counts
// downstream: what is already done needs no more fuel. Pure; no store, no clock.

export type LinkKind = "unblocks" | "boosts";
export interface Link { from: string; to: string; kind: LinkKind }

/** All ancestors and descendants, at their shortest distance. Cycles never include the selected task. */
export function influence(id: string, links: Link[]): { upstream: Map<string, number>; downstream: Map<string, number> } {
  const walk = (reverse: boolean) => {
    const adjacent = new Map<string, string[]>();
    for (const link of links) {
      const from = reverse ? link.to : link.from, to = reverse ? link.from : link.to;
      const next = adjacent.get(from) ?? [];
      next.push(to); adjacent.set(from, next);
    }
    const distance = new Map<string, number>();
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const from = queue[i];
      for (const to of adjacent.get(from) ?? []) {
        if (to === id || distance.has(to)) continue;
        distance.set(to, (distance.get(from) ?? 0) + 1);
        queue.push(to);
      }
    }
    return distance;
  };
  return { upstream: walk(true), downstream: walk(false) };
}
export interface FlowInfo {
  /** Own value plus the share passed back from the open tasks it feeds. */
  flow: number;
  /** Unfinished tasks that must be done before this one can be. */
  blockedBy: string[];
  /** Open tasks this one unblocks. */
  unlocks: string[];
  /** Open tasks this one boosts. */
  boosts: string[];
  /** Every task that feeds this one (any status). */
  fedBy: { id: string; kind: LinkKind }[];
  /** Every task this one feeds (any status). */
  feeds: { id: string; kind: LinkKind }[];
}

/** Share of a fed task's flow passed back along each kind of link. Below 1, so value fades with distance. */
export const PASS: Record<LinkKind, number> = { unblocks: 0.6, boosts: 0.3 };

const live = (s: string | undefined) => s === "open" || s === "doing";

export function flow(own: Map<string, number>, status: Map<string, string>, links: Link[]): Map<string, FlowInfo> {
  const out = new Map<string, Link[]>(), into = new Map<string, Link[]>();
  for (const l of links) {
    if (!status.has(l.from) || !status.has(l.to) || l.from === l.to) continue;
    (out.get(l.from) ?? out.set(l.from, []).get(l.from)!).push(l);
    (into.get(l.to) ?? into.set(l.to, []).get(l.to)!).push(l);
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const value = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0; // a cycle contributes nothing; the API refuses to create one
    visiting.add(id);
    let v = own.get(id) ?? 0;
    for (const l of out.get(id) ?? []) if (live(status.get(l.to))) v += PASS[l.kind] * value(l.to);
    visiting.delete(id);
    memo.set(id, v);
    return v;
  };
  const result = new Map<string, FlowInfo>();
  for (const id of status.keys()) {
    const o = out.get(id) ?? [], i = into.get(id) ?? [];
    result.set(id, {
      flow: value(id),
      blockedBy: i.filter((l) => l.kind === "unblocks" && live(status.get(l.from))).map((l) => l.from),
      unlocks: o.filter((l) => l.kind === "unblocks" && live(status.get(l.to))).map((l) => l.to),
      boosts: o.filter((l) => l.kind === "boosts" && live(status.get(l.to))).map((l) => l.to),
      fedBy: i.map((l) => ({ id: l.from, kind: l.kind })),
      feeds: o.map((l) => ({ id: l.to, kind: l.kind })),
    });
  }
  return result;
}

/** Would adding from → to close a loop? True if `from` is already reachable from `to`. */
export function wouldCycle(links: Link[], from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([to]);
  const stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    for (const l of links) if (l.from === n && !seen.has(l.to)) {
      if (l.to === from) return true;
      seen.add(l.to); stack.push(l.to);
    }
  }
  return false;
}

/** Open tasks that become doable once `id` is done: their only unfinished blocker is `id`. */
export function unlockedBy(id: string, status: Map<string, string>, links: Link[]): string[] {
  return [...new Set(links.filter((l) => l.from === id && l.kind === "unblocks" && live(status.get(l.to))).map((l) => l.to))]
    .filter((to) => links.every((l) => l.to !== to || l.kind !== "unblocks" || l.from === id || !live(status.get(l.from))));
}

/**
 * Stage of each task in the flow: 0 for tasks nothing feeds, else one past the latest feeder. With `pull`, a task is
 * then moved as far right as its own links allow (just before the earliest task it feeds), which keeps lines short.
 */
export function stages(ids: string[], links: Link[], pull = false): Map<string, number> {
  const set = new Set(ids);
  const preds = new Map<string, string[]>();
  for (const l of links) if (set.has(l.from) && set.has(l.to)) (preds.get(l.to) ?? preds.set(l.to, []).get(l.to)!).push(l.from);
  const memo = new Map<string, number>(), visiting = new Set<string>();
  const stage = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const s = Math.max(-1, ...(preds.get(id) ?? []).map(stage)) + 1;
    visiting.delete(id);
    memo.set(id, s);
    return s;
  };
  const out = new Map(ids.map((id) => [id, stage(id)]));
  if (!pull) return out;
  const succs = new Map<string, string[]>();
  for (const l of links) if (set.has(l.from) && set.has(l.to)) (succs.get(l.from) ?? succs.set(l.from, []).get(l.from)!).push(l.to);
  for (const id of [...ids].sort((a, b) => out.get(b)! - out.get(a)!)) {
    const next = succs.get(id);
    if (next?.length) out.set(id, Math.max(out.get(id)!, Math.min(...next.map((n) => out.get(n)!)) - 1));
  }
  return out;
}
