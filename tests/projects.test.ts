// Projects and their context, the project scan, and the per-founder daily email.
process.env.COMPASS_DB = ":memory:";
import { beforeEach, describe, expect, test } from "bun:test";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { createHandler } = await import("../src/api.ts");
const { onJudgeQueued, getTask, setStatus, addTask } = await import("../src/state.ts");
const { db } = await import("../src/db.ts");
const P = await import("../src/projects.ts");
const { repoSlug, repoState } = await import("../src/github.ts");
const S = await import("../src/scan.ts");
const E = await import("../src/email.ts");
const { setAutomationConfig } = await import("../src/automation-store.ts");
const { periodic } = await import("../src/periodic.ts");
const { uniform, DIMS } = await import("../src/dims.ts");
onJudgeQueued(() => {});

const TOKEN = "agent-token-0123456789abcdefghijklmnopqrstuvwxyz";
const SYNC = "sync-token-0123456789abcdefghijklmnopqrstuvwxyz";
const handle = createHandler({ users: "Chris:alpha beta,Alex:gamma delta", sessionKey: "test-session-key-0123456789", agents: `Codex:${TOKEN},Sync:${SYNC}` });
const B = "https://compass.test";
const call = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) => handle(new Request(B + path, {
  ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
}));
let cookie = "";
const asChris = async () => cookie ||= ((await call("/api/login", { method: "POST", body: JSON.stringify({ name: "Chris", passphrase: "alpha beta" }) })).headers.get("set-cookie") ?? "").split(";")[0];
const person = async (path: string, init: RequestInit = {}) => call(path, { ...init, cookie: await asChris() });

