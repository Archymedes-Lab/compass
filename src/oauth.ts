// OAuth authorization-code + S256 PKCE. Opaque credentials are hashed at rest; grants are revocable.
// No remote metadata fetching or wildcard redirects: registration only accepts operator-approved callbacks.
import { db, log } from "./db.ts";
import { parseUsers, sessionUser } from "./auth.ts";

export interface OAuthConfig { users: string | undefined; sessionKey: string; mcpOrigin?: string; mcpRedirectUris?: string }
export interface Grant { user: string; client: string; scope: string; resource: string; who: string }
type Client = { name: string; redirects: string[] };
type Pending = { client: string; redirect: string; challenge: string; state: string; scope: string; resource: string };
type Credential = { grant: string; client: string; challenge?: string; redirect?: string };
const seconds = () => Math.floor(Date.now() / 1000);
export const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
export async function digest(value: string) {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function put(id: string, kind: string, value: unknown, ttl: number) {
  db.query("INSERT OR REPLACE INTO oauth_records (id, kind, value, expires) VALUES (?, ?, ?, ?)").run(id, kind, JSON.stringify(value), seconds() + ttl);
}
function get<T>(id: string, kind: string): T | null {
  const row = db.query<{ value: string }>("SELECT value FROM oauth_records WHERE id = ? AND kind = ? AND expires > ?").get(id, kind, seconds());
  return row ? JSON.parse(row.value) as T : null;
}
const del = (id: string) => db.query("DELETE FROM oauth_records WHERE id = ?").run(id);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (name = "invalid_request", status = 400) => json({ error: name }, status);
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SCOPES = ["compass:read", "compass:write"];
const scopes = (s: string) => s.split(" ").filter(Boolean);
export const isMcpPath = (p: string) => p === "/mcp" || p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-");

export async function rateLimit(key: string, max: number, ttl = 900) {
  const id = `rate:${await digest(key)}`;
  return db.transaction(() => {
    db.query("DELETE FROM oauth_records WHERE kind = 'rate' AND expires <= ?").run(seconds());
    const n = get<number>(id, "rate") ?? 0;
    if (n >= max) return false;
    // A fixed window, not an indefinitely sliding lockout.
    if (n) db.query("UPDATE oauth_records SET value = ? WHERE id = ?").run(JSON.stringify(n + 1), id);
    else put(id, "rate", 1, ttl);
    return true;
  })();
}

export async function loginAllowed(req: Request, user: string) {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  return await rateLimit(`login-ip:${ip}`, 15) && await rateLimit(`login-user:${user}`, 10);
}

export function createOAuth(cfg: OAuthConfig) {
  const users = parseUsers(cfg.users);
  const origin = new URL(cfg.mcpOrigin ?? "https://compass.archymedes.xyz").origin;
  const base = new URL(origin);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("MCP_ORIGIN requires HTTPS (except loopback development)");
  const resource = `${origin}/mcp`;
  const redirects = (cfg.mcpRedirectUris ?? "https://chatgpt.com/connector_platform_oauth_redirect").split(",").map(x => x.trim()).filter(Boolean);
  for (const uri of redirects) {
    const u = new URL(uri);
    if (u.hash || u.username || u.password || (u.protocol !== "https:" && !(base.protocol === "http:" && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw new Error("Invalid MCP_REDIRECT_URIS");
  }
  const cookie = (value: string, age = 600) => `compass_oauth=${value}; Path=/oauth/; HttpOnly; SameSite=Lax; Max-Age=${age}${base.protocol === "https:" ? "; Secure" : ""}`;
  const allowedScope = (scope: string) => scopes(scope).includes("compass:read") && scopes(scope).every(s => SCOPES.includes(s));
  const activeGrant = (id: string) => {
    const g = get<Grant>(id, "grant");
    return g && users.names.includes(g.user) && g.resource === resource ? g : null;
  };
  async function issue(grant: string, client: string) {
    const access = random(), refresh = random();
    const a = await digest(access), r = await digest(refresh);
    const g = activeGrant(grant);
    if (!g) return error("invalid_grant");
    db.transaction(() => {
      put(a, "access", { grant, client }, 3600);
      put(r, "refresh", { grant, client }, 30 * 86400);
    })();
    return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: g.scope });
  }
  async function authenticate(token: string) {
    const c = get<Credential>(await digest(token), "access");
    return c ? activeGrant(c.grant) : null;
  }
  const challenge = () => new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="compass:read"` } });
  function page(p: Pending, client: Client, nonce: string) {
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to Compass</title><body><main><h1>Connect to Compass</h1><p>Allow <strong>${esc(client.name)}</strong> to access the shared Compass workspace.</p><p>Callback: ${esc(p.redirect)}</p><p>Permissions: ${esc(p.scope)}. Read access includes the workspace brief, tasks, team activity, blockers and lessons. Write access permits agent proposals and progress updates under Compass's agent restrictions (200 writes/day).</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${nonce}"><p><label>Name <input name="name" autocomplete="username" required maxlength="40"></label></p><p><label>Compass passphrase <input type="password" name="passphrase" autocomplete="current-password" required maxlength="1024"></label></p><button name="decision" value="allow">Sign in and allow</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form><p>Your passphrase stays with Compass. Disconnect at /oauth/connections.</p></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": cookie(nonce), "content-security-policy": `default-src 'none'; form-action 'self' ${new URL(p.redirect).origin}; frame-ancestors 'none'; base-uri 'none'` } });
  }
  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url), p = url.pathname, method = req.method;
    // Pin issuer/host; never derive authorization metadata or redirects from untrusted request headers.
    if (url.origin !== origin) return error("invalid_host", 403);
    if (req.headers.has("origin") && req.headers.get("origin") !== origin) return error("invalid_origin", 403);
    db.query("DELETE FROM oauth_records WHERE expires <= ? AND kind != 'client'").run(seconds());
    if (method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp"))
      return json({ resource, authorization_servers: [origin], scopes_supported: SCOPES, bearer_methods_supported: ["header"] });
    if (p === "/.well-known/oauth-authorization-server" && method === "GET") return json({
      issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"], scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true,
    });
    if (p === "/oauth/connections" && method === "GET") {
      const user = await sessionUser(req, cfg.sessionKey, users);
      if (!user) return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Compass connections</title><h1>Compass connections</h1><p><a href="/">Sign in to Compass</a>, then return to this page to disconnect tools.</p></html>', { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      const nonce = random();
      put(await digest(nonce), "manage", { user }, 600);
      const grants = db.query<{ id: string; value: string; expires: number }>("SELECT id, value, expires FROM oauth_records WHERE kind = 'grant' AND expires > ?").all(seconds())
        .map(r => ({ ...r, g: JSON.parse(r.value) as Grant })).filter(r => r.g.user === user);
      const forms = grants.map(r => `<li>${esc(get<Client>(r.g.client, "client")?.name ?? "MCP client")} — ${esc(r.g.scope)} — expires ${esc(new Date(r.expires * 1000).toISOString())}<form method="post" action="/oauth/connections"><input type="hidden" name="request" value="${nonce}"><input type="hidden" name="grant" value="${r.id}"><button>Disconnect</button></form></li>`).join("");
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Compass connections</title><h1>Connections for ${esc(user)}</h1><ul>${forms || "<li>No active connections.</li>"}</ul><p>Disconnecting immediately invalidates all access and refresh tokens for that connection.</p><a href="/">Back to Compass</a></html>`, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": cookie(nonce) } });
    }
    if (p === "/oauth/connections" && method === "POST") {
      if (req.headers.get("origin") !== origin || !(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return error("invalid_origin", 403);
      const user = await sessionUser(req, cfg.sessionKey, users);
      if (!user) return error("access_denied", 401);
      const b = new URLSearchParams(await req.text()), nonce = b.get("request") ?? "";
      const bound = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)compass_oauth=([a-f0-9]{64})(?:;|$)/)?.[1];
      const hash = await digest(nonce);
      if (!bound || bound !== nonce || get<{ user: string }>(hash, "manage")?.user !== user) return error("invalid_csrf", 403);
      const id = b.get("grant") ?? "";
      const ok = db.transaction(() => {
        if (get<{ user: string }>(hash, "manage")?.user !== user || get<Grant>(id, "grant")?.user !== user) return false;
        del(hash); del(id); log("mcp.disconnect", user, null, { grant: id });
        return true;
      })();
      if (!ok) return error("access_denied", 403);
      return new Response(null, { status: 303, headers: { location: `${origin}/oauth/connections`, "set-cookie": cookie("", 0) } });
    }
    if (!["/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"].includes(p)) return error("not_found", 404);
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (method === "POST" && !await rateLimit(`endpoint:${p}:${ip}`, p === "/oauth/register" ? 20 : 120, 60)) return error("rate_limited", 429);
    if (p === "/oauth/register" && method === "POST") {
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return error();
      const b = await req.json() as Record<string, unknown>;
      if (!b || !Array.isArray(b.redirect_uris) || !b.redirect_uris.length || b.redirect_uris.length > 5 || !b.redirect_uris.every(u => typeof u === "string" && redirects.includes(u))) return error("invalid_redirect_uri");
      if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== "none") return error("invalid_client_metadata");
      if (b.grant_types !== undefined && (!Array.isArray(b.grant_types) || !b.grant_types.every(g => ["authorization_code", "refresh_token"].includes(g)))) return error("invalid_client_metadata");
      if (b.response_types !== undefined && (!Array.isArray(b.response_types) || b.response_types.length !== 1 || b.response_types[0] !== "code")) return error("invalid_client_metadata");
      if (db.query<{ n: number }>("SELECT COUNT(*) n FROM oauth_records WHERE kind = 'client'").get()!.n >= 1000) return error("registration_capacity", 429);
      const client = random();
      const name = typeof b.client_name === "string" ? b.client_name.slice(0, 100) : "MCP client";
      put(client, "client", { name, redirects: b.redirect_uris }, 10 * 365 * 86400);
      return json({ client_id: client, client_name: name, redirect_uris: b.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
    }
    if (p === "/oauth/authorize" && method === "GET") {
      if (!await rateLimit(`authorize:${ip}`, 60, 60)) return error("rate_limited", 429);
      const q = url.searchParams, id = q.get("client_id") ?? "", redirect = q.get("redirect_uri") ?? "";
      const client = get<Client>(id, "client");
      if (!client || !client.redirects.includes(redirect) || !redirects.includes(redirect)) return error("invalid_client");
      const scope = q.get("scope") ?? "compass:read", state = q.get("state") ?? "", ch = q.get("code_challenge") ?? "";
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(ch) || !allowedScope(scope) || q.get("resource") !== resource || state.length > 2048) return error();
      const pending: Pending = { client: id, redirect, challenge: ch, state, scope, resource };
      const nonce = random();
      put(await digest(nonce), "pending", pending, 600);
      return page(pending, client, nonce);
    }
    if (p === "/oauth/authorize" && method === "POST") {
      if (req.headers.get("origin") !== origin || !(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return error("invalid_origin", 403);
      const b = new URLSearchParams(await req.text()), nonce = b.get("request") ?? "";
      const bound = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)compass_oauth=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (!bound || bound !== nonce) return error("invalid_csrf", 403);
      const hash = await digest(nonce), pending = get<Pending>(hash, "pending");
      if (!pending) return error("expired_request");
      const target = new URL(pending.redirect);
      target.searchParams.set("state", pending.state); target.searchParams.set("iss", origin);
      if (b.get("decision") === "deny") {
        del(hash); target.searchParams.set("error", "access_denied");
        return new Response(null, { status: 302, headers: { location: target.href, "set-cookie": cookie("", 0) } });
      }
      const user = (b.get("name") ?? "").slice(0, 40);
      if (!await loginAllowed(req, user)) return error("rate_limited", 429);
      if (b.get("decision") !== "allow" || !users.check(user, b.get("passphrase") ?? "")) return error("access_denied", 401);
      const grant = random(), code = random(), codeHash = await digest(code);
      // Reread and consume after all awaits: two simultaneous consent submissions cannot both succeed.
      const ok = db.transaction(() => {
        if (!get(hash, "pending")) return false;
        del(hash);
        put(grant, "grant", { user, client: pending.client, scope: pending.scope, resource, who: `MCP for ${user} (agent)` }, 30 * 86400);
        put(codeHash, "code", { grant, client: pending.client, challenge: pending.challenge, redirect: pending.redirect }, 120);
        log("mcp.connect", user, null, { grant, client: pending.client, scope: pending.scope });
        return true;
      })();
      if (!ok) return error("expired_request");
      target.searchParams.set("code", code);
      return new Response(null, { status: 302, headers: { location: target.href, "set-cookie": cookie("", 0) } });
    }
    if ((p === "/oauth/token" || p === "/oauth/revoke") && method === "POST") {
      if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return error();
      const b = new URLSearchParams(await req.text()), client = b.get("client_id") ?? "";
      if (!get<Client>(client, "client")) return error("invalid_client", 401);
      if (p === "/oauth/revoke") {
        const hash = await digest(b.get("token") ?? "");
        const c = get<Credential>(hash, "access") ?? get<Credential>(hash, "refresh");
        if (c?.client === client) del(c.grant);
        return json({});
      }
      if (b.get("resource") !== resource) return error("invalid_target");
      const type = b.get("grant_type");
      if (type !== "authorization_code" && type !== "refresh_token") return error("unsupported_grant_type");
      const hash = await digest(b.get(type === "authorization_code" ? "code" : "refresh_token") ?? "");
      const verifier = b.get("code_verifier") ?? "";
      const challenge = type === "authorization_code" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ? await digest(verifier) : "";
      const kind = type === "authorization_code" ? "code" : "refresh";
      const result = db.transaction(() => {
        const c = get<Credential>(hash, kind);
        if (!c || c.client !== client || !activeGrant(c.grant)) {
          const replay = get<Credential>(hash, "used-refresh") ?? get<Credential>(hash, "used-code");
          if (replay?.client === client) del(replay.grant);
          return null;
        }
        if (kind === "code" && (c.challenge !== challenge || c.redirect !== b.get("redirect_uri"))) return null;
        del(hash);
        put(hash, kind === "refresh" ? "used-refresh" : "used-code", c, 30 * 86400);
        return c;
      })();
      return result ? issue(result.grant, client) : error("invalid_grant");
    }
    return error("not_found", 404);
  }
  return { origin, resource, authenticate, challenge, route, activeGrant };
}
