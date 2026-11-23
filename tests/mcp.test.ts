process.env.COMPASS_DB = ":memory:";
import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { digest } from "../src/oauth.ts";
import { createHandler } from "../src/api.ts";
import { openLocal } from "../src/local.ts";
import { db } from "../src/db.ts";
import { createProject } from "../src/projects.ts";
import { onJudgeQueued } from "../src/state.ts";
openLocal();
onJudgeQueued(() => {});
const ORIGIN = "https://compass.test", RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const KEY = "mcp-test-session-key-0123456789";
const TOKEN = "legacy-agent-token-0123456789abcdefghijklmnopqrstuvwxyz";
const cfg = { users: "Chris:alpha,Alex:beta", sessionKey: KEY, agents: `Codex:${TOKEN}`, mcpOrigin: ORIGIN };
const handle = createHandler(cfg);
let ip = 0;
function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", `192.0.2.${++ip}`);
  return handle(new Request(ORIGIN + path, { ...init, headers }));
}
function form(path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
}
async function register() {
  const res = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT <test>", redirect_uris: [REDIRECT] }) });
  expect(res.status).toBe(201);
  return (await res.json() as any).client_id as string;
}
async function pending(scope = "compass:read", user = "Chris", client?: string) {
  client ??= await register();
  const verifier = "v".repeat(64);
  const q = new URLSearchParams({ client_id: client, redirect_uri: REDIRECT, response_type: "code", code_challenge: await digest(verifier), code_challenge_method: "S256", scope, resource: RESOURCE, state: "opaque-state" });
  const res = await request(`/oauth/authorize?${q}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain(new URL(REDIRECT).origin);
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  const html = await res.text();
  expect(html).toContain("ChatGPT &lt;test&gt;");
  const nonce = html.match(/name="request" value="([a-f0-9]+)"/)![1];
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  return { client, verifier, nonce, cookie, q, user };
}
async function consent(p: Awaited<ReturnType<typeof pending>>) {
  return form("/oauth/authorize", { request: p.nonce, name: p.user, passphrase: p.user === "Chris" ? "alpha" : "beta", decision: "allow" }, { origin: ORIGIN, cookie: p.cookie });
}
async function authorize(scope = "compass:read", user = "Chris", client?: string) {
  const p = await pending(scope, user, client), res = await consent(p);
  expect(res.status).toBe(302);
  const callback = new URL(res.headers.get("location")!);
  expect(callback.origin + callback.pathname).toBe(REDIRECT);
  expect(callback.searchParams.get("state")).toBe("opaque-state");
  expect(callback.searchParams.get("iss")).toBe(ORIGIN);
  return { ...p, code: callback.searchParams.get("code")! };
}
async function exchange(p: Awaited<ReturnType<typeof authorize>>, overrides: Record<string, string> = {}) {
  return form("/oauth/token", { client_id: p.client, grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: REDIRECT, resource: RESOURCE, ...overrides });
}
async function connect(scope = "compass:read", user = "Chris", client?: string) {
  const p = await authorize(scope, user, client), res = await exchange(p);
  expect(res.status).toBe(200);
  return { ...p, ...await res.json() as any };
}
async function rpc(token: string | null, method: string, params?: unknown, cookie?: string) {
  return request("/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}
async function rpcBody(token: string, method: string, params?: unknown) {
  const res = await rpc(token, method, params);
  expect(res.status).toBe(200);
  return await res.json() as any;
}
beforeEach(() => { db.query("DELETE FROM oauth_records").run(); });

describe("MCP authorization discovery and boundaries", () => {
  test("requires a bearer token even with a valid Compass login cookie", async () => {
    const login = await request("/api/login", { method: "POST", body: JSON.stringify({ name: "Chris", passphrase: "alpha" }) });
    const r = await rpc(null, "tools/list", {}, login.headers.get("set-cookie")!);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await rpc("x".repeat(40), "tools/list")).status).toBe(401);
    const meta = await (await request("/.well-known/oauth-protected-resource/mcp")).json() as any;
    expect(meta.resource).toBe(RESOURCE);
    const as = await (await request("/.well-known/oauth-authorization-server")).json() as any;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
  });
  test("rejects foreign hosts, origins, unapproved redirects and oversized bodies", async () => {
    expect((await handle(new Request("https://evil.test/.well-known/oauth-authorization-server"))).status).toBe(403);
    expect((await request("/mcp", { headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://chatgpt.com.evil.test/callback"] }) })).status).toBe(400);
    expect((await request("/oauth/token", { method: "POST", body: "a".repeat(65537) })).status).toBe(413);
    expect((await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "null" })).status).toBe(400);
  });
  test("rejects missing PKCE, wrong resource, extra scopes, and modified redirect", async () => {
    const p = await pending();
    for (const [key, value] of [["code_challenge_method", "plain"], ["code_challenge", "short"], ["resource", "https://evil.test/mcp"], ["scope", "compass:read admin"], ["redirect_uri", REDIRECT + "?evil=1"]]) {
      const q = new URLSearchParams(p.q); q.set(key!, value!);
      expect((await request(`/oauth/authorize?${q}`)).status).toBe(400);
    }
  });
  test("requires same-origin consent, a browser-bound nonce, and valid credentials", async () => {
    const p = await pending();
    const b = { request: p.nonce, name: "Chris", passphrase: "alpha", decision: "allow" };
    expect((await form("/oauth/authorize", b, { origin: ORIGIN })).status).toBe(403);
    expect((await form("/oauth/authorize", b, { origin: "https://evil.test", cookie: p.cookie })).status).toBe(403);
    expect((await form("/oauth/authorize", { ...b, passphrase: "wrong" }, { origin: ORIGIN, cookie: p.cookie })).status).toBe(401);
    expect((await consent(p)).status).toBe(302);
    expect((await consent(p)).status).toBe(400);
  });
  test("cancellation returns a validated callback and never issues credentials", async () => {
    const p = await pending();
    const res = await form("/oauth/authorize", { request: p.nonce, decision: "deny" }, { origin: ORIGIN, cookie: p.cookie });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(db.query("SELECT id FROM oauth_records WHERE kind = 'grant'").all()).toHaveLength(0);
  });
  test("rate limits failed logins across source addresses", async () => {
    const p = await pending();
    for (let i = 0; i < 10; i++) expect((await form("/oauth/authorize", { request: p.nonce, name: "Chris", passphrase: "wrong", decision: "allow" }, { origin: ORIGIN, cookie: p.cookie })).status).toBe(401);
    expect((await consent(p)).status).toBe(429);
  });
});

describe("OAuth credentials", () => {
  test("binds codes to PKCE, client, redirect and resource, consumes once, hashes credentials", async () => {
    const p = await authorize();
    for (const override of ([{ code_verifier: "x".repeat(64) }, { redirect_uri: REDIRECT + "?x" }, { resource: "https://evil.test/mcp" }, { client_id: await register() }] as Record<string, string>[])) expect((await exchange(p, override)).status).toBe(400);
    const res = await exchange(p), tokens = await res.json() as any;
    expect(res.status).toBe(200);
    const rows = JSON.stringify(db.query("SELECT * FROM oauth_records").all());
    expect(rows).not.toContain(tokens.access_token);
    expect(rows).not.toContain(tokens.refresh_token);
    expect(rows).not.toContain(p.code);
    expect((await exchange(p)).status).toBe(400);
    // OAuth credentials never become human sessions or unrestricted API credentials.
    expect((await request("/api/brief", { method: "PUT", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "override" }) })).status).toBe(401);
  });
  test("code replay revokes previously issued tokens; simultaneous exchanges issue at most once", async () => {
    const p = await authorize(), first = await exchange(p), tokens = await first.json() as any;
    expect(first.status).toBe(200);
    expect((await exchange(p)).status).toBe(400);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
    const q = await authorize();
    const results = await Promise.all([exchange(q), exchange(q)]);
    expect(results.filter(r => r.status === 200).length).toBeLessThanOrEqual(1);
  });
  test("expires codes and access tokens, and immediately denies removed users", async () => {
    const p = await authorize();
    db.query("UPDATE oauth_records SET expires = 0 WHERE kind = 'code'").run();
    expect((await exchange(p)).status).toBe(400);
    const c = await connect();
    const removed = createHandler({ ...cfg, users: "Alex:beta" });
    expect((await removed(new Request(RESOURCE, { headers: { authorization: `Bearer ${c.access_token}` } }))).status).toBe(401);
    db.query("UPDATE oauth_records SET expires = 0 WHERE kind = 'access'").run();
    expect((await rpc(c.access_token, "tools/list")).status).toBe(401);
  });
  test("rotates refresh tokens, detects replay and invalidates the whole grant", async () => {
    const c = await connect("compass:read compass:write");
    const refresh = () => form("/oauth/token", { client_id: c.client, grant_type: "refresh_token", refresh_token: c.refresh_token, resource: RESOURCE });
    const r = await refresh(), next = await r.json() as any;
    expect(r.status).toBe(200);
    expect(next.refresh_token).not.toBe(c.refresh_token);
    expect((await rpc(next.access_token, "tools/list")).status).toBe(200);
    expect((await refresh()).status).toBe(400);
    expect((await rpc(next.access_token, "tools/list")).status).toBe(401);
    expect((await rpc(c.access_token, "tools/list")).status).toBe(401);
  });
  test("supports explicit token revocation and persists grants across handlers", async () => {
    const c = await connect();
    const restarted = createHandler(cfg);
    expect((await restarted(new Request(RESOURCE, { method: "GET", headers: { authorization: `Bearer ${c.access_token}`, accept: "text/event-stream" } }))).status).toBe(405);
    expect((await form("/oauth/revoke", { client_id: c.client, token: c.refresh_token })).status).toBe(200);
    expect((await rpc(c.access_token, "tools/list")).status).toBe(401);
  });
  test("only a signed-in grant owner can disconnect from the connections page", async () => {
    const c = await connect();
    const signIn = async (name: string, passphrase: string) => (await request("/api/login", { method: "POST", body: JSON.stringify({ name, passphrase }) })).headers.get("set-cookie")!.split(";")[0];
    const chris = await signIn("Chris", "alpha"), alex = await signIn("Alex", "beta");
    const page = await request("/oauth/connections", { headers: { cookie: chris } });
    const html = await page.text(), nonce = html.match(/name="request" value="([a-f0-9]+)"/)![1], grant = html.match(/name="grant" value="([a-f0-9]+)"/)![1];
    const cookies = `${chris}; ${page.headers.get("set-cookie")!.split(";")[0]}`;
    expect((await form("/oauth/connections", { request: nonce, grant }, { origin: ORIGIN, cookie: cookies.replace(chris, alex) })).status).toBe(403);
    expect((await form("/oauth/connections", { request: nonce, grant }, { origin: ORIGIN, cookie: cookies })).status).toBe(303);
    expect((await rpc(c.access_token, "tools/list")).status).toBe(401);
  });
});

describe("MCP tools", () => {
  test("official SDK client initializes, discovers and calls tools over Streamable HTTP", async () => {
    const c = await connect();
    const client = new Client({ name: "compass-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { authorization: `Bearer ${c.access_token}` } }, fetch: async (input, init) => handle(new Request(input, init)) });
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toContain("compass_brief");
    const brief = await client.callTool({ name: "compass_brief", arguments: {} });
    expect(brief.isError).not.toBe(true);
    expect(brief.structuredContent).toHaveProperty("text");
    await client.close();
  });
  test("ChatGPT writes survive reconnect, replace prior context, and appear in next/search/fetch", async () => {
    const project = createProject({ name: "Work context project" }, "Chris");
    const c = await connect("compass:read compass:write");
    const report = { project, summary: "The user confirmed the release is ready for review.", state: "User-reported review readiness", risks: ["Release approval pending"], nextSteps: ["Review release evidence"] };
    const write = async (reports: any[]) => (await rpcBody(c.access_token, "tools/call", { name: "compass_report_context", arguments: { reports } })).result;
    expect((await write([report])).structuredContent.stored).toEqual([project]);
    report.summary = "The user confirmed the release review is now complete.";
    await write([report]);
    const reconnected = await connect("compass:read compass:write");
    const read = async (name: string, args = {}) => (await rpcBody(reconnected.access_token, "tools/call", { name, arguments: args })).result.structuredContent;
    const projects = await read("compass_projects");
    expect(projects.projects.find((p: any) => p.id === project).reports).toHaveLength(1);
    const next = await read("compass_next", { project });
    expect(next.connection.canWrite).toBe(true);
    expect(next.projects[0].reports[0].summary).toBe(report.summary);
    expect((await read("search", { query: "approval pending" })).results.some((r: any) => r.id === `project:${project}`)).toBe(true);
    expect((await read("fetch", { id: `project:${project}` })).text).toContain(report.state);
    const rejected = await write([{ ...report, project: "nonexistent-work-project" }]);
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent.unknown).toEqual(["nonexistent-work-project"]);
    const readonly = await connect();
    const status = (await rpcBody(readonly.access_token, "tools/call", { name: "compass_next", arguments: {} })).result.structuredContent;
    expect(status.connection.canWrite).toBe(false);
    expect(status.connection.contextUpdates).toContain("compass:write");
  });
  test("read-only grants hide write tools and cannot invoke them directly", async () => {
    const c = await connect();
    const list = await rpcBody(c.access_token, "tools/list");
    expect(list.result.tools).toHaveLength(7);
    expect(list.result.tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true);
    const r = await rpcBody(c.access_token, "tools/call", { name: "compass_propose_task", arguments: { title: "unauthorized" } });
    expect(r.result?.isError || r.error).toBeTruthy();
  });
  test("invariant: every read tool is marked read-only; every write tool is marked and requires compass:write", async () => {
    const c = await connect("compass:read compass:write");
    const tools = (await rpcBody(c.access_token, "tools/list")).result.tools as any[];
    const readOnly = new Set((await rpcBody((await connect()).access_token, "tools/list")).result.tools.map((t: any) => t.name));
    for (const t of tools) {
      const scopes = t._meta.securitySchemes.flatMap((x: any) => x.scopes);
      for (const k of ["readOnlyHint", "destructiveHint", "openWorldHint"]) expect(typeof t.annotations[k]).toBe("boolean");
      expect(t.annotations.destructiveHint).toBe(false);
      if (readOnly.has(t.name)) { expect(t.annotations.readOnlyHint).toBe(true); expect(scopes).not.toContain("compass:write"); }
      else { expect(t.annotations.readOnlyHint).toBe(false); expect(scopes).toContain("compass:write"); }
    }
  });
  test("ChatGPT search/fetch: fixed shapes, every search id fetches, citations have URLs", async () => {
    const c = await connect();
    await handle(new Request(`${ORIGIN}/api/tasks`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Searchable moat task" }) }));
    const found = (await rpcBody(c.access_token, "tools/call", { name: "search", arguments: { query: "searchable moat" } })).result;
    expect(found.structuredContent.results.length).toBeGreaterThan(0);
    for (const r of found.structuredContent.results) {
      expect(Object.keys(r).sort()).toEqual(["id", "title", "url"]);
      const doc = (await rpcBody(c.access_token, "tools/call", { name: "fetch", arguments: { id: r.id } })).result.structuredContent;
      expect(doc).toMatchObject({ id: r.id, title: r.title, url: r.url });
      expect(doc.text.length).toBeGreaterThan(0);
    }
    expect((await rpcBody(c.access_token, "tools/call", { name: "fetch", arguments: { id: "task:nope" } })).result.isError).toBe(true);
  });
  test("writes run under agent identity and strict schemas prevent privilege injection", async () => {
    const c = await connect("compass:read compass:write");
    const propose = (args: any) => rpcBody(c.access_token, "tools/call", { name: "compass_propose_task", arguments: args });
    const denied = await propose({ title: "inject", lane: "team", who: "Chris" });
    expect(denied.result?.isError || denied.error).toBeTruthy();
    const r = await propose({ title: "MCP proposal" });
    expect(r.result.isError).not.toBe(true);
    const id = r.result.structuredContent.id;
    const row = db.query("SELECT created_by, lane FROM tasks WHERE id = ?").get(id) as any;
    expect(row.created_by).toContain("(agent)"); expect(row.created_by).toContain("Chris"); expect(row.lane).toBe("agent");
    const inject = await rpcBody(c.access_token, "tools/call", { name: "compass_set_status", arguments: { taskId: id, status: "doing", owner: "Chris" } });
    expect(inject.result?.isError || inject.error).toBeTruthy();
    const done = await rpcBody(c.access_token, "tools/call", { name: "compass_set_status", arguments: { taskId: id, status: "done" } });
    expect(done.result.isError).not.toBe(true);
    const human = await rpcBody(c.access_token, "tools/call", { name: "compass_edit_brief", arguments: { text: "override" } });
    expect(human.result?.isError || human.error).toBeTruthy();
  });
  test("a second registered client cannot bypass the person's daily agent write quota", async () => {
    const a = await connect("compass:read compass:write"), b = await connect("compass:read compass:write");
    const who = "MCP for Chris (agent)";
    const count = db.query<{ n: number }>("SELECT COUNT(*) n FROM events WHERE who = ?").get(who)!.n;
    for (let i = count; i < 200; i++) db.query("INSERT INTO events (kind, who, at) VALUES ('task.add', ?, ?)").run(who, new Date().toISOString());
    for (const c of [a, b]) {
      const r = await rpcBody(c.access_token, "tools/call", { name: "compass_propose_task", arguments: { title: "over quota" } });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain("limit");
    }
  });
  test("concurrent clients keep independent identity and permissions; legacy tokens work", async () => {
    const a = await connect("compass:read compass:write"), b = await connect("compass:read", "Alex");
    const [wa, rb, old] = await Promise.all([rpcBody(a.access_token, "tools/list"), rpcBody(b.access_token, "tools/list"), rpcBody(TOKEN, "tools/list")]);
    expect(wa.result.tools).toHaveLength(12); expect(rb.result.tools).toHaveLength(7); expect(old.result.tools).toHaveLength(12);
    const result = await rpcBody(TOKEN, "tools/call", { name: "compass_propose_task", arguments: { title: "legacy" } });
    expect(db.query("SELECT created_by FROM tasks WHERE id = ?").get(result.result.structuredContent.id).created_by).toBe("Codex (agent)");
  });
});