const reset = () => { for (const t of ["scan_candidates", "scan_runs", "project_signals", "projects", "links", "answers", "debriefs", "forecasts", "interventions", "tasks", "events", "settings"]) db.exec(`DELETE FROM ${t}`); };
const NOW = new Date("2026-11-18T09:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const sync = (projects: unknown[], machine = "laptop") => ({ machine, projects });
const peaked = (level: number) => [0, 1, 2, 3, 4].map(i => (i === level ? 0.8 : 0.05));
const dimsAt = (level: number) => Object.fromEntries(DIMS.map(d => [d, peaked(level)]));

describe("scrubbing", () => {
  test("removes keys, tokens, emails and long opaque strings; truncates", () => {
    const out = P.scrub("use sk-or-v1-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuv, mail chris@example.com, password: hunter22 " + "x".repeat(300), 120);
    expect(out).not.toContain("sk-or");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("hunter22");
    expect(out.length).toBeLessThanOrEqual(120);
  });
  test("repo slugs from remotes", () => {
    expect(repoSlug("https://github.com/Archymedes-Lab/orion.git")).toBe("Archymedes-Lab/orion");
    expect(repoSlug("git@github.com:chrisnkuno/JARVIS.git")).toBe("chrisnkuno/JARVIS");
    expect(repoSlug("https://gitlab.com/x/y")).toBeNull();
  });
});

describe("context ingest", () => {
  beforeEach(reset);
  const git = { path: "~/orion", branch: "seo/canonical", dirty: 120, ahead: null, behind: null, lastCommitAt: daysAgo(3), commits: [{ sha: "abc123", at: daysAgo(3), subject: "SEO: canonical" }] };

  test("a sync creates projects, matches by repo, and keys working copies by machine and path", async () => {
    const r = await call("/api/context", { method: "POST", token: SYNC, body: JSON.stringify(sync([{ key: "orion", name: "orion", repo: "Archymedes-Lab/orion", git, claude: [{ title: "Orion output export", firstPrompt: "add export of all orion output, key sk-ant-abcdefghijklmnopq", at: daysAgo(0), branch: "seo/canonical" }] }])) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { created: string[] }).created).toEqual(["orion"]);
    // A second checkout of the same repo lands in the same project, as a second working copy.
    await call("/api/context", { method: "POST", token: SYNC, body: JSON.stringify(sync([{ key: "orion-release", name: "orion-release", repo: "Archymedes-Lab/orion", git: { ...git, path: "~/orion-release", dirty: 0 } }])) });
    const projects = P.projectOverview(NOW);
    expect(projects).toHaveLength(1);
    expect(projects[0].git).toHaveLength(2);
    expect(projects[0].sessions[0].firstPrompt).not.toContain("sk-ant");
    const kinds = projects[0].attention.map(a => a.kind);
    expect(kinds).toContain("uncommitted");
    expect(kinds).toContain("unpushed-branch");
    expect(kinds).toContain("agent-work");
  });

  test("rejects transcript-like extra fields and oversize text", async () => {
    const r = await call("/api/context", { method: "POST", token: SYNC, body: JSON.stringify(sync([{ key: "x", name: "x", transcript: "everything" }])) });
    expect(r.status).toBe(400);
  });

  test("an agent reports context via the API; unknown projects are listed, not created", async () => {
    P.createProject({ name: "Argus", repos: ["Archymedes-Lab/argus-1"] }, "Chris");
    const r = await call("/api/context/report", { method: "POST", token: TOKEN, body: JSON.stringify({ reports: [
      { project: "argus-1", summary: "Release 3.12 is tagged; Windows installer still unsigned.", state: "CI green on main", risks: ["Unsigned Windows app"], nextSteps: ["Buy a code-signing certificate"] },
      { project: "nope", summary: "This project does not exist in Compass at all.", state: "", risks: [], nextSteps: [] },
    ] }) });
    expect(await r.json()).toEqual({ stored: ["argus"], unknown: ["nope"] });
    const p = P.projectOverview(NOW).find(x => x.id === "argus")!;
    expect(p.reports[0].who).toBe("Codex (agent)");
    expect(p.reports[0].risks).toEqual(["Unsigned Windows app"]);
  });

  test("people manage projects; agents may only read them", async () => {
    expect((await call("/api/projects", { method: "POST", token: TOKEN, body: JSON.stringify({ name: "Sneaky" }) })).status).toBe(403);
    const created = await (await person("/api/projects", { method: "POST", body: JSON.stringify({ name: "Argus", sites: ["https://archymedes.xyz"] }) })).json() as { id: string };
    expect(created.id).toBe("argus");
    expect((await person("/api/projects/argus", { method: "PATCH", body: JSON.stringify({ sites: ["http://insecure.example"] }) })).status).toBe(400);
    expect((await person("/api/projects/argus", { method: "PATCH", body: JSON.stringify({ status: "paused" }) })).status).toBe(200);
    expect((await call("/api/projects", { token: TOKEN })).status).toBe(200);
  });

  test("tasks carry a project; agent/next filters by it", async () => {
    P.createProject({ name: "Argus" }, "Chris"); P.createProject({ name: "Orion" }, "Chris");
    await person("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Sign the installer", projectId: "argus", lane: "agent" }) });
    await person("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Orion export", projectId: "orion", lane: "agent" }) });
    expect((await person("/api/tasks", { method: "POST", body: JSON.stringify({ title: "x", projectId: "missing" }) })).status).toBe(400);
    const next = await (await call("/api/agent/next?lane=all&project=argus", { token: TOKEN })).json() as { next: { title: string; projectId: string }[] };
    expect(next.next.map((t: { title: string }) => t.title)).toEqual(["Sign the installer"]);
    expect(next.next[0].projectId).toBe("argus");
  });
});

