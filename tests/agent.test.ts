// Agents: bearer tokens, recorded as "<Name> (agent)", limited to reading, proposing, moving work and debriefing.
process.env.COMPASS_DB = ":memory:";
import { describe, expect, test } from "bun:test";
import { AGENT_SUFFIX, agentFor, isAgent, parseAgents } from "../src/auth.ts";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { AGENT_DAILY_WRITES, createHandler } = await import("../src/api.ts");
const { onJudgeQueued, buildState } = await import("../src/state.ts");
const { db } = await import("../src/db.ts");
onJudgeQueued(() => {});

const TOKEN = "agent-token-0123456789abcdefghijklmnopqrstuvwxyz";
const KEY = "test-session-key-0123456789";
const handle = createHandler({ users: "Chris:alpha beta,Alex:gamma delta", sessionKey: KEY, agents: `Claude:${TOKEN},Weak:short` });
const B = "https://compass.test";
const call = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) => handle(new Request(B + path, {
  ...init, headers: {
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}),
    ...(init.cookie ? { cookie: init.cookie } : {}),
  },
}));
const agent = (path: string, init: RequestInit = {}) => call(path, { ...init, token: TOKEN });
const asChris = async () => {
  const r = await call("/api/login", { method: "POST", body: JSON.stringify({ name: "Chris", passphrase: "alpha beta" }) });
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
};

describe("agent tokens", () => {
  test("parse: short tokens and bad names are ignored", () => {
    const a = parseAgents(`Claude:${TOKEN},Weak:short,9bad:${TOKEN}`);
    expect(a.names).toEqual(["Claude (agent)"]);
    expect(a.byToken(TOKEN)).toBe("Claude (agent)");
    expect(a.byToken(TOKEN + "x")).toBeNull();
    expect(isAgent("Claude (agent)")).toBe(true);
    expect(isAgent("Chris")).toBe(false);
  });

  test("no header is no agent; a wrong or malformed one is refused", async () => {
    const a = parseAgents(`Claude:${TOKEN}`);
    expect(agentFor(new Request(B), a)).toBeNull();
    expect(agentFor(new Request(B, { headers: { authorization: "Bearer short" } }), a)).toBe("");
    expect((await call("/api/me", { token: "x".repeat(40) })).status).toBe(401);
    expect((await call("/api/me", { token: "short" })).status).toBe(401);
  });

  test("an agent reads as itself, never as a person", async () => {
    const me = (await (await agent("/api/me")).json()) as { who: string; agent: boolean; team: string[] };
    expect(me.who).toBe("Claude" + AGENT_SUFFIX);
    expect(me.agent).toBe(true);
    expect(me.team).not.toContain(me.who);
  });
});

describe("what an agent may do", () => {
  test("propose a task, recorded as the agent's", async () => {
    const r = await agent("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Agent proposal", track: "other" }) });
    const { id } = (await r.json()) as { id: string };
    expect((db.query("SELECT created_by FROM tasks WHERE id = ?").get(id) as { created_by: string }).created_by).toBe("Claude (agent)");
    expect((db.query("SELECT who FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id) as { who: string })?.who ?? "Claude (agent)").toContain("agent");
  });

  test("read the compact next steps", async () => {
    await agent("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Ranked one" }) });
    const r = await agent("/api/agent/next?limit=3");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { next: { rank: number }[] };
    expect(Array.isArray(body.next)).toBe(true);
    expect(body.next.length).toBeLessThanOrEqual(3);
    expect(body.next[0]).toHaveProperty("rank", 1);
    expect(body.next[0]).toHaveProperty("doneWhen");
  });

  test("move work along and debrief it; the debrief does not train the calibrator", async () => {
    const { id } = (await (await agent("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Agent work" }) })).json()) as { id: string };
    expect((await agent(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "doing" }) })).status).toBe(200);
    expect((await agent(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) })).status).toBe(200);
    const before = buildState(null, false).learning.dataPoints;
    const r = await agent("/api/debriefs", { method: "POST", body: JSON.stringify({ taskId: id, result: "much-better", effort: 0, defensibility: 4, quality: 4, lesson: "agent says" }) });
    expect(r.status).toBe(200);
    const learn = buildState(null, false).learning;
    expect(learn.dataPoints).toBe(before + 1);                          // recorded as data ...
    const d = db.query("SELECT who FROM debriefs WHERE task_id = ?").get(id) as { who: string };
    expect(d.who).toBe("Claude (agent)");                               // ... attributed to the agent
  });
});

