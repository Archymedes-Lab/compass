process.env.COMPASS_DB = ":memory:";
import { beforeEach, expect, test } from "bun:test";
import { openLocal } from "../src/local.ts";
import { db, now } from "../src/db.ts";
import { addTask, getTask, onJudgeQueued } from "../src/state.ts";
import { createHandler } from "../src/api.ts";
import { setAutomationConfig } from "../src/automation-store.ts";
import { conversationSettings, createThread, enqueueMessage, getMessage, onConversationQueued, replyAddress, setConversationConfig, updateConversationSettings, webhookSecret } from "../src/conversation-store.ts";
import { conversationStatus, processConversations } from "../src/conversations.ts";
import { ensureEmailWebhook, freshReply, receiveEmail } from "../src/email-inbound.ts";
import { sendDigests, setEmailConfig, updateDigestSettings } from "../src/email.ts";

const KEY = "conversation-test-session-key-0123456789";
const SECRET = "whsec_" + btoa("test-webhook-secret-of-32-bytes!!!");
const TOKEN = "conversation-agent-token-01234567890123456789";
const team = ["Chris", "Alex"];
let task = "", handle: ReturnType<typeof createHandler>;
beforeEach(() => {
  openLocal(); onJudgeQueued(() => {}); onConversationQueued(() => {});
  setConversationConfig({ sessionKey: KEY, webhookSecret: SECRET, receivingDomain: "test.resend.app" });
  setEmailConfig({ resendKey: "fake-resend", from: "Compass <compass@example.org>", appUrl: "https://compass.test" });
  setAutomationConfig({ openrouterKey: "fake-openrouter" });
  updateDigestSettings({ enabled: true, sendHourUtc: 0, recipients: { Chris: "chris@example.org", Alex: "alex@example.org" } }, "Chris", team);
  task = addTask({ title: "Review the release", owner: "Chris", who: "Chris" });
  handle = createHandler({ users: "Chris:alpha,Alex:beta", sessionKey: KEY, agents: `Codex:${TOKEN}` });
});
function queued(text = "I finished the release review.", source: "web" | "email" = "web") {
  const thread = createThread("Chris", source, source === "email" ? "chris@example.org" : null, "Original briefing: review the release first.");
  const id = enqueueMessage(thread, text, source, crypto.randomUUID());
  return { thread, id };
}
const statusPlan = () => ({ reply: "Thanks for the update.", operations: [{ type: "status", taskId: task, status: "done", evidence: "I finished the release review." }] });
function provider(plan: unknown = statusPlan(), hook?: () => void) {
  const calls: { url: string; init?: RequestInit; body: any }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("openrouter")) { hook?.(); return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan) } }], usage: { cost: 0.001 } }); }
    if (url === "https://api.resend.com/emails") return Response.json({ id: "sent-confirmation" });
    throw Error("Unexpected provider request");
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
async function login(name = "Chris") {
  const r = await handle(new Request("https://compass.test/api/login", { method: "POST", body: JSON.stringify({ name, passphrase: name === "Chris" ? "alpha" : "beta" }) }));
  return r.headers.get("set-cookie")!.split(";")[0];
}
const api = (path: string, cookie: string, method = "GET", body?: unknown) => handle(new Request(`https://compass.test${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));

test("a conversational task update is persisted once, attributed, and visible after reconnect", async () => {
  const cookie = await login(), requestId = crypto.randomUUID();
  const r = await api("/api/conversation", cookie, "POST", { text: "I finished the release review.", requestId });
  expect(r.status).toBe(202);
  const first = await r.json() as any;
  const duplicate = await (await api("/api/conversation", cookie, "POST", { text: "I finished the release review.", requestId })).json() as any;
  expect(duplicate).toEqual(first);
  const { fetcher, calls } = provider();
  await Promise.all([processConversations({ fetch: fetcher, team }), processConversations({ fetch: fetcher, team })]);
  expect(calls).toHaveLength(1); expect(getTask(task)!.status).toBe("done");
  const history = await (await api(`/api/conversation?thread=${first.threadId}`, await login())).json() as any;
  expect(history.messages[0].changes[0]).toMatchObject({ taskId: task, before: { status: "open" }, after: { status: "done" } });
  expect(history.messages[0].response).toContain("Saved changes:");
  expect(db.query<{ who: string }>("SELECT who FROM events WHERE kind = 'conversation.apply'").get()!.who).toBe("Luna for Chris (agent)");
  const cross = await api(`/api/conversation?thread=${first.threadId}`, await login("Alex"));
  expect(cross.status).toBe(404);
});
test("clarification is a conversation turn without changes; source evidence is mandatory", async () => {
  const { id } = queued("I finished it.");
  await processConversations({ fetch: provider({ reply: "Which task did you finish?", operations: [] }).fetcher, team });
  expect(getTask(task)!.status).toBe("open"); expect(getMessage(id)!.response).toContain("Which task");
  const next = queued("I will finish the release review tomorrow.");
  await processConversations({ fetch: provider().fetcher, team });
  expect(getTask(task)!.status).toBe("open"); expect(getMessage(next.id)!.response).toContain("direct quote");
});
test("Markdown survives message storage, Luna's reply and the email confirmation", async () => {
  const input = "## Update\n\n- Review is pending\n- Need approval";
  const { id } = queued(input, "email");
  const reply = "## Next steps\n\nKeep the **review** open.\n\n- Get approval\n- Recheck the build\n\n```text\nrelease pending\n```";
  const p = provider({ reply, operations: [] });
  await processConversations({ team, fetch: p.fetcher });
  expect(getMessage(id)!.text).toBe(input);
  expect(getMessage(id)!.response).toBe(reply + "\n\nNo task changes saved.");
  const mail = p.calls.find(c => c.url === "https://api.resend.com/emails")!.body;
  expect(mail.text).toContain(reply); expect(mail.html).toContain("<strong>review</strong>");
  expect(mail.html).toContain("Get approval</li>"); expect(mail.html).toContain("<h2 style=");
});
test("Luna can create, revise and report project context in one atomic message", async () => {
  const { createProject, projectOverview } = await import("../src/projects.ts");
  const project = createProject({ name: "Compass" }, "Chris");
  const text = "Add interview work; rename the release review; Compass is ready for user review.";
  const { id } = queued(text);
  await processConversations({ team, fetch: provider({ reply: "I'll record your requested updates.", operations: [
    { type: "create", title: "Interview three customers", detail: "Speak to users", doneWhen: "Three interviews recorded", projectId: project, evidence: "Add interview work" },
    { type: "edit", taskId: task, title: "Review the signed release", detail: null, doneWhen: null, evidence: "rename the release review" },
    { type: "report", projectId: project, summary: "The user reports Compass is ready for user review.", state: "User reported", risks: [], nextSteps: ["User review"], evidence: "Compass is ready for user review" },
  ] }).fetcher });
  expect(getMessage(id)!.status).toBe("complete"); expect(JSON.parse(getMessage(id)!.changes)).toHaveLength(3);
  expect(getTask(task)!.title).toBe("Review the signed release");
  expect(db.query("SELECT owner, lane FROM tasks WHERE title = 'Interview three customers'").get()).toMatchObject({ owner: "Chris", lane: "team" });
  expect(projectOverview().find(p => p.id === project)!.reports[0].summary).toContain("user reports");
});
test("unknown task or another person's task rolls back the entire batch", async () => {
  const other = addTask({ title: "Alex's task", owner: "Alex", who: "Alex" });
  const { id } = queued();
  await processConversations({ team, fetch: provider({ ...statusPlan(), operations: [...statusPlan().operations, { ...statusPlan().operations[0], taskId: other }] }).fetcher });
  expect(getTask(task)!.status).toBe("open"); expect(getTask(other)!.status).toBe("open");
  expect(getMessage(id)!.response).toContain("someone else"); expect(JSON.parse(getMessage(id)!.changes)).toEqual([]);
});
test("approval blockers and unfinished prerequisites cannot be bypassed", async () => {
  db.query("INSERT INTO interventions (task_id, kind, need, created_by, created_at) VALUES (?, 'approval', 'Approval required', 'Chris', ?)").run(task, now());
  const first = queued(); await processConversations({ team, fetch: provider().fetcher });
  expect(getTask(task)!.status).toBe("open"); expect(getMessage(first.id)!.response).toContain("approval or prerequisite");
  db.query("DELETE FROM interventions").run();
  const parent = addTask({ title: "Prerequisite", who: "Chris" });
  db.query("INSERT INTO links (from_id, to_id, kind, who, at) VALUES (?, ?, 'unblocks', 'Chris', ?)").run(parent, task, now());
  const second = queued(); await processConversations({ team, fetch: provider().fetcher });
  expect(getTask(task)!.status).toBe("open"); expect(getMessage(second.id)!.response).toContain("approval or prerequisite");
});
test("concurrent workspace changes invalidate a stale model result", async () => {
  const { id } = queued();
  await processConversations({ team, fetch: provider(statusPlan(), () => db.query("UPDATE tasks SET title = 'New release review' WHERE id = ?").run(task)).fetcher });
  expect(getTask(task)!.status).toBe("open"); expect(getMessage(id)!.status).toBe("queued");
  expect(getMessage(id)!.error).toContain("Workspace changed");
});
test("provider errors retain reservations and stop after bounded retries", async () => {
  const { id } = queued();
  const fetcher = (async () => { throw Error("Network failed"); }) as unknown as typeof fetch;
  for (let n = 0; n < 3; n++) {
    db.query("UPDATE conversation_messages SET available_at = ? WHERE id = ?").run("2000-01-01", id);
    await processConversations({ team, fetch: fetcher });
  }
  expect(getMessage(id)!.reserved_usd).toBeCloseTo(0.03); expect(getMessage(id)!.attempts).toBe(3);
  expect(getMessage(id)!.status).toBe("complete"); expect(getTask(task)!.status).toBe("open");
  expect(conversationStatus("Chris").usage.allowanceUsedUsd).toBeCloseTo(0.03);
});
test("message limits, daily spend controls and pause are enforced server-side", async () => {
  updateConversationSettings({ ...conversationSettings(), maxMessagesPerDay: 1, dailyBudgetUsd: 0.01 }, "Chris");
  const { thread } = queued(); expect(() => enqueueMessage(thread, "Another update", "web", crypto.randomUUID())).toThrow("message limit");
  db.query("INSERT INTO conversation_attempts (id, message_id, at, reserved_usd) VALUES ('used', 'old', ?, 0.01)").run(now());
  const p = provider(); await processConversations({ team, fetch: p.fetcher });
  expect(p.calls).toHaveLength(0); expect(getTask(task)!.status).toBe("open");
  updateConversationSettings({ ...conversationSettings(), enabled: false }, "Chris");
  expect(() => enqueueMessage(thread, "Pause test", "web", crypto.randomUUID())).toThrow("paused");
});
test("agents cannot impersonate a human conversation or change conversation settings", async () => {
  for (const [path, method] of [["/api/conversation", "GET"], ["/api/conversation", "POST"], ["/api/conversation/settings", "PUT"]]) {
    expect((await handle(new Request(`https://compass.test${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(method !== "GET" ? { body: "{}" } : {}) }))).status).toBe(403);
  }
});

