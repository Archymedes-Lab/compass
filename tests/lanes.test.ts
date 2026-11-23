// Two lanes: the agent lane learns faster and separately; agents ask people through interventions; directives tell an
// agent to proceed, wait, work around or stop, and never to route around a person's authority.
process.env.COMPASS_DB = ":memory:";
import { describe, expect, test } from "bun:test";
import { AUTHORITY, directive, SLA_HOURS, agentLaneWeight, type Intervention } from "../src/lanes.ts";
import { biases, learn } from "../src/calibrate.ts";
import { isAgent } from "../src/auth.ts";
import { DIMS } from "../src/dims.ts";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { createHandler } = await import("../src/api.ts");
const { onJudgeQueued, buildState } = await import("../src/state.ts");
const { db } = await import("../src/db.ts");
onJudgeQueued(() => {});

const TOKEN = "agent-token-0123456789abcdefghijklmnopqrstuvwxyz";
const handle = createHandler({ users: "Chris:alpha beta,Alex:gamma delta", sessionKey: "test-session-key-0123456789", agents: `Claude:${TOKEN}` });
const B = "https://compass.test";
const call = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) => handle(new Request(B + path, {
  ...init, headers: {
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}),
    ...(init.cookie ? { cookie: init.cookie } : {}),
  },
}));
const agent = (path: string, init: RequestInit = {}) => call(path, { ...init, token: TOKEN });
let cookie = "";
const chris = async (path: string, init: RequestInit = {}) => {
  if (!cookie) {
    const r = await call("/api/login", { method: "POST", body: JSON.stringify({ name: "Chris", passphrase: "alpha beta" }) });
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  }
  return call(path, { ...init, cookie });
};
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const idOf = async (r: Response) => ((await r.json()) as { id: string }).id;

const iv = (over: Partial<Intervention>): Intervention => ({
  id: 1, taskId: "t", kind: "information", need: "Which domain should the relay use?", tried: null, status: "open",
  createdBy: "Claude (agent)", createdAt: "2026-11-12T00:00:00.000Z", resolvedBy: null, resolvedAt: null, resolution: null, note: null, ...over,
});
const at = (hours: number) => new Date(Date.parse("2026-11-12T00:00:00.000Z") + hours * 3_600_000);

describe("directives", () => {
  test("nothing waiting: proceed", () => {
    expect(directive([], at(0)).action).toBe("proceed");
  });
  test("a practical blocker waits, then turns into work-around after the SLA", () => {
    expect(directive([iv({})], at(SLA_HOURS - 1)).action).toBe("wait");
    const d = directive([iv({})], at(SLA_HOURS));
    expect(d.action).toBe("work-around");
    expect(d.auto).toBe(true);
  });
  test("authority never times out into a work-around, and says not to bypass it", () => {
    for (const kind of AUTHORITY) {
      const d = directive([iv({ kind })], at(24 * 30));
      expect(d.action).toBe("wait");
      expect(d.why).toContain("Do not perform, simulate or bypass");
    }
  });
  test("an open authority request outranks a stale practical one", () => {
    expect(directive([iv({ id: 1 }), iv({ id: 2, kind: "approval", createdAt: "2026-11-12T10:00:00.000Z" })], at(48)).action).toBe("wait");
  });
  test("a person's answers: workaround with a hint, declined stops, done proceeds; withdrawn is ignored", () => {
    const resolved = (resolution: Intervention["resolution"], note: string | null = null, kind: Intervention["kind"] = "information") =>
      iv({ status: "resolved", resolution, note, kind, resolvedBy: "Chris", resolvedAt: "2026-11-12T05:00:00.000Z" });
    const w = directive([resolved("workaround", "Use the staging domain")], at(6));
    expect(w.action).toBe("work-around");
    expect(w.hint).toBe("Use the staging domain");
    expect(directive([resolved("workaround", null, "approval")], at(6)).why).toContain("does not need it");
    expect(directive([resolved("declined", "Not this quarter")], at(6)).action).toBe("stop");
    expect(directive([resolved("done")], at(6)).action).toBe("proceed");
    expect(directive([resolved("withdrawn")], at(6)).why).toBe("Nothing is waiting on a person.");
  });
});

describe("the agent lane learns faster, and only from what counts", () => {
  const obs = [{ dim: "quality" as const, predicted: 2, actual: 4 }];
  test("one outcome moves the agent lane about four times further than the team lane", () => {
    const team = biases(obs).quality.bias, fast = biases(obs, 1).quality.bias;
    expect(team).toBeCloseTo(0.4, 2);
    expect(fast).toBeCloseTo(1, 2);
  });
  test("weights: a person counts fully, an agent's own report half, confirmed fully, disputed not at all", () => {
    expect(agentLaneWeight("Chris", null, isAgent)).toBe(1);
    expect(agentLaneWeight("Claude (agent)", null, isAgent)).toBe(0.5);
    expect(agentLaneWeight("Claude (agent)", "confirmed", isAgent)).toBe(1);
    expect(agentLaneWeight("Claude (agent)", "disputed", isAgent)).toBe(0);
    expect(biases([{ ...obs[0], w: 0 }], 1).quality.n).toBe(0);
    expect(biases([{ ...obs[0], w: 0.5 }], 1).quality.bias).toBeCloseTo(2 * 0.5 / 1.5, 2);
  });
  test("the agent lane may shift effort; the team lane never does", () => {
    const e = [{ dim: "effort" as const, predicted: 1, actual: 3 }];
    expect(learn(e).bias.effort.applied).toBe(false);
    expect(learn(e, 1, true).bias.effort.applied).toBe(true);
  });
});

