// Passphrase sign-in. COMPASS_USERS = "Chris:passphrase,Alex:passphrase" (a secret); SESSION_KEY signs cookies.
// A session is "name.expiry.hmac" in an HttpOnly, SameSite=Lax cookie; mutations also require a JSON body, which a
// cross-site form cannot send, so there is no CSRF path. WebCrypto only, so it runs in Bun and in Workers.

export interface Users { names: string[]; check(name: string, pass: string): boolean }
const COOKIE = "compass_session";
const MAX_AGE = 30 * 86_400;

export function parseUsers(raw: string | undefined): Users {
  const pairs = (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(":");
    return [p.slice(0, i).trim(), p.slice(i + 1)] as const;
  }).filter(([n, s]) => n && s);
  const map = new Map(pairs);
  return { names: [...map.keys()], check: (name, pass) => map.has(name) && same(map.get(name)!, pass) };
}

function same(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function sign(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sessionCookie(key: string, name: string, secure: boolean) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const value = `${encodeURIComponent(name)}.${exp}.${await sign(key, `${name}.${exp}`)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

export const clearCookie = (secure: boolean) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

export async function sessionUser(req: Request, key: string, users: Users): Promise<string | null> {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [rawName, exp, sig] = m[1].split(".");
  if (!rawName || !exp || !sig) return null;
  const name = decodeURIComponent(rawName);
  if (Number(exp) < Date.now() / 1000 || !users.names.includes(name)) return null;
  return same(sig, await sign(key, `${name}.${exp}`)) ? name : null;
}

// --- agents --------------------------------------------------------------------------------------------------
// COMPASS_AGENTS = "Claude:<token>,Codex:<token>" (a secret). An agent sends `Authorization: Bearer <token>` and is
// recorded as "<Name> (agent)": never as a person, so its words never pass for the team's. Tokens are long random
// strings (at least 32 characters); a shorter one is ignored, so a weak token cannot be configured by mistake.
export const AGENT_SUFFIX = " (agent)";
export interface Agents { names: string[]; byToken(token: string): string | null }

export function parseAgents(raw: string | undefined): Agents {
  const pairs = (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(":");
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
  }).filter(([n, t]) => /^[A-Za-z][\w-]{0,30}$/.test(n) && t.length >= 32);
  return {
    names: pairs.map(([n]) => n + AGENT_SUFFIX),
    byToken: (token) => {
      let found: string | null = null;
      for (const [n, t] of pairs) if (same(t, token)) found = n + AGENT_SUFFIX;   // no early exit: constant work
      return found;
    },
  };
}

export const isAgent = (who: string | null | undefined) => typeof who === "string" && who.endsWith(AGENT_SUFFIX);

/** The agent a request authenticates as; null with no Authorization header; "" for a header that does not match. */
export function agentFor(req: Request, agents: Agents): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(\S{32,512})$/);
  return (m && agents.byToken(m[1])) || "";
}
