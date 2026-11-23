// compass.archymedes.xyz: Compass as a Cloudflare Worker. Static assets (the bundled page) are served by the
// platform; every /api request goes to one SQLite-backed Durable Object that holds the whole store, so both
// founders see one consistent list. Jev judging runs from the object's alarm: it survives restarts and retries.
//   bun run deploy        (secrets: wrangler secret put COMPASS_USERS | SESSION_KEY | TYPESAFE_API_KEY)
import { runAutomation } from "../src/automation.ts";
import { automationStatus, onAutomationChanged, setAutomationConfig } from "../src/automation-store.ts";
import { db } from "../src/db.ts";
import { DurableObject } from "cloudflare:workers";
import { useDb, type DB } from "../src/db.ts";
import { DoDatabase } from "../src/do-sqlite.ts";
import { isMcpPath } from "../src/mcp.ts";
import { createHandler } from "../src/api.ts";
import { judgePending, onJudgeQueued, setJudgeKey } from "../src/state.ts";
import { syncSeed } from "../src/seed-data.ts";
import { periodic } from "../src/periodic.ts";
import { setEmailConfig } from "../src/email.ts";
import { conversationWakeAt, onConversationQueued, setConversationConfig, webhookSecret } from "../src/conversation-store.ts";
import { processConversations } from "../src/conversations.ts";
import { ensureEmailWebhook } from "../src/email-inbound.ts";
import { parseUsers } from "../src/auth.ts";

interface Env {
  COMPASS: DurableObjectNamespace<CompassStore>;
  ASSETS: Fetcher;
  COMPASS_USERS: string;
  SESSION_KEY: string;
  /** Optional: "Name:token,..." for agents (bearer tokens, at least 32 characters). */
  COMPASS_AGENTS?: string;
  OPENROUTER_API_KEY?: string;
  EXA_API_KEY?: string;
  AUTOMATION_ENABLED?: string;
  AUTOMATION_MODEL?: string;
  MCP_ORIGIN?: string;
  MCP_REDIRECT_URIS?: string;
  TYPESAFE_API_KEY: string;
  /** Optional: the daily email (Resend). RESEND_FROM must be a sender on a domain verified in Resend. */
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_WEBHOOK_SECRET?: string;
  COMPASS_RECEIVING_DOMAIN?: string;
  /** Optional: read-only GitHub token so repository state refreshes even when no machine is syncing. */
  GITHUB_TOKEN?: string;
  /** Set per deploy (package.json deploy script). */
  BUILD?: string;
}

export class CompassStore extends DurableObject<Env> {
  private handle!: (req: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      useDb(new DoDatabase(ctx.storage) as unknown as DB);
      setJudgeKey(env.TYPESAFE_API_KEY);
      setAutomationConfig({ openrouterKey: env.OPENROUTER_API_KEY, exaKey: env.EXA_API_KEY, enabled: env.AUTOMATION_ENABLED === "true", model: env.AUTOMATION_MODEL });
      onAutomationChanged(() => void ctx.storage.setAlarm(Date.now() + 100));
      onJudgeQueued(() => void ctx.storage.setAlarm(Date.now() + 100));
      setEmailConfig({ resendKey: env.RESEND_API_KEY, from: env.RESEND_FROM, appUrl: env.MCP_ORIGIN });
      setConversationConfig({ sessionKey: env.SESSION_KEY, webhookSecret: env.RESEND_WEBHOOK_SECRET, receivingDomain: env.COMPASS_RECEIVING_DOMAIN });
      onConversationQueued(() => void ctx.storage.setAlarm(Date.now() + 100));
      syncSeed();
      await this.scheduleNext();
      this.handle = createHandler({ users: env.COMPASS_USERS, sessionKey: env.SESSION_KEY, agents: env.COMPASS_AGENTS, mcpOrigin: env.MCP_ORIGIN, mcpRedirectUris: env.MCP_REDIRECT_URIS, judgeKey: env.TYPESAFE_API_KEY });
    });
  }

  override fetch(req: Request) {
    // A Durable Object keeps running the code it started with until it goes idle, and an open tab keeps it busy.
    // The Worker says which build it is; if this object is older, it resets itself and the client retries.
    const build = req.headers.get("x-compass-build");
    if (build && this.env.BUILD && build !== this.env.BUILD) {
      this.ctx.abort("newer build deployed");
    }
    return this.handle(req).then(res => {
      const out = new Response(res.body, res);
      out.headers.set("x-compass-store-build", this.env.BUILD ?? "unversioned");
      return out;
    });
  }

  private async scheduleNext() {
    const times: number[] = [];
    if (this.env.OPENROUTER_API_KEY) {
      const next = conversationWakeAt();
      if (next !== null) times.push(Math.max(Date.now() + 100, next));
    }
    if (this.env.RESEND_API_KEY && this.env.COMPASS_RECEIVING_DOMAIN && !webhookSecret()) {
      const last = db.query<{ value: string }>("SELECT value FROM conversation_secrets WHERE key = 'setup-last-at'").get()?.value;
      times.push(Math.max(Date.now() + 100, last ? Date.parse(last) + 15 * 60000 : 0));
    }
    if (db.query("SELECT id FROM tasks WHERE judge = 'pending' AND status IN ('open', 'doing') LIMIT 1").get()) times.push(Date.now() + 100);
    const planner = automationStatus();
    if (planner.schedule) times.push(Math.max(Date.now() + 100, Date.parse(planner.schedule.nextAt)));
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  async tick() {
    try {
      await ensureEmailWebhook();
      await processConversations({ team: parseUsers(this.env.COMPASS_USERS).names });
      await judgePending(); await runAutomation(); await periodic({ githubToken: this.env.GITHUB_TOKEN, judgeKey: this.env.TYPESAFE_API_KEY });
    }
    finally { await this.scheduleNext(); }
  }

  override async alarm() { await this.tick(); }
}

const SECURITY = {
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.COMPASS.get(env.COMPASS.idFromName("main")).tick());
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    let res: Response;
    if (url.pathname.startsWith("/api/") || isMcpPath(url.pathname)) {
      const stub = () => env.COMPASS.get(env.COMPASS.idFromName("main"));
      let body: ArrayBuffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const reader = req.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024) { await reader.cancel(); return new Response("Request too large", { status: 413 }); }
          chunks.push(value);
        }
        body = await new Blob(chunks as BlobPart[]).arrayBuffer();
      }
      const send = () => {
        // Preserve OAuth redirects for the client. Following them here would send browser headers to the callback.
        const r = new Request(req.url, { method: req.method, headers: req.headers, body, redirect: "manual" });
        if (env.BUILD) r.headers.set("x-compass-build", env.BUILD);
        return stub().fetch(r);
      };
      // Retry reads after an object resets for a new build. A mutation may have committed before losing its response.
      try { res = await send(); } catch (e) { if (req.method !== "GET" && req.method !== "HEAD") throw e; res = await send(); }
    } else res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY)) if (!out.headers.has(k)) out.headers.set(k, v);
    if (url.pathname.startsWith("/api/") || isMcpPath(url.pathname)) { out.headers.set("cache-control", "no-store"); out.headers.set("x-compass-build", env.BUILD ?? "unversioned"); }
    return out;
  },
} satisfies ExportedHandler<Env>;
