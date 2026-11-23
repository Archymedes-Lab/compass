// Tasks fuel each other: value flows upstream, blockers sink what they block, finishing unlocks and passes evidence on.
process.env.COMPASS_DB = ":memory:";
import { describe, expect, test } from "bun:test";
import { flow, PASS, stages, unlockedBy, wouldCycle, type Link } from "../src/flow.ts";
import { rank } from "../src/rank.ts";
import { DIMS, type Dims } from "../src/dims.ts";
import { fromPoint } from "../../orion/src/decision-engine/creative.ts";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { db } = await import("../src/db.ts");
const { onJudgeQueued, buildState, getTask, upstreamEvidence, allLinks } = await import("../src/state.ts");
const { SEED, syncSeed } = await import("../src/seed-data.ts");
const { companyContext } = await import("../src/judge.ts");
const { createHandler } = await import("../src/api.ts");
const queued: number[] = [];
onJudgeQueued(() => { queued.push(1); });

const st = (o: Record<string, string>) => new Map(Object.entries(o));
const at = (levels: Partial<Record<keyof Dims, number>> = {}): Dims =>
  Object.fromEntries(DIMS.map((d) => [d, fromPoint(levels[d] ?? 2, 0.9)])) as Dims;

describe("flow math", () => {
  const links: Link[] = [{ from: "a", to: "b", kind: "unblocks" }, { from: "b", to: "c", kind: "boosts" }, { from: "a", to: "c", kind: "boosts" }];
  test("value flows upstream with a discount per link", () => {
    const f = flow(new Map([["a", 1], ["b", 1], ["c", 1]]), st({ a: "open", b: "open", c: "open" }), links);
    expect(f.get("c")!.flow).toBe(1);
    expect(f.get("b")!.flow).toBeCloseTo(1 + PASS.boosts);
    expect(f.get("a")!.flow).toBeCloseTo(1 + PASS.unblocks * (1 + PASS.boosts) + PASS.boosts);
    expect(f.get("b")!.blockedBy).toEqual(["a"]);
    expect(f.get("a")!.unlocks).toEqual(["b"]);
  });
  test("finished work needs no more fuel and stops blocking", () => {
    const f = flow(new Map([["a", 1], ["b", 1], ["c", 1]]), st({ a: "done", b: "open", c: "done" }), links);
    expect(f.get("b")!.flow).toBe(1);
    expect(f.get("b")!.blockedBy).toEqual([]);
  });
  test("cycles are refused and harmless", () => {
    expect(wouldCycle(links, "c", "a")).toBe(true);
    expect(wouldCycle(links, "a", "a")).toBe(true);
    expect(wouldCycle(links, "c", "d")).toBe(false);
    const f = flow(new Map([["x", 1], ["y", 1]]), st({ x: "open", y: "open" }), [{ from: "x", to: "y", kind: "boosts" }, { from: "y", to: "x", kind: "boosts" }]);
    expect(Number.isFinite(f.get("x")!.flow)).toBe(true);
  });
  test("unlocked means the last open blocker went away", () => {
    const l: Link[] = [{ from: "a", to: "c", kind: "unblocks" }, { from: "b", to: "c", kind: "unblocks" }];
    expect(unlockedBy("a", st({ a: "open", b: "open", c: "open" }), l)).toEqual([]);
    expect(unlockedBy("a", st({ a: "open", b: "done", c: "open" }), l)).toEqual(["c"]);
  });
  test("stages run left to right", () => {
    expect(Object.fromEntries(stages(["a", "b", "c"], links))).toEqual({ a: 0, b: 1, c: 2 });
    // A feeder of only the last task is pulled right, next to it; order along every link still holds.
    const l2: Link[] = [...links, { from: "late", to: "c", kind: "boosts" }];
    const pulled = stages(["a", "b", "c", "late"], l2, true);
    expect(pulled.get("late")).toBe(1);
    for (const l of l2) expect(pulled.get(l.from)!).toBeLessThan(pulled.get(l.to)!);
  });
});