describe("lanes through the API", () => {
  test("an agent's proposal lands in the agent lane, a person's in the team lane unless chosen", async () => {
    const a = await idOf(await agent("/api/tasks", post({ title: "Agent lane task", lane: "team" })));
    const p = await idOf(await chris("/api/tasks", post({ title: "Team lane task" })));
    const q = await idOf(await chris("/api/tasks", post({ title: "Given to agents", lane: "agent" })));
    const lane = (id: string) => (db.query("SELECT lane FROM tasks WHERE id = ?").get(id) as { lane: string }).lane;
    expect([lane(a), lane(p), lane(q)]).toEqual(["agent", "team", "agent"]);
    const st = buildState("Chris", false);
    expect(st.lanes.agent).toContain(a);
    expect(st.lanes.team).toContain(p);
    expect(st.lanes.team).not.toContain(a);
  });

  test("only a person moves a task between lanes", async () => {
    const id = await idOf(await chris("/api/tasks", post({ title: "Movable" })));
    expect((await agent(`/api/tasks/${id}`, patch({ lane: "agent" }))).status).toBe(403);
    expect((await chris(`/api/tasks/${id}`, patch({ lane: "agent" }))).status).toBe(200);
    expect((await chris(`/api/tasks/${id}`, patch({ lane: "robots" }))).status).toBe(400);
    expect(buildState("Chris", false).lanes.agent).toContain(id);
  });

  test("a person's focus comes from the team lane only", async () => {
    db.query("UPDATE tasks SET lane = 'agent'").run();
    const t = await idOf(await chris("/api/tasks", post({ title: "The only team task" })));
    expect(buildState("Chris", false).focus?.id).toBe(t);
  });

  test("an agent asks for help; it heads the dashboard; only a person answers; the agent sees the directive", async () => {
    const id = await idOf(await agent("/api/tasks", post({ title: "Needs a domain" })));
    expect((await agent("/api/interventions", post({ taskId: id, kind: "nonsense", need: "Need something here" }))).status).toBe(400);
    expect((await agent("/api/interventions", post({ taskId: id, kind: "information", need: "?" }))).status).toBe(400);
    const r = await agent("/api/interventions", post({ taskId: id, kind: "information", need: "Which domain should the relay use?", tried: "Searched the docs" }));
    const ivId = ((await r.json()) as { id: number }).id;
    const st = buildState("Chris", false);
    const open = st.interventions.open.find((i) => i.id === ivId)!;
    expect(open.createdBy).toBe("Claude (agent)");
    expect(open.taskTitle).toBe("Needs a domain");
    expect(st.list.find((t) => t.id === id)!.directive.action).toBe("wait");

    expect((await agent(`/api/interventions/${ivId}`, patch({ resolution: "done" }))).status).toBe(403);
    expect((await agent(`/api/interventions/${ivId}`, patch({ resolution: "workaround" }))).status).toBe(403);
    expect((await chris(`/api/interventions/${ivId}`, patch({ resolution: "workaround", note: "Use relay.archymedes.xyz" }))).status).toBe(200);
    expect((await chris(`/api/interventions/${ivId}`, patch({ resolution: "done" }))).status).toBe(400);

    const next = (await (await agent("/api/agent/next?limit=50")).json()) as { lane: string; next: { id: string; directive: { action: string; hint?: string } }[]; answered: { id: number; resolution: string }[] };
    expect(next.lane).toBe("agent");
    const mine = next.next.find((t) => t.id === id)!;
    expect(mine.directive.action).toBe("work-around");
    expect(mine.directive.hint).toBe("Use relay.archymedes.xyz");
    expect(next.answered.find((a) => a.id === ivId)?.resolution).toBe("workaround");
  });

  test("an agent may withdraw its own request, not someone else's", async () => {
    const id = await idOf(await agent("/api/tasks", post({ title: "Withdrawable" })));
    const mine = ((await (await agent("/api/interventions", post({ taskId: id, kind: "access", need: "Read access to the billing page" }))).json()) as { id: number }).id;
    const theirs = ((await (await chris("/api/interventions", post({ taskId: id, kind: "decision", need: "Decide the plan names first" }))).json()) as { id: number }).id;
    expect((await agent(`/api/interventions/${theirs}`, patch({ resolution: "withdrawn" }))).status).toBe(403);
    expect((await agent(`/api/interventions/${mine}`, patch({ resolution: "withdrawn" }))).status).toBe(200);
  });

  test("at most three open requests per task", async () => {
    const id = await idOf(await agent("/api/tasks", post({ title: "Many questions" })));
    for (let i = 0; i < 3; i++) expect((await agent("/api/interventions", post({ taskId: id, kind: "information", need: `Question number ${i} here` }))).status).toBe(200);
    expect((await agent("/api/interventions", post({ taskId: id, kind: "information", need: "One question too many" }))).status).toBe(400);
  });

  test("agent next lists actionable work before waiting work, and ?lane=team reads the team lane", async () => {
    db.query("DELETE FROM interventions").run();
    const waiting = await idOf(await agent("/api/tasks", post({ title: "Waiting on approval" })));
    await agent("/api/interventions", post({ taskId: waiting, kind: "approval", need: "Approve the production deploy" }));
    const ready = await idOf(await agent("/api/tasks", post({ title: "Ready to go" })));
    const next = (await (await agent("/api/agent/next?limit=50")).json()) as { next: { id: string; directive: { action: string } }[] };
    const pos = (id: string) => next.next.findIndex((t) => t.id === id);
    expect(pos(ready)).toBeLessThan(pos(waiting));
    expect(next.next[pos(waiting)].directive.action).toBe("wait");
    const team = (await (await agent("/api/agent/next?lane=team&limit=50")).json()) as { next: { lane: string }[] };
    expect(team.next.every((t) => t.lane === "team")).toBe(true);
    expect((await agent("/api/agent/next?lane=robots")).status).toBe(400);
  });

  test("a person reviews an agent's debrief; the agent lane weights it; the team lane never sees it", async () => {
    const id = await idOf(await agent("/api/tasks", post({ title: "Agent did this" })));
    await agent(`/api/tasks/${id}`, patch({ status: "done" }));
    const debrief = { taskId: id, result: "better", effort: 0, defensibility: 4, quality: 4 };
    expect((await agent("/api/debriefs", post(debrief))).status).toBe(200);
    const before = buildState("Chris", true);
    expect(before.agentLearning.unreviewed.map((u) => u.taskId)).toContain(id);
    const nBefore = before.agentLearning.bias.quality.n;
    const teamBefore = before.learning.bias.quality.n;

    expect((await agent(`/api/debriefs/${id}/review`, post({ verdict: "confirmed" }))).status).toBe(403);
    expect((await chris(`/api/debriefs/${id}/review`, post({ verdict: "maybe" }))).status).toBe(400);
    expect((await chris(`/api/debriefs/${id}/review`, post({ verdict: "confirmed" }))).status).toBe(200);
    const confirmed = buildState("Chris", true);
    expect(confirmed.agentLearning.bias.quality.n).toBeCloseTo(nBefore + 0.5, 5);
    expect(confirmed.learning.bias.quality.n).toBe(teamBefore);

    expect((await chris(`/api/debriefs/${id}/review`, post({ verdict: "disputed" }))).status).toBe(200);
    expect(buildState("Chris", true).agentLearning.bias.quality.n).toBeCloseTo(nBefore - 0.5, 5);
  });

  test("a person's own debrief cannot be 'reviewed'", async () => {
    const id = await idOf(await chris("/api/tasks", post({ title: "Chris did this" })));
    await chris(`/api/tasks/${id}`, patch({ status: "done" }));
    await chris("/api/debriefs", post({ taskId: id, result: "as-expected", effort: 2, defensibility: 2, quality: 2 }));
    expect((await chris(`/api/debriefs/${id}/review`, post({ verdict: "disputed" }))).status).toBe(400);
  });
});

