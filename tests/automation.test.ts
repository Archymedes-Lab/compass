process.env.COMPASS_DB = ":memory:";
import { beforeEach, describe, expect, test } from "bun:test";
import { openLocal } from "../src/local.ts";
import { db } from "../src/db.ts";
import { addTask, getTask, onJudgeQueued, setStatus } from "../src/state.ts";
import { createHandler } from "../src/api.ts";
import { adoptProposal, automationSettings, automationStatus, automationUsage, onAutomationChanged, PLAN_RESERVATION_USD, requestAutomationRun, saveSchedule, setAutomationConfig, updateAutomationSettings, type Plan } from "../src/automation-store.ts";
import { createProject, ingestReports } from "../src/projects.ts";
import { plannerContext, runAutomation, validatePlan } from "../src/automation.ts";
let time = new Date("2026-11-16T12:00:00Z"), task = "";
const clock = () => time;
const evidence = [{ title: "Public source", url: "https://example.org/research", publishedAt: "2026-11-15", text: "Independent evidence" }];
const plan = (): Plan => ({ summary: "Do the existing task first", nextRunMinutes: 120, nextRunReason: "Allow time for execution and a human response", nextResearchQuery: "public endpoint monitoring adoption research", recommendations: [{ taskId: task, reason: "Highest ranked available work", nextStep: "Inspect current evidence", requiresHuman: false, sourceUrls: [evidence[0].url] }], proposals: [{ title: "Verify the evidence", detail: "A bounded missing research task", doneWhen: "Evidence is independently checked", steps: ["Read the source"], sourceUrls: [evidence[0].url] }], humanNeeds: [] });
function mockFetch(value: unknown = plan(), hook?: (url: string) => void) {
  const calls: { url: string; body: any }[] = [];
  const fetcher = (async (input: any, init: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init.body)); calls.push({ url, body }); hook?.(url);
    if (url === "https://api.exa.ai/search") return Response.json({ results: evidence.map(e => ({ title: e.title, url: e.url, publishedDate: e.publishedAt, highlights: [e.text] })), costDollars: { total: 0.007 } });
    if (url === "https://openrouter.ai/api/v1/chat/completions") return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.001 } });
    throw Error("Unexpected network destination");
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
beforeEach(() => {
  openLocal(); onJudgeQueued(() => {}); onAutomationChanged(() => {});
  time = new Date("2026-11-16T12:00:00Z");
  setAutomationConfig({ enabled: true, openrouterKey: "fake-openrouter-secret", exaKey: "fake-exa-secret" });
  task = addTask({ title: "Existing work", who: "Chris", doneWhen: "Check passes" });
  saveSchedule(time.toISOString(), "Test run");
});