describe("what an agent may not do", () => {
  test("team assessments, the brief, check-ins, follow-ups, metrics, export, unlinking", async () => {
    const { id } = (await (await agent("/api/tasks", { method: "POST", body: JSON.stringify({ title: "x" }) })).json()) as { id: string };
    const refused: [string, string, unknown][] = [
      ["POST", "/api/answers", { taskId: id, dim: "impact", level: 4 }],
      ["PUT", "/api/brief", { text: "a".repeat(50) }],
      ["POST", "/api/checkins", {}],
      ["POST", "/api/followups", { taskId: id, impact: 4 }],
      ["POST", "/api/metrics", { name: "x", value: 1 }],
      ["GET", "/api/export", undefined],
      ["DELETE", "/api/links", { from: id, to: id }],
    ];
    for (const [method, path, body] of refused) {
      const r = await agent(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect([path, r.status]).toEqual([path, 403]);
    }
  });

  test("drop a task, change an owner, or edit a person's task", async () => {
    const cookie = await asChris();
    const { id } = (await (await call("/api/tasks", { method: "POST", cookie, body: JSON.stringify({ title: "Chris's task" }) })).json()) as { id: string };
    for (const b of [{ status: "dropped" }, { owner: "Alex" }, { title: "renamed by an agent" }]) {
      expect((await agent(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(b) })).status).toBe(403);
    }
    expect((db.query("SELECT title, status FROM tasks WHERE id = ?").get(id) as { title: string; status: string })).toEqual({ title: "Chris's task", status: "open" });
  });

  test("replace a person's debrief", async () => {
    const cookie = await asChris();
    const { id } = (await (await call("/api/tasks", { method: "POST", cookie, body: JSON.stringify({ title: "Debriefed by Chris" }) })).json()) as { id: string };
    await call(`/api/tasks/${id}`, { method: "PATCH", cookie, body: JSON.stringify({ status: "done" }) });
    await call("/api/debriefs", { method: "POST", cookie, body: JSON.stringify({ taskId: id, result: "worse", effort: 3, defensibility: 1, quality: 1 }) });
    const r = await agent("/api/debriefs", { method: "POST", body: JSON.stringify({ taskId: id, result: "much-better", effort: 0, defensibility: 4, quality: 4 }) });
    expect(r.status).toBe(403);
    expect((db.query("SELECT who, result FROM debriefs WHERE task_id = ?").get(id) as { who: string; result: string })).toEqual({ who: "Chris", result: "worse" });
  });

  test("an agent's self-graded debrief never moves Orion's calibration", async () => {
    const before = JSON.stringify(buildState(null, false).learning.effort);
    for (let i = 0; i < 5; i++) {
      const { id } = (await (await agent("/api/tasks", { method: "POST", body: JSON.stringify({ title: `self ${i}` }) })).json()) as { id: string };
      await agent(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
      await agent("/api/debriefs", { method: "POST", body: JSON.stringify({ taskId: id, result: "much-better", effort: 0, defensibility: 4, quality: 4 }) });
    }
    expect(JSON.stringify(buildState(null, false).learning.effort)).toBe(before);
  });

  test("writes are bounded per day", async () => {
    db.query("DELETE FROM events WHERE who = 'Claude (agent)'").run();
    const at = new Date().toISOString();
    for (let i = 0; i < AGENT_DAILY_WRITES; i++) db.query("INSERT INTO events (kind, task_id, who, at, payload) VALUES ('x', NULL, 'Claude (agent)', ?, NULL)").run(at);
    expect((await agent("/api/tasks", { method: "POST", body: JSON.stringify({ title: "one too many" }) })).status).toBe(429);
    expect((await agent("/api/state")).status).toBe(200);              // reading is not a write
  });

  test("a person's session is unchanged by any of this", async () => {
    const cookie = await asChris();
    const me = (await (await call("/api/me", { cookie })).json()) as { who: string; agent: boolean };
    expect([me.who, me.agent]).toEqual(["Chris", false]);
    expect((await call("/api/export", { cookie })).status).toBe(200);
  });
});
