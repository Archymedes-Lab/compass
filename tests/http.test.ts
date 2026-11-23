// The handler as the Worker serves it: sign-in, session, who comes from the session, CSRF guard, check-in → debrief.
process.env.COMPASS_DB = ":memory:";
import { describe, expect, test } from "bun:test";
import { parseUsers, sessionCookie, sessionUser } from "../src/auth.ts";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { createHandler } = await import("../src/api.ts");
const { onJudgeQueued } = await import("../src/state.ts");
onJudgeQueued(() => {});

const KEY = "test-session-key-0123456789";
const handle = createHandler({ users: "Chris:alpha beta,Alex:gamma delta", sessionKey: KEY });
const B = "https://compass.test";
const call = (path: string, init: RequestInit & { cookie?: string } = {}) => handle(new Request(B + path, {
  ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as object) },
}));

async function signIn(name: string, passphrase: string) {
  const r = await call("/api/login", { method: "POST", body: JSON.stringify({ name, passphrase }) });
  return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("auth", () => {
  test("users parse; passphrases may contain spaces and colons", () => {
    const u = parseUsers("A:x y:z, B:q");
    expect(u.names).toEqual(["A", "B"]);
    expect(u.check("A", "x y:z")).toBe(true);
    expect(u.check("A", "x y")).toBe(false);
    expect(u.check("C", "q")).toBe(false);
  });

  test("a forged or foreign-key cookie is rejected", async () => {
    const users = parseUsers("Chris:p");
    const good = (await sessionCookie(KEY, "Chris", true)).split(";")[0];
    const req = (c: string) => new Request(B, { headers: { cookie: c } });
    expect(await sessionUser(req(good), KEY, users)).toBe("Chris");
    expect(await sessionUser(req(good), "another-key-0123456789", users)).toBeNull();
    expect(await sessionUser(req(good.replace("Chris", "Alex")), KEY, parseUsers("Chris:p,Alex:q"))).toBeNull();
  });

  test("refuses to start without users or with a short key", () => {
    expect(() => createHandler({ users: "", sessionKey: KEY })).toThrow();
    expect(() => createHandler({ users: "A:b", sessionKey: "short" })).toThrow();
  });
});

describe("api", () => {
  test("everything but login needs a session", async () => {
    expect((await call("/api/state")).status).toBe(401);
    expect((await signIn("Chris", "wrong")).status).toBe(401);
    expect((await signIn("Chris", "alpha beta")).status).toBe(200);
  });

  test("writes need JSON (no cross-site form posts)", async () => {
    const { cookie } = await signIn("Chris", "alpha beta");
    const r = await handle(new Request(B + "/api/tasks", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "title=x" }));
    expect(r.status).toBe(400);
  });

  test("who is the session, not the body; daily check-in marks done and the debrief appears at once", async () => {
    const { cookie } = await signIn("Alex", "gamma delta");
    const me = await (await call("/api/me", { cookie })).json<any>();
    expect(me).toMatchObject({ who: "Alex", team: ["Chris", "Alex"] });

    const { id } = await (await call("/api/tasks", { method: "POST", cookie, body: JSON.stringify({ title: "Wire checkout", owner: "Alex", who: "Chris" }) })).json<any>();
    await call(`/api/tasks/${id}`, { method: "PATCH", cookie, body: JSON.stringify({ status: "doing" }) });
    let s = await (await call("/api/state", { cookie })).json<any>();
    expect(s.questions.daily.who).toBe("Alex");
    expect(s.questions.daily.inProgress.map((t: { id: string }) => t.id)).toEqual([id]);

    expect((await call("/api/checkins", { method: "POST", cookie, body: JSON.stringify({ updates: { [id]: { state: "done" } }, learned: "agencies want mobile money" }) })).status).toBe(200);
    s = await (await call("/api/state", { cookie })).json<any>();
    expect(s.questions.daily).toBeNull();
    expect(s.questions.checkedToday).toEqual(["Alex"]);
    expect(s.questions.debriefs.map((d: { taskId: string }) => d.taskId)).toEqual([id]);

    const r = await call("/api/debriefs", { method: "POST", cookie, body: JSON.stringify({ taskId: id, result: "better", effort: 2, defensibility: 1, quality: 3, lesson: "ask early" }) });
    expect(r.status).toBe(200);
    s = await (await call("/api/state", { cookie })).json<any>();
    expect(s.questions.debriefs).toEqual([]);
    expect(s.learning.lessons[0]).toContain("ask early");

    const exp = await (await call("/api/export", { cookie })).json<any>();
    expect(exp.tasks[0].created_by).toBe("Alex");
    expect(exp.checkins[0].who).toBe("Alex");
  });

  test("brief is editable and feeds the judge context", async () => {
    const { cookie } = await signIn("Chris", "alpha beta");
    expect((await (await call("/api/brief", { cookie })).json<any>()).text).toContain("Example company");
    expect((await call("/api/brief", { method: "PUT", cookie, body: JSON.stringify({ text: "short" }) })).status).toBe(400);
    const text = "Archymedes, two founders now. Goal: first paying Argus customers this month, then retention.";
    expect((await call("/api/brief", { method: "PUT", cookie, body: JSON.stringify({ text }) })).status).toBe(200);
    expect(await (await call("/api/brief", { cookie })).json<any>()).toMatchObject({ text, who: "Chris" });
  });
});