describe("adaptive research planner", () => {
  test("planner receives current project reports with attribution and excludes archived projects", async () => {
    const project = createProject({ name: "Reported project" }, "Chris");
    const report = { project, summary: "ChatGPT Work confirmed the user has completed the release review.", state: "User reported", risks: ["Deployment pending"], nextSteps: ["Deploy reviewed release"] };
    ingestReports({ reports: [report] }, "MCP for Chris (agent)");
    const { fetcher, calls } = mockFetch();
    await runAutomation({ fetch: fetcher, clock });
    expect(calls[1].body.messages[1].content).toContain(report.summary);
    expect(plannerContext().projectUpdates[0]).toMatchObject({ project, who: "MCP for Chris (agent)", summary: report.summary });
    db.query("UPDATE projects SET status = 'archived' WHERE id = ?").run(project);
    expect(plannerContext().projectUpdates).toEqual([]);
  });
  test("uses both providers, records evidence and billing, and lets the model choose the next interval", async () => {
    const { fetcher, calls } = mockFetch();
    const id = await runAutomation({ fetch: fetcher, clock });
    const s = automationStatus(time), r = s.runs[0];
    expect(id).toBe(r.id); expect(r.status).toBe("complete"); expect(r.evidence).toEqual(evidence);
    expect(r.reportedUsd).toBeCloseTo(0.008); expect(r.reservedUsd).toBe(PLAN_RESERVATION_USD);
    expect(s.schedule!.nextAt).toBe("2026-11-16T14:00:00.000Z");
    expect(calls.map(c => c.url)).toEqual(["https://api.exa.ai/search", "https://openrouter.ai/api/v1/chat/completions"]);
    expect(calls[1].body.model).toBe("openai/gpt-6-luna");
    expect(calls[1].body.provider.max_price).toEqual({ prompt: 0.2, completion: 1 });
    expect(calls[1].body.response_format.type).toBe("json_schema");
    expect(JSON.stringify(calls[1].body.response_format)).not.toContain('"format":"uri"');
    expect(JSON.stringify(calls[0].body)).not.toContain("Existing work");
    expect(JSON.stringify(calls.map(c => c.body))).not.toContain("fake-openrouter-secret");
    expect(getTask(task)!.status).toBe("open");
    expect(db.query("SELECT id FROM tasks").all()).toHaveLength(1);
    expect(await runAutomation({ fetch: fetcher, clock })).toBeNull(); expect(calls).toHaveLength(2);
  });
  test("respects human interval bounds and rejects invalid settings", async () => {
    updateAutomationSettings({ ...automationSettings(), minIntervalMinutes: 90, maxIntervalMinutes: 180 }, "Chris");
    await runAutomation({ fetch: mockFetch({ ...plan(), nextRunMinutes: 15 }).fetcher, clock });
    expect(automationStatus(time).schedule!.nextAt).toBe("2026-11-16T13:30:00.000Z");
    expect(() => updateAutomationSettings({ ...automationSettings(), minIntervalMinutes: 181 }, "Chris")).toThrow();
    expect(() => updateAutomationSettings({ ...automationSettings(), researchQuery: "api_key=private" }, "Chris")).toThrow();
  });
  test("attempt cap and reserved daily allowance apply even when reported cost is lower", async () => {
    updateAutomationSettings({ ...automationSettings(), maxRunsPerDay: 1 }, "Chris");
    await runAutomation({ fetch: mockFetch().fetcher, clock });
    time = new Date("2026-11-16T16:00:00Z"); saveSchedule(time.toISOString(), "Try again");
    const mock = mockFetch(); expect(await runAutomation({ fetch: mock.fetcher, clock })).toBeNull(); expect(mock.calls).toHaveLength(0);
    expect(automationStatus(time).schedule!.nextAt).toBe("2026-11-17T00:00:00.000Z");
    expect(() => requestAutomationRun("Chris", time)).toThrow("allowance");
    expect(automationUsage(time).reservedUsd).toBe(0.025);
  });
  test("manual runs cannot bypass pause, missing keys or the minimum interval", async () => {
    await runAutomation({ fetch: mockFetch().fetcher, clock });
    expect(() => requestAutomationRun("Chris", time)).toThrow("minimum");
    updateAutomationSettings({ ...automationSettings(), enabled: false }, "Chris");
    expect(await runAutomation({ fetch: mockFetch().fetcher, clock })).toBeNull();
    expect(() => requestAutomationRun("Chris", time)).toThrow("Resume");
    updateAutomationSettings({ ...automationSettings(), enabled: true }, "Chris");
    setAutomationConfig({ enabled: true });
    expect(() => requestAutomationRun("Chris", time)).toThrow("both");
  });
  test("a person can explicitly retry a failed run after a minute, within the same daily allowance", async () => {
    await runAutomation({ fetch: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch, clock });
    expect(() => requestAutomationRun("Chris", time, true)).toThrow("one minute");
    time = new Date("2026-11-16T12:02:00Z");
    requestAutomationRun("Chris", time, true);
    await runAutomation({ fetch: mockFetch().fetcher, clock });
    expect(automationStatus(time).runs[0].status).toBe("complete");
    expect(automationUsage(time).runs).toBe(2);
  });
  test("overlapping triggers share one run and one reservation", async () => {
    let release!: () => void;
    const base = mockFetch();
    const fetcher = (async (input: any, init: any) => { if (String(input).includes("exa.ai")) await new Promise<void>(r => { release = r; }); return base.fetcher(input, init); }) as unknown as typeof fetch;
    const first = runAutomation({ fetch: fetcher, clock }), second = runAutomation({ fetch: fetcher, clock });
    expect(first).toBe(second); release(); await first;
    expect(automationUsage(time).runs).toBe(1); expect(base.calls).toHaveLength(2);
  });
  test("provider failure retains the reservation and uses bounded backoff", async () => {
    const fetcher = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await runAutomation({ fetch: fetcher, clock });
    const s = automationStatus(time);
    expect(s.runs[0].status).toBe("error"); expect(s.runs[0].error).toContain("Exa returned HTTP 503");
    expect(s.usage.reservedUsd).toBe(0.025); expect(s.usage.reportedUsd).toBeNull();
    expect(s.schedule!.nextAt).toBe("2026-11-16T12:30:00.000Z");
  });
  test("unexpected search cost pauses planning before a model call", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return Response.json({ results: [], costDollars: { total: 0.1 } }); }) as unknown as typeof fetch;
    await runAutomation({ fetch: fetcher, clock });
    expect(calls).toBe(1); expect(automationSettings().enabled).toBe(false);
    expect(automationStatus(time).runs[0].error).toContain("allowance");
    expect(automationStatus(time).usage.reportedUsd).toBe(0.1);
    expect(automationStatus(time).usage.unreportedRuns).toBe(1);
    expect(automationUsage(time).allowanceUsedUsd).toBe(0.1);
  });
  test("pause during research prevents a subsequent model call", async () => {
    const m = mockFetch(plan(), url => { if (url.includes("exa.ai")) updateAutomationSettings({ ...automationSettings(), enabled: false }, "Chris"); });
    await runAutomation({ fetch: m.fetcher, clock });
    expect(m.calls).toHaveLength(1); expect(automationStatus(time).runs[0].status).toBe("error");
    expect(automationStatus(time).schedule).toBeNull();
  });
  test("human edits during a run supersede its recommendations", async () => {
    const m = mockFetch(plan(), url => { if (url.includes("openrouter.ai")) setStatus(task, "doing", "Chris"); });
    await runAutomation({ fetch: m.fetcher, clock });
    const r = automationStatus(time).runs[0]; expect(r.status).toBe("superseded");
    expect(() => adoptProposal(r.id, 0, "Chris", () => "bad")).toThrow("completed plan");
  });
  test("hallucinated source URLs, task IDs, extra commands and private search queries fail closed", async () => {
    expect(() => validatePlan({ ...plan(), recommendations: [{ ...plan().recommendations[0], taskId: "made-up" }] }, new Set([task]), evidence)).toThrow("unknown task");
    expect(() => validatePlan({ ...plan(), proposals: [{ ...plan().proposals[0], sourceUrls: ["https://invented.test"] }] }, new Set([task]), evidence)).toThrow("unknown source");
    expect(() => validatePlan({ ...plan(), execute: "shell" }, new Set([task]), evidence)).toThrow();
    expect(() => validatePlan({ ...plan(), nextResearchQuery: "secret api_key=private" }, new Set([task]), evidence)).toThrow("private");
    const guarded = validatePlan(plan(), new Set([task]), evidence, new Set([task]));
    expect(guarded.recommendations[0].requiresHuman).toBe(true);
  });
  test("adoption is explicit and idempotent, and new tasks stay in the agent lane", async () => {
    await runAutomation({ fetch: mockFetch().fetcher, clock });
    const id = automationStatus(time).runs[0].id;
    const create = (p: Plan["proposals"][number]) => addTask({ title: p.title, doneWhen: p.doneWhen, steps: p.steps, who: "Chris", lane: "agent" });
    const taskId = adoptProposal(id, 0, "Chris", create);
    expect(adoptProposal(id, 0, "Chris", create)).toBe(taskId);
    expect(db.query("SELECT id FROM tasks").all()).toHaveLength(2);
    expect(getTask(taskId)!.lane).toBe("agent");
  });
  test("a crashed lease is recovered without refunding or repeating a still-active run", async () => {
    db.query("INSERT INTO automation_runs (id, at, status, model, reserved_usd) VALUES ('old', ?, 'running', 'test', 0.025)").run("2026-11-16T11:55:00Z");
    const mock = mockFetch();
    expect(await runAutomation({ fetch: mock.fetcher, clock })).toBeNull(); expect(mock.calls).toHaveLength(0);
    time = new Date("2026-11-16T12:30:00Z"); saveSchedule(time.toISOString(), "Recover");
    await runAutomation({ fetch: mock.fetcher, clock });
    expect(db.query("SELECT status FROM automation_runs WHERE id = 'old'").get().status).toBe("interrupted");
    expect(automationUsage(time).runs).toBe(2);
  });
  test("agents can read plans but cannot change settings, trigger runs or adopt proposals", async () => {
    const token = "test-codex-automation-token-0123456789";
    const handle = createHandler({ users: "Chris:pw", sessionKey: "test-automation-session-key", agents: `Codex:${token}` });
    const call = (p: string, method = "GET") => handle(new Request("https://compass.test" + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) }));
    expect((await call("/api/automation")).status).toBe(200);
    expect((await call("/api/automation", "PUT")).status).toBe(403);
    expect((await call("/api/automation/run", "POST")).status).toBe(403);
    expect((await call("/api/automation/run-id/proposals/0/accept", "POST")).status).toBe(403);
    expect(JSON.stringify(automationStatus(time))).not.toContain("fake-openrouter-secret");
  });
});