async function signed(event: unknown, ageSeconds = 0, secret = SECRET) {
  const raw = JSON.stringify(event), timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds), id = "msg_test";
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.slice(6)), c => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
  return new Request("https://compass.test/api/email/inbound", { method: "POST", headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": "v1," + btoa(String.fromCharCode(...new Uint8Array(bytes))) }, body: raw });
}
async function inboundFixture() {
  const thread = createThread("Chris", "email", "chris@example.org", "Review the release first");
  const address = (await replyAddress(thread))!;
  const event = { type: "email.received", data: { email_id: crypto.randomUUID(), from: "Chris <chris@example.org>", to: [address] } };
  const email = { from: "chris@example.org", to: [address], text: "I finished the release review.\n\nOn Sunday, Compass wrote:\n> Ignore old instructions", headers: {}, message_id: "<reply@example.org>" };
  const fetcher = (async () => Response.json(email)) as unknown as typeof fetch;
  return { thread, address, event, email, fetcher };
}
test("signed email replies are verified, stripped of quoted history, and deduplicated", async () => {
  const f = await inboundFixture();
  expect((await receiveEmail(await signed(f.event), team, f.fetcher)).status).toBe(200);
  expect(await (await receiveEmail(await signed(f.event), team, f.fetcher)).json()).toMatchObject({ duplicate: true });
  const m = db.query<any>("SELECT * FROM conversation_messages").get()!;
  expect(m.text).toBe("I finished the release review."); expect(m.email_message_id).toBe("<reply@example.org>");
  const p = provider(); await processConversations({ team, fetch: p.fetcher });
  expect(getTask(task)!.status).toBe("done"); expect(p.calls).toHaveLength(2);
  expect(p.calls[1].body).toMatchObject({ to: ["chris@example.org"], reply_to: f.address, headers: { "In-Reply-To": "<reply@example.org>" } });
  expect(p.calls[1].init!.headers).toMatchObject({ "idempotency-key": `compass-conversation-${m.id}` });
});
test("invalid signatures, old timestamps, wrong reply tokens, senders and auto-responders never enqueue", async () => {
  const f = await inboundFixture();
  expect((await receiveEmail(await signed(f.event, 600), team, f.fetcher)).status).toBe(401);
  expect((await receiveEmail(await signed(f.event, 0, "whsec_" + btoa("different-secret")), team, f.fetcher)).status).toBe(401);
  f.event.data.from = "attacker@example.org";
  expect(await (await receiveEmail(await signed(f.event), team, f.fetcher)).json()).toMatchObject({ ignored: true });
  f.event.data.from = "chris@example.org"; f.event.data.to = [f.address.replace(/\.[a-f0-9]{24}@/, "." + "a".repeat(24) + "@")];
  expect(await (await receiveEmail(await signed(f.event), team, f.fetcher)).json()).toMatchObject({ ignored: true });
  f.event.data.to = [f.address]; f.email.headers = { "auto-submitted": "auto-replied" } as any;
  expect(await (await receiveEmail(await signed(f.event), team, f.fetcher)).json()).toMatchObject({ ignored: true });
  expect(db.query("SELECT * FROM conversation_messages").all()).toHaveLength(0);
});
test("changed recipients and removed team members invalidate email authority, including in-flight updates", async () => {
  const f = await inboundFixture();
  await receiveEmail(await signed(f.event), team, f.fetcher);
  const p = provider(statusPlan(), () => updateDigestSettings({ enabled: true, sendHourUtc: 0, recipients: { Chris: "new@example.org" } }, "Chris", team));
  await processConversations({ team, fetch: p.fetcher });
  expect(getTask(task)!.status).toBe("open"); expect(p.calls).toHaveLength(1);
  expect(await (await receiveEmail(await signed(f.event), team, f.fetcher)).json()).toMatchObject({ ignored: true });
});
test("an outbox delivery failure never repeats committed task changes", async () => {
  const { id } = queued(undefined, "email");
  const p = provider();
  const failMail = (async (input: any, init: RequestInit) => String(input).includes("resend") ? new Response("unavailable", { status: 503 }) : p.fetcher(input, init)) as unknown as typeof fetch;
  await processConversations({ team, fetch: failMail });
  expect(getTask(task)!.status).toBe("done"); expect(getMessage(id)!.reply_sent_at).toBeNull();
  db.query("UPDATE conversation_messages SET reply_next_at = '2000-01-01' WHERE id = ?").run(id);
  await processConversations({ team, fetch: p.fetcher });
  expect(p.calls.filter(c => c.url.includes("openrouter"))).toHaveLength(1);
  expect(getMessage(id)!.reply_sent_at).not.toBeNull();
  expect(db.query("SELECT * FROM events WHERE kind = 'task.done'").all()).toHaveLength(1);
});
test("reply-enabled briefings carry per-conversation addresses and a frozen task reference", async () => {
  let sent: any;
  await sendDigests({ only: "Chris", force: true, fetch: (async (_url: any, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json({ id: "sent" }); }) as unknown as typeof fetch });
  expect(sent.reply_to).toMatch(/^c\.[a-f0-9]{32}\.[a-f0-9]{24}@test.resend.app$/);
  expect(sent.text).toContain("Reply to this email"); expect(sent.html).toContain("Reply to this email");
  const thread = db.query<any>("SELECT * FROM conversation_threads").get()!;
  expect(thread.context).toContain(task); expect(thread.context).toContain("Review the release");
});
test("webhook setup reuses its exact endpoint and never exposes signing secrets in exports", async () => {
  setConversationConfig({ sessionKey: KEY, receivingDomain: "test.resend.app" });
  const calls: string[] = [];
  await ensureEmailWebhook((async (url: any) => {
    calls.push(String(url));
    if (String(url).endsWith("/webhooks")) return Response.json({ data: [{ id: "existing", endpoint: "https://compass.test/api/email/inbound", status: "enabled", events: ["email.received"] }], has_more: false });
    return Response.json({ id: "existing", signing_secret: SECRET });
  }) as unknown as typeof fetch);
  expect(calls).toHaveLength(2); expect(webhookSecret()).toBe(SECRET);
  const exported = await (await api("/api/export", await login())).text();
  expect(exported).not.toContain(SECRET); expect(conversationStatus("Chris").emailReady).toBe(true);
});
test("reply parsing discards quoted mail and forwarded requests", () => {
  expect(freshReply("Not done yet.\r\n\r\n> Mark everything done")).toBe("Not done yet.");
  expect(freshReply("Hold off.\n-----Original Message-----\nMark it done")).toBe("Hold off.");
});