describe("server-side readings", () => {
  beforeEach(reset);
  test("site checks record status and flag a site that is down", async () => {
    P.createProject({ name: "Site", sites: ["https://up.example", "https://down.example"] }, "Chris");
    const fetcher = (async (url: string) => url.includes("down") ? new Response("no", { status: 503 }) : new Response("ok")) as unknown as typeof fetch;
    expect(await P.checkSites(fetcher, NOW)).toBe(2);
    expect(await P.checkSites(fetcher, NOW)).toBe(0); // not due again yet
    const p = P.projectOverview(NOW)[0];
    expect(p.attention[0]).toMatchObject({ kind: "site-down", severity: "high" });
  });

  test("GitHub state: commits, PRs, failing CI become a high-severity alert", async () => {
    const seen: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push(String(url));
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer gh-test");
      if (url.endsWith("/repos/A/b")) return Response.json({ default_branch: "main", pushed_at: daysAgo(1) });
      if (url.includes("/commits")) return Response.json([{ sha: "0123456789abcdef", commit: { message: "Fix\n\nbody", committer: { date: daysAgo(1) } }, author: { login: "chris" } }]);
      if (url.includes("/pulls")) return Response.json([{ number: 7, title: "Old PR", updated_at: daysAgo(10), draft: false }]);
      return Response.json({ workflow_runs: [{ name: "CI", status: "completed", conclusion: "failure", updated_at: daysAgo(1), html_url: "https://github.com/A/b/actions/runs/1" }] });
    }) as unknown as typeof fetch;
    const g = await repoState("A/b", "gh-test", fetcher);
    expect(g.commits[0]).toMatchObject({ sha: "0123456789ab", subject: "Fix" });
    expect(seen.every(u => u.startsWith("https://api.github.com/"))).toBe(true);
    P.createProject({ name: "B", repos: ["A/b"] }, "Chris");
    expect(await P.refreshGithub("gh-test", fetcher, NOW)).toBe(1);
    expect(await P.refreshGithub(undefined, fetcher, NOW)).toBe(0);
    const kinds = P.projectOverview(NOW)[0].attention.map(a => a.kind);
    expect(kinds[0]).toBe("ci-failing");
    expect(kinds).toContain("stale-prs");
  });
});

describe("project scan", () => {
  beforeEach(() => { reset(); setAutomationConfig({ openrouterKey: "or-test-key", exaKey: "exa", enabled: false }); });
  const luna = (out: unknown, calls: unknown[] = []) => (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: "stop" }], usage: { cost: 0.01, prompt_tokens: 100, completion_tokens: 50 } });
  }) as unknown as typeof fetch;
  const candidate = (title: string, lane: "team" | "agent" = "agent") => ({ title, detail: "d", doneWhen: "it is done", steps: ["one"], track: "quality", lane, why: "CI is red", evidence: ["CI failing on main"] });
  const fakeJudge = (async (t: { title: string }) => ({ dims: dimsAt(t.title.includes("Strong") ? 4 : 1), model: "jev-test", promptHash: "h", disagreement: Object.fromEntries(DIMS.map(d => [d, 0])), tokens: 1 })) as never;

  test("Luna proposes from full context; Jev judges; Orion ranks; a person adopts without a second judgment", async () => {
    P.createProject({ name: "Argus", brief: "Security agent" }, "Chris");
    addTask({ title: "Existing work", who: "Chris" });
    const calls: any[] = [];
    const id = await S.runScan({ who: "Chris", fetch: luna({ overview: "Argus needs CI fixed.", projects: [
      { projectId: "argus", assessment: "Red CI blocks releases.", candidates: [candidate("Strong: fix CI"), candidate("Weak idea", "team"), candidate("Existing work")] },
      { projectId: "invented", assessment: "x", candidates: [candidate("From nowhere")] },
    ] }, calls), judgeTask: fakeJudge, clock: () => NOW });
    expect(id).toBeTruthy();
    const user = JSON.parse(calls[0].messages[1].content);
    expect(user.projects[0]).toMatchObject({ projectId: "argus", brief: "Security agent" });
    expect(calls[0].response_format.json_schema.strict).toBe(true);
    const st = S.scanStatus(NOW);
    expect(st.runs[0]).toMatchObject({ status: "complete", overview: "Argus needs CI fixed." });
    // Unknown project and duplicate of a live task are dropped; the strong one ranks first.
    expect(st.proposals.map(c => c.title)).toEqual(["Strong: fix CI", "Weak idea"]);
    expect(st.proposals[0].rank).toBe(1);
    expect(st.proposals[0].pTop5).toBeGreaterThan(0);
    const taskId = S.adoptCandidate(st.proposals[0].id, "Chris");
    const t = getTask(taskId)!;
    expect(t).toMatchObject({ judge: "jev", project_id: "argus", lane: "agent" });
    expect(t.detail).toContain("CI is red");
    expect(db.query("SELECT COUNT(*) n FROM forecasts WHERE task_id = ?").get(taskId)).toEqual({ n: 1 });
    expect(() => S.adoptCandidate(st.proposals[0].id, "Chris")).toThrow();
    S.dismissCandidate(st.proposals[1].id, "Chris");
    expect(S.scanStatus(NOW).proposals).toHaveLength(0);
  });

  test("a failed Jev call keeps the proposal, unranked; the budget and the manual gap hold", async () => {
    P.createProject({ name: "Argus" }, "Chris");
    const failing = (async () => { throw new Error("TypeSafe down"); }) as never;
    await S.runScan({ who: "Chris", fetch: luna({ overview: "o", projects: [{ projectId: "argus", assessment: "a", candidates: [candidate("Something")] }] }), judgeTask: failing, clock: () => NOW });
    const c = S.scanStatus(NOW).proposals[0];
    expect(c).toMatchObject({ judged: false, rank: null, judgeError: "TypeSafe down" });
    await expect(S.runScan({ who: "Chris", fetch: luna({}), clock: () => NOW })).rejects.toThrow(/less than an hour/);
    S.updateScanSettings({ ...S.scanSettings(), dailyBudgetUsd: 0.03 }, "Chris");
    await expect(S.runScan({ fetch: luna({}), clock: () => new Date(NOW.getTime() + 2 * 3_600_000) })).rejects.toThrow(/allowance/);
  });

  test("bad model output is an error run, with keys redacted", async () => {
    P.createProject({ name: "Argus" }, "Chris");
    await S.runScan({ who: "Chris", fetch: luna({ overview: "missing projects" }), judgeTask: fakeJudge, clock: () => NOW });
    const run = S.scanStatus(NOW).runs[0];
    expect(run.status).toBe("error");
    expect(run.error).not.toContain("or-test-key");
  });

  test("the scheduled scan is due once a day after its hour", () => {
    P.createProject({ name: "Argus" }, "Chris");
    expect(S.scanDue(new Date("2026-11-18T03:00:00Z"))).toBe(false);
    expect(S.scanDue(new Date("2026-11-18T04:00:00Z"))).toBe(true);
  });
});