describe("rank with the graph", () => {
  test("a task that fuels a lot rises; a blocked task sinks below available ones", () => {
    const items = ["feeder", "plain", "goal1", "goal2", "goal3"].map((id) => ({ id, dims: at() }));
    const links: Link[] = ["goal1", "goal2", "goal3"].map((to) => ({ from: "feeder", to, kind: "unblocks" as const }));
    const r = rank(items, { links, status: st({ feeder: "open", plain: "open", goal1: "open", goal2: "open", goal3: "open" }) });
    expect(r.first).toBe("feeder");
    expect(r.rows.slice(-3).every((x) => x.blockedBy.length === 1)).toBe(true);
    expect(r.rows[0].unlocks).toHaveLength(3);
  });
});

describe("seed graph", () => {
  test("every link names a real task, and the graph has no loop", () => {
    const keys = new Set(SEED.map((s) => s.key));
    const links: Link[] = SEED.flatMap((s) => s.feeds.map(([to, kind]) => ({ from: s.key, to, kind })));
    for (const l of links) expect(keys.has(l.to)).toBe(true);
    for (const l of links) expect(wouldCycle(links.filter((x) => x !== l), l.from, l.to)).toBe(false);
    expect(links.length).toBeGreaterThan(SEED.length);
  });
});

describe("the system in motion", () => {
  const KEY = "test-session-key-0123456789";
  const handle = createHandler({ users: "Chris:pw", sessionKey: KEY });
  let cookie = "";
  const call = async (path: string, method: string, body?: unknown) => {
    if (!cookie) {
      const l = await handle(new Request("https://x/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Chris", passphrase: "pw" }) }));
      cookie = l.headers.get("set-cookie")!.split(";")[0];
    }
    return handle(new Request("https://x" + path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  };

  test("seeded links show up; finishing unlocks; a debrief re-judges what it feeds and grows the graph", async () => {
    syncSeed();
    expect(allLinks().length).toBeGreaterThan(SEED.length);
    const s = buildState("Chris", false);
    const byTitle = (t: string) => s.list.find((x) => x.title.startsWith(t))!;
    const thanks = byTitle("Build the after-payment page"), pay = byTitle("Take the first real payment");
    expect(pay.row.blockedBy).toEqual([thanks.id]);
    expect(pay.reasons[0].text).toStartWith("Waiting on:");
    expect(thanks.feeds.map((f) => f.id)).toContain(pay.id);
    expect(s.focus!.id).not.toBe(pay.id);

    const done = await (await call(`/api/tasks/${thanks.id}`, "PATCH", { status: "done" })).json() as { unlocked: { id: string }[] };
    expect(done.unlocked.map((u) => u.id)).toEqual([pay.id]);
    expect(buildState("Chris", false).list.find((x) => x.id === pay.id)!.row.blockedBy).toEqual([]);

    const before = queued.length;
    const r = await (await call("/api/debriefs", "POST", { taskId: thanks.id, result: "better", effort: 1, defensibility: 1, quality: 3, asset: "a working welcome email", lesson: "test with a real inbox", next: "Send the welcome email in Kinyarwanda too" })).json() as { created: string[]; rejudged: string[] };
    expect(r.rejudged).toContain(pay.id);
    expect(r.created).toHaveLength(1);
    expect(queued.length).toBeGreaterThanOrEqual(before + 2);
    expect(allLinks().some((l) => l.from === thanks.id && l.to === r.created[0] && l.kind === "boosts")).toBe(true);
    const ev = upstreamEvidence(pay.id).join(" ");
    expect(ev).toContain("better than expected");
    expect(ev).toContain("test with a real inbox");
    expect(companyContext("Brief.", [], upstreamEvidence(pay.id))).toContain("Finished work that feeds this task");
  });

  test("links: add, refuse a loop, remove", async () => {
    const [a, b] = buildState("Chris", false).list;
    expect((await call("/api/links", "POST", { from: a.id, to: b.id, kind: "boosts" })).status).toBe(200);
    expect((await call("/api/links", "POST", { from: b.id, to: a.id, kind: "boosts" })).status).toBe(400);
    expect((await call("/api/links", "DELETE", { from: a.id, to: b.id })).status).toBe(200);
    expect(getTask(a.id)).not.toBeNull();
    expect(db.query("SELECT COUNT(*) n FROM links WHERE from_id = ? AND to_id = ?").get(a.id, b.id)).toEqual({ n: 0 });
  });
});
