// The sync between the lanes: people see what agents did since they last looked; agents see what people changed.
process.env.COMPASS_DB = ":memory:";
import { describe, expect, test } from "bun:test";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { createHandler } = await import("../src/api.ts");
const { onJudgeQueued, buildState } = await import("../src/state.ts");
onJudgeQueued(() => {});

const TOKEN = "agent-token-0123456789abcdefghijklmnopqrstuvwxyz";
const handle = createHandler({ users: "Chris:alpha beta,Alex:gamma delta", sessionKey: "test-session-key-0123456789", agents: `Claude:${TOKEN}` });
const B = "https://compass.test";
const call = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) => handle(new Request(B + path, {
  ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
}));
const agent = (path: string, init: RequestInit = {}) => call(path, { ...init, token: TOKEN });
let cookie = "";
const chris = async (path: string, init: RequestInit = {}) => {
  if (!cookie) cookie = ((await call("/api/login", { method: "POST", body: JSON.stringify({ name: "Chris", passphrase: "alpha beta" }) })).headers.get("set-cookie") ?? "").split(";")[0];
  return call(path, { ...init, cookie });
};
const post = (b: unknown) => ({ method: "POST", body: JSON.stringify(b) });
const patch = (b: unknown) => ({ method: "PATCH", body: JSON.stringify(b) });
const idOf = async (r: Response) => ((await r.json()) as { id: string }).id;

describe("agents to people", () => {
  test("what an agent did shows on the person's Today until they mark it read, with the debrief's result", async () => {
    const id = await idOf(await agent("/api/tasks", post({ title: "Nightly CVE patrol" })));
    await agent(`/api/tasks/${id}`, patch({ status: "done" }));
    await agent("/api/debriefs", post({ taskId: id, result: "better", effort: 1, defensibility: 3, quality: 3, asset: "a nightly workflow" }));
    const u = buildState("Chris", false).agentUpdates!;
    expect(u.since).toBeNull();
    expect(u.items.map((e) => e.kind)).toEqual(expect.arrayContaining(["task.add", "task.done", "debrief"]));
    const d = u.items.find((e) => e.kind === "debrief")!;
    expect([d.result, d.asset, d.taskTitle]).toEqual(["better", "a nightly workflow", "Nightly CVE patrol"]);

    expect((await agent("/api/seen", { method: "POST", body: "{}" })).status).toBe(403);
    await new Promise((r) => setTimeout(r, 5));
    expect((await chris("/api/seen", { method: "POST", body: "{}" })).status).toBe(200);
    expect(buildState("Chris", false).agentUpdates!.items).toHaveLength(0);
    // Read for Chris is still unread for Alex.
    expect(buildState("Alex", false).agentUpdates!.items.length).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 5));
    await agent("/api/tasks", post({ title: "A new proposal" }));
    expect(buildState("Chris", false).agentUpdates!.items.map((e) => e.taskTitle)).toEqual(["A new proposal"]);
  });

  test("people's own events are not agent updates, and an agent has no agent updates", async () => {
    await new Promise((r) => setTimeout(r, 5));
    await chris("/api/seen", { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 5));
    await chris("/api/tasks", post({ title: "Chris's own task" }));
    expect(buildState("Chris", false).agentUpdates!.items).toHaveLength(0);
    expect(buildState("Claude (agent)", false).agentUpdates).toBeNull();
  });
});

describe("people to agents", () => {
  test("agent next carries what people changed: lane moves, finishes, answers", async () => {
    const id = await idOf(await chris("/api/tasks", post({ title: "Given to the agents" })));
    await chris(`/api/tasks/${id}`, patch({ lane: "agent" }));
    const ask = await agent("/api/interventions", post({ taskId: id, kind: "information", need: "Which repository holds this?" }));
    const ivId = ((await ask.json()) as { id: number }).id;
    await chris(`/api/interventions/${ivId}`, patch({ resolution: "workaround", note: "Use argus-1" }));
    const next = (await (await agent("/api/agent/next")).json()) as { teamChanges: { kind: string; taskTitle: string; who: string }[] };
    const kinds = next.teamChanges.filter((c) => c.taskTitle === "Given to the agents").map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["task.add", "task.lane", "intervention.resolve"]));
    expect(next.teamChanges.every((c) => !c.who.endsWith("(agent)"))).toBe(true);
    expect(next.teamChanges.some((c) => c.kind === "login")).toBe(false);
  });
});