describe("daily email, per founder", () => {
  beforeEach(() => { reset(); E.setEmailConfig({ resendKey: "re_test_key_123456", from: "Compass <c@example.test>" }); });
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const resend = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.resend.com/emails");
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ id: "email_1" });
  }) as unknown as typeof fetch;

  test("each founder gets their own focus, plus shared alerts and proposals", () => {
    P.createProject({ name: "Argus", sites: ["https://down.example"] }, "Chris");
    db.query("INSERT INTO project_signals (project_id, source, key, payload, at) VALUES ('argus', 'site', 'https://down.example', ?, ?)").run(JSON.stringify({ url: "https://down.example", ok: false, status: 503, ms: 10, error: null }), NOW.toISOString());
    const a = addTask({ title: "Chris's task", owner: "Chris", who: "Chris", projectId: "argus" });
    const b = addTask({ title: "Alex's task", owner: "Alex", who: "Alex" });
    setStatus(a, "doing", "Chris"); setStatus(b, "doing", "Alex");
    const chris = E.buildDigest("Chris", NOW), alex = E.buildDigest("Alex", NOW);
    expect(chris.sections[0].items[0]).toContain("[Argus] Chris's task");
    expect(alex.sections[0].items[0]).toContain("Alex's task");
    expect(chris.text).not.toContain("Alex's task — You have");
    expect(chris.text).toContain("down.example is not answering");
    expect(chris.html).not.toContain("<script");
  });

  test("settings: recipients must be on the team", async () => {
    expect((await person("/api/digest", { method: "PUT", body: JSON.stringify({ enabled: true, sendHourUtc: 5, recipients: { Mallory: "m@example.test" } }) })).status).toBe(400);
    expect((await person("/api/digest", { method: "PUT", body: JSON.stringify({ enabled: true, sendHourUtc: 5, recipients: { Chris: "not-an-email" } }) })).status).toBe(400);
    expect((await call("/api/digest", { method: "PUT", token: TOKEN, body: JSON.stringify({ enabled: true, sendHourUtc: 5, recipients: {} }) })).status).toBe(403);
    expect((await person("/api/digest", { method: "PUT", body: JSON.stringify({ enabled: true, sendHourUtc: 5, recipients: { Chris: "c@example.test", Alex: "s@example.test" } }) })).status).toBe(200);
  });

  test("scheduled: once per person per day after the hour; failures retry at most 3 times", async () => {
    sent.length = 0;
    E.updateDigestSettings({ enabled: true, sendHourUtc: 8, recipients: { Chris: "c@example.test", Alex: "s@example.test" } }, "Chris", ["Chris", "Alex"]);
    expect((await E.sendDigests({ fetch: resend, clock: new Date("2026-11-18T07:59:00Z") })).sent).toEqual([]);
    expect((await E.sendDigests({ fetch: resend, clock: NOW })).sent).toEqual(["Chris", "Alex"]);
    expect((await E.sendDigests({ fetch: resend, clock: NOW })).sent).toEqual([]);
    expect(sent.map(s => s.to[0])).toEqual(["c@example.test", "s@example.test"]);
    const broken = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const tomorrow = new Date("2026-11-19T09:00:00Z");
    for (let i = 0; i < 4; i++) await E.sendDigests({ fetch: broken, clock: tomorrow });
    expect(E.digestSent().Chris).toMatchObject({ attempts: 3, sentAt: null });
    expect(E.digestSent().Chris.error).not.toContain("re_test_key");
  });

  test("Send now sends only to the person who pressed it", async () => {
    sent.length = 0;
    E.updateDigestSettings({ enabled: false, sendHourUtc: 23, recipients: { Chris: "c@example.test", Alex: "s@example.test" } }, "Chris", ["Chris", "Alex"]);
    expect((await E.sendDigests({ fetch: resend, clock: NOW, only: "Chris", force: true })).sent).toEqual(["Chris"]);
  });

  test("Send now can target a teammate, only at their saved address", async () => {
    E.setEmailConfig({ resendKey: "re_test_key_123456" });
    E.updateDigestSettings({ enabled: false, sendHourUtc: 0, recipients: { Chris: "c@example.test", Alex: "" } }, "Chris", ["Chris", "Alex"]);
    expect((await person("/api/digest/send", { method: "POST", body: JSON.stringify({ to: "Mallory" }) })).status).toBe(400);
    expect((await person("/api/digest/send", { method: "POST", body: JSON.stringify({ to: "Alex" }) })).status).toBe(409);
  });

  test("no key: nothing scheduled is sent, and Send now explains", async () => {
    E.setEmailConfig({ resendKey: undefined });
    E.updateDigestSettings({ enabled: true, sendHourUtc: 0, recipients: { Chris: "c@example.test" } }, "Chris", ["Chris"]);
    expect((await E.sendDigests({ fetch: resend, clock: NOW })).sent).toEqual([]);
    expect((await E.sendDigests({ fetch: resend, clock: NOW, only: "Chris", force: true })).failed).toEqual(["Chris"]);
    expect(E.digestSent().Chris.error).toContain("RESEND_API_KEY");
  });
});

describe("periodic tick", () => {
  beforeEach(reset);
  test("one failing step does not stop the others", async () => {
    E.setEmailConfig({ resendKey: "re_test_key_123456" });
    P.createProject({ name: "Site", sites: ["https://up.example"] }, "Chris");
    E.updateDigestSettings({ enabled: true, sendHourUtc: 0, recipients: { Chris: "c@example.test" } }, "Chris", ["Chris"]);
    const seen: string[] = [];
    const fetcher = (async (url: string) => { seen.push(String(url)); if (String(url).includes("up.example")) throw new Error("network down"); return Response.json({ id: "e" }); }) as unknown as typeof fetch;
    await periodic({ fetch: fetcher, clock: NOW });
    expect(seen).toContain("https://api.resend.com/emails");
    expect(P.projectOverview(NOW)[0].siteChecks[0]).toMatchObject({ ok: false, error: "network down" });
  });
});