describe("what the agent lane learns changes how its own tasks are ranked", () => {
  test("after agent-lane outcomes, an agent task's belief moves; the same team task's does not", async () => {
    db.query("DELETE FROM debriefs").run();
    const belief = JSON.stringify(Object.fromEntries(DIMS.map((d) => [d, [0.1, 0.2, 0.4, 0.2, 0.1]])));
    const mk = async (lane: string) => {
      const id = await idOf(await chris("/api/tasks", post({ title: `Belief probe ${lane}`, lane })));
      db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(belief, id);
      return id;
    };
    const agentTask = await mk("agent"), teamTask = await mk("team");
    const quality = (id: string) => {
      const p = buildState("Chris", false).list.find((t) => t.id === id)!.dims!.quality;
      return p.reduce((a, q, i) => a + q * i, 0);
    };
    const a0 = quality(agentTask), t0 = quality(teamTask);
    // A person's outcome on an agent-lane task: quality far above what Orion expected.
    const done = await idOf(await chris("/api/tasks", post({ title: "Finished agent work", lane: "agent" })));
    db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(belief, done);
    await chris(`/api/tasks/${done}`, patch({ status: "done" }));
    await chris("/api/debriefs", post({ taskId: done, result: "much-better", effort: 2, defensibility: 2, quality: 4 }));
    expect(quality(agentTask)).toBeGreaterThan(a0 + 0.3);
    expect(quality(teamTask)).toBeCloseTo(t0, 5);
  });
});
