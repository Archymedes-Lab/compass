process.env.COMPASS_DB = ":memory:";
import { beforeEach, describe, expect, test } from "bun:test";
import { openLocal } from "../src/local.ts";
import { db } from "../src/db.ts";
import { createHandler } from "../src/api.ts";
import { addTask, allLinks, buildState, getTask, judgePending, lessons, onJudgeQueued, outcomeForecast, queueJudge, setBrief, setStatus, upstreamEvidence } from "../src/state.ts";
import { DIMS, uniform, type Dims } from "../src/dims.ts";
import type { Judgment } from "../src/judge.ts";
import { workspaceHealth } from "../src/health.ts";

const TOKEN = "reliability-agent-0123456789abcdefghijklmnop";
const cfg = { users: "Chris:pw", sessionKey: "reliability-session-key-0123456789", agents: `Codex:${TOKEN}` };
const handle = createHandler(cfg);
let kicks = 0;
const dims = (lv: number) => Object.fromEntries(DIMS.map(d => [d, [0, 1, 2, 3, 4].map(i => i === lv ? 1 : 0)])) as Dims;
const judgment = (lv = 2): Judgment => ({ dims: dims(lv), model: "test-judge", promptHash: "prompt", disagreement: Object.fromEntries(DIMS.map(d => [d, 0])) as any, tokens: 10 });
const create = (input: Partial<Parameters<typeof addTask>[0]> = {}) => addTask({ title: "Task", who: "Chris", ...input });
const agent = (path: string, method: string, body: unknown) => handle(new Request(`https://compass.test${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
const asPerson = async (path: string, method: string, body: unknown) => {
  const login = await handle(new Request("https://compass.test/api/login", { method: "POST", body: JSON.stringify({ name: "Chris", passphrase: "pw" }) }));
  return handle(new Request(`https://compass.test${path}`, { method, headers: { cookie: login.headers.get("set-cookie")!.split(";")[0], "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }));
};
beforeEach(() => { openLocal(); kicks = 0; onJudgeQueued(() => { kicks++; }); });

describe("forecasts and outcomes", () => {
  test("start captures the forecast, claims unowned work and preserves it through rejudgment and late debrief", async () => {
    const id = create();
    db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(JSON.stringify(dims(1)), id);
    setStatus(id, "doing", "Chris");
    expect(getTask(id)!.owner).toBe("Chris");
    const start = outcomeForecast(getTask(id)!);
    expect(start.levels.effort).toBe(1);
    db.query("UPDATE tasks SET dims = ? WHERE id = ?").run(JSON.stringify(dims(4)), id);
    setStatus(id, "done", "Chris");
    const completion = getTask(id)!.done_at;
    setStatus(id, "done", "Chris");
    expect(getTask(id)!.done_at).toBe(completion);
    expect(outcomeForecast(getTask(id)!)).toEqual(start);
    const res = await asPerson("/api/debriefs", "POST", { taskId: id, result: "better", effort: 3, defensibility: 3, quality: 3 });
    expect(res.status).toBe(200);
    const saved = db.query("SELECT predicted, predicted_dist FROM debriefs WHERE task_id = ?").get(id) as any;
    expect(JSON.parse(saved.predicted).effort).toBe(1);
    expect(JSON.parse(saved.predicted_dist).effort).toEqual([0, 1, 0, 0, 0]);
    expect((await asPerson("/api/followups", "POST", { taskId: id, impact: 4 })).status).toBe(200);
    expect(db.query("SELECT predicted_impact FROM followups WHERE task_id = ?").get(id).predicted_impact).toBe(1);
  });
  test("direct completion captures a forecast; legacy rows remain explicit fallbacks", () => {
    const id = create();
    expect(outcomeForecast(getTask(id)!).at).toBeNull();
    setStatus(id, "done", "Chris");
    expect(outcomeForecast(getTask(id)!).at).toBeTruthy();
    expect(outcomeForecast(getTask(id)!).beliefs.effort).toEqual(uniform());
  });
  test("unconfirmed and disputed agent lessons never become trusted team context", async () => {
    const feeder = create({ who: "Codex (agent)" }), team = create(), agentTask = create({ who: "Codex (agent)" });
    setStatus(feeder, "done", "Codex (agent)");
    expect((await agent("/api/debriefs", "POST", { taskId: feeder, result: "better", effort: 1, defensibility: 1, quality: 1, lesson: "Unsupported claim" })).status).toBe(200);
    for (const id of [team, agentTask]) db.query("INSERT INTO links (from_id, to_id, kind, at) VALUES (?, ?, 'boosts', 'now')").run(feeder, id);
    expect(lessons()).toEqual([]);
    expect(lessons(6, true).join()).toContain("[Unconfirmed agent report]");
    expect(upstreamEvidence(team).join()).not.toContain("Unsupported claim");
    expect(upstreamEvidence(agentTask).join()).toContain("unconfirmed agent lesson");
    expect((await asPerson(`/api/debriefs/${feeder}/review`, "POST", { verdict: "confirmed" })).status).toBe(200);
    expect(lessons().join()).toContain("Unsupported claim");
    expect(upstreamEvidence(team).join()).toContain("Unsupported claim");
    expect((await asPerson(`/api/debriefs/${feeder}/review`, "POST", { verdict: "disputed" })).status).toBe(200);
    expect(lessons(6, true)).toEqual([]);
    expect(upstreamEvidence(agentTask).join()).not.toContain("Unsupported claim");
  });
});

describe("durable judgment queue", () => {
  test("a result from an old task revision cannot overwrite an edit", async () => {
    const id = create();
    let release!: (j: Judgment) => void;
    const run = judgePending({ judgeTask: () => new Promise(r => { release = r; }) });
    db.query("UPDATE tasks SET title = 'Revised task' WHERE id = ?").run(id);
    queueJudge(id);
    release(judgment(4));
    await run;
    expect(getTask(id)!.judge).toBe("pending");
    expect(getTask(id)!.dims).toBeNull();
    expect(db.query("SELECT * FROM forecasts").all()).toHaveLength(0);
    expect(kicks).toBeGreaterThanOrEqual(3);
    await judgePending({ judgeTask: async () => judgment(1) });
    expect(getTask(id)!.judge).toBe("jev");
    expect(JSON.parse(getTask(id)!.dims!).effort[1]).toBe(1);
    expect(getTask(id)!.judged_brief_hash).toBeTruthy();
    expect(db.query("SELECT * FROM forecasts").all()).toHaveLength(1);
  });
  test("an old provider failure cannot erase a newer queued revision", async () => {
    const id = create();
    let fail!: (e: Error) => void;
    const run = judgePending({ judgeTask: () => new Promise((_, reject) => { fail = reject; }) });
    queueJudge(id); fail(new Error("old failure")); await run;
    expect(getTask(id)!.judge).toBe("pending");
    expect(getTask(id)!.judge_error).toBeNull();
  });
  test("brief edits during a request invalidate its response", async () => {
    const id = create();
    let release!: (j: Judgment) => void;
    const run = judgePending({ judgeTask: () => new Promise(r => { release = r; }) });
    setBrief("Changed brief while a judgment was in flight", "Chris");
    release(judgment()); await run;
    expect(getTask(id)!.judge).toBe("pending");
    expect(db.query("SELECT * FROM forecasts").all()).toHaveLength(0);
  });
  test("overlapping drains share one request; completed tasks cannot receive its response", async () => {
    const id = create(); let calls = 0, release!: (j: Judgment) => void;
    const first = judgePending({ judgeTask: () => { calls++; return new Promise(r => { release = r; }); } });
    const second = judgePending({ judgeTask: async () => { calls++; return judgment(); } });
    expect(first).toBe(second); expect(calls).toBe(1);
    setStatus(id, "done", "Chris"); release(judgment()); await first;
    expect(getTask(id)!.dims).toBeNull();
    expect(db.query("SELECT * FROM forecasts").all()).toHaveLength(0);
  });
  test("bounded batches reschedule remaining work, and errors are observable", async () => {
    create(); create(); create();
    const before = kicks;
    expect(await judgePending({ batch: 2, judgeTask: async () => judgment() })).toBe(2);
    expect(db.query("SELECT id FROM tasks WHERE judge = 'pending'").all()).toHaveLength(1);
    expect(kicks).toBe(before + 1);
    await judgePending({ judgeTask: async () => { throw new Error("provider down"); } });
    expect(buildState(null, false).health.counts.failedJudgments).toBe(1);
  });
  test("repeated queue API calls do not invalidate an in-flight response or escape agent write accounting", async () => {
    const id = create();
    const revision = getTask(id)!.judge_revision;
    expect((await agent(`/api/tasks/${id}/judge`, "POST", {})).status).toBe(200);
    expect(getTask(id)!.judge_revision).toBe(revision);
    db.query("UPDATE tasks SET judge = 'error' WHERE id = ?").run(id);
    expect((await agent(`/api/tasks/${id}/judge`, "POST", {})).status).toBe(200);
    expect(getTask(id)!.judge_revision).toBe(revision + 1);
    expect(db.query("SELECT * FROM events WHERE kind = 'task.judge' AND who = 'Codex (agent)'").all()).toHaveLength(1);
  });
});

describe("agent progress boundaries", () => {
  test("approval blockers enforce wait on status and checklist changes, and cannot be self-withdrawn", async () => {
    const id = create({ steps: ["Get approval"] });
    const opened = await agent("/api/interventions", "POST", { taskId: id, kind: "approval", need: "Approve this release before continuing" });
    const iv = (await opened.json() as any).id;
    expect((await agent(`/api/tasks/${id}`, "PATCH", { status: "done" })).status).toBe(409);
    expect((await agent(`/api/tasks/${id}`, "PATCH", { steps: [{ text: "Get approval", done: true }] })).status).toBe(409);
    expect(getTask(id)!.status).toBe("open");
    expect((await agent(`/api/interventions/${iv}`, "PATCH", { resolution: "withdrawn" })).status).toBe(403);
    expect((await asPerson(`/api/interventions/${iv}`, "PATCH", { resolution: "done" })).status).toBe(200);
    expect((await agent(`/api/tasks/${id}`, "PATCH", { status: "done" })).status).toBe(200);
  });
  test("an unfinished prerequisite cannot be bypassed by changing its link kind", async () => {
    const from = create(), to = create();
    db.query("INSERT INTO links (from_id, to_id, kind, at) VALUES (?, ?, 'unblocks', 'now')").run(from, to);
    expect((await agent(`/api/tasks/${to}`, "PATCH", { status: "doing" })).status).toBe(409);
    expect((await agent("/api/links", "POST", { from, to, kind: "boosts" })).status).toBe(403);
    expect(allLinks()[0].kind).toBe("unblocks");
    setStatus(from, "done", "Chris");
    expect((await agent(`/api/tasks/${to}`, "PATCH", { status: "doing" })).status).toBe(200);
  });
  test("an agent can tick a checklist but cannot rewrite it", async () => {
    const id = create({ steps: ["Run verification"] });
    expect((await agent(`/api/tasks/${id}`, "PATCH", { steps: [{ text: "Skip verification", done: true }] })).status).toBe(403);
    expect((await agent(`/api/tasks/${id}`, "PATCH", { steps: [{ text: "Run verification", done: true }] })).status).toBe(200);
  });
  test("parallel writes cannot race past the daily limit", async () => {
    for (let i = 0; i < 199; i++) db.query("INSERT INTO events (kind, who, at) VALUES ('task.add', 'Codex (agent)', ?)").run(new Date().toISOString());
    const results = await Promise.all([agent("/api/tasks", "POST", { title: "One" }), agent("/api/tasks", "POST", { title: "Two" })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 429]);
    expect(db.query("SELECT id FROM tasks").all()).toHaveLength(1);
  });
  test("a rejected mixed task patch has no partial lane or owner change", async () => {
    const id = create();
    expect((await asPerson(`/api/tasks/${id}`, "PATCH", { lane: "agent", status: "invalid" })).status).toBe(400);
    expect(getTask(id)!.lane).toBe("team");
    expect((await asPerson(`/api/tasks/${id}`, "PATCH", { lane: "agent", owner: "Stranger" })).status).toBe(400);
    expect(getTask(id)!.lane).toBe("team");
  });
});

describe("workspace health", () => {
  test("unknown metrics stay unknown and old work has actionable diagnostics", () => {
    const at = new Date("2026-11-16T10:00:00Z");
    const h = workspaceHealth({ tasks: [{ id: "x", title: "Stale work", status: "doing", owner: null, lane: "team", doneWhen: "", judge: "error", startedAt: "2026-11-01T10:00:00Z", judgedAt: null, judgedBriefHash: null }], blocked: 1, debriefs: [], followUps: [], openInterventions: 0, missingMetrics: 6, briefAt: null, briefHash: "hash" }, at);
    expect(h.counts.missingMetrics).toBe(6);
    expect(h.issues.map(i => i.key)).toEqual(expect.arrayContaining(["judgment-errors", "unassigned", "done-criteria", "stale-progress", "metrics", "brief"]));
    expect(h.issues.find(i => i.key === "metrics")!.detail).toContain("unknown");
    expect(h.issues.find(i => i.key === "stale-progress")!.tasks[0].id).toBe("x");
  });
  test("authenticated health summarizes the same workspace without exposing OAuth records", async () => {
    create();
    const res = await asPerson("/api/health", "GET", {});
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true); expect(body.counts.open).toBe(1);
    expect(JSON.stringify(body)).not.toContain("oauth_records");
    expect((await handle(new Request("https://compass.test/api/health"))).status).toBe(401);
  });
});
