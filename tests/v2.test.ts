// Version 2: reasons in plain words, the focus card, done-when + steps, and the seed swap that never clobbers use.
process.env.COMPASS_DB = ":memory:";
import { describe, expect, test } from "bun:test";
import { reasons } from "../src/reasons.ts";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { db } = await import("../src/db.ts");
const { focusFor, onJudgeQueued, getTask, addTask, buildState } = await import("../src/state.ts");
const { syncSeed, SEED, SEED_VERSION } = await import("../src/seed-data.ts");
const { createHandler } = await import("../src/api.ts");
let judged = 0;
onJudgeQueued(() => { judged++; });

const lv = (o: Partial<Record<string, number>>) => ({ impact: 0.5, urgency: 0.5, reach: 0.5, confidence: 0.5, effort: 0.5, leverage: 0.5, reversibility: 0.5, defensibility: 0.5, quality: 0.5, ...o });

describe("reasons", () => {
  test("at most three, strongest first, in words", () => {
    const r = reasons(lv({ effort: 0, impact: 0.9, defensibility: 0.9, urgency: 0.9, leverage: 0.9 }), "revenue", "two_way");
    expect(r).toHaveLength(3);
    expect(r[0].text).toBe("Quick: hours");
    expect(r.map((x) => x.text)).toContain("Moves revenue");
  });
  test("heavy and unproven are warnings; nothing notable is still explained", () => {
    expect(reasons(lv({ effort: 1, confidence: 0 }), "trust", "two_way").map((r) => r.tone)).toEqual(["warn", "warn"]);
    expect(reasons(lv({}), "other", "two_way")).toEqual([{ text: "Steady work", tone: "info" }]);
    expect(reasons(lv({}), "other", "one_way")[0].text).toBe("Hard to undo");
  });
});

describe("focus", () => {
  const list = [
    { id: "a", owner: "Alex", status: "open" }, { id: "b", owner: null, status: "open" },
    { id: "c", owner: "Chris", status: "doing" }, { id: "d", owner: "Chris", status: "open" },
  ];
  test("in-progress work first, else the top task that is yours or nobody's", () => {
    expect(focusFor("Chris", list)?.id).toBe("c");
    expect(focusFor("Alex", list)).toEqual({ id: "a", why: "Orion ranks this first for the company" });
    expect(focusFor("Chris", list.filter((t) => t.id !== "c"))).toEqual({ id: "b", why: "Orion's top task for you (#2 overall)" });
    expect(focusFor("Chris", [{ id: "x", owner: "Alex", status: "open" }])).toBeNull();
  });
});

describe("seed", () => {
  test("every seed task has a done-when test and steps", () => {
    for (const s of SEED) { expect(s.doneWhen.length).toBeGreaterThan(20); expect(s.steps.length).toBeGreaterThan(1); }
  });
  test("untouched starting tasks are replaced; touched and people's own tasks stay", () => {
    db.query("INSERT INTO tasks (id, title, created_at) VALUES ('old', 'Old seed task', '2026-11-09')").run();
    expect(syncSeed()).toBe(SEED.length);
    expect(getTask("old")).toBeNull();
    expect(syncSeed()).toBe(0);
    const s = buildState("Chris", false);
    expect(s.list).toHaveLength(SEED.length);
    expect(s.list[0].doneWhen.length).toBeGreaterThan(0);
    expect(s.list[0].reasons.length).toBeGreaterThan(0);
    expect(s.focus).not.toBeNull();

    // Next version: one seed task owned, one with a ticked step, one only clicked (steps back to none), one own task.
    const [owned, ticked, clicked] = s.list.slice(0, 3);
    db.query("UPDATE tasks SET owner = 'Alex' WHERE id = ?").run(owned.id);
    db.query("UPDATE tasks SET steps = ? WHERE id = ?").run(JSON.stringify([{ text: "a", done: true }]), ticked.id);
    db.query("INSERT INTO events (kind, task_id, who, at) VALUES ('task.steps', ?, 'Chris', 'now')").run(clicked.id);
    const mine = addTask({ title: "My own task", who: "Chris" });
    db.query("UPDATE settings SET value = '1' WHERE key = 'seed_version'").run();
    const added = syncSeed();
    expect(getTask(owned.id)).not.toBeNull();
    expect(getTask(ticked.id)).not.toBeNull();
    expect(getTask(clicked.id)).toBeNull();
    expect(getTask(mine)).not.toBeNull();
    expect(added).toBe(SEED.length - 2);
    const titles = buildState("Chris", false).list.map((t) => t.title);
    expect(titles.filter((t) => t === owned.title)).toHaveLength(1);
    expect(titles).toHaveLength(SEED.length + 1);
    expect(SEED_VERSION).toBe(4);
  });
});

describe("steps", () => {
  const KEY = "test-session-key-0123456789";
  const handle = createHandler({ users: "Chris:pw", sessionKey: KEY });
  test("ticking a step saves without re-judging; editing done-when re-judges", async () => {
    const login = await handle(new Request("https://x/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Chris", passphrase: "pw" }) }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const call = (path: string, method: string, body: unknown) => handle(new Request("https://x" + path, { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const { id } = await (await call("/api/tasks", "POST", { title: "Ship it", doneWhen: "a user pays", steps: ["one", "two", ""] })).json() as { id: string };
    expect(JSON.parse(getTask(id)!.steps)).toEqual([{ text: "one", done: false }, { text: "two", done: false }]);
    const before = judged;
    await call(`/api/tasks/${id}`, "PATCH", { steps: [{ text: "one", done: true }, { text: "two", done: false }] });
    expect(JSON.parse(getTask(id)!.steps)[0].done).toBe(true);
    expect(judged).toBe(before);
    await call(`/api/tasks/${id}`, "PATCH", { doneWhen: "ten users pay" });
    expect(getTask(id)!.done_when).toBe("ten users pay");
    expect(judged).toBe(before + 1);
    expect(addTask({ title: "x" })).toBeTruthy();
  });
});
