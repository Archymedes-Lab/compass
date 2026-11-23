// Local Compass: one Bun process on bun:sqlite. The page is bundled from web/index.html on request.
// Sign-in uses COMPASS_USERS / SESSION_KEY from the environment, with dev defaults on loopback.
import { runAutomation } from "./automation.ts";
import { onAutomationChanged, setAutomationConfig } from "./automation-store.ts";
import index from "../web/index.html";
import { openLocal } from "./local.ts";
import { createHandler } from "./api.ts";
import { judgePending, onJudgeQueued, setJudgeKey } from "./state.ts";
import { periodic } from "./periodic.ts";
import { setEmailConfig } from "./email.ts";
import { onConversationQueued, setConversationConfig } from "./conversation-store.ts";
import { processConversations } from "./conversations.ts";
import { parseUsers } from "./auth.ts";

openLocal();
setAutomationConfig({ openrouterKey: process.env.OPENROUTER_API_KEY, exaKey: process.env.EXA_API_KEY, enabled: process.env.AUTOMATION_ENABLED === "true", model: process.env.AUTOMATION_MODEL });
onAutomationChanged(() => { void runAutomation(); });
setInterval(() => { void runAutomation(); }, 60_000);
void runAutomation();
setJudgeKey(process.env.TYPESAFE_API_KEY);
setEmailConfig({ resendKey: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM, appUrl: `http://127.0.0.1:${process.env.PORT ?? 3040}` });
setConversationConfig({ sessionKey: process.env.SESSION_KEY ?? "local-dev-session-key-not-secret", webhookSecret: process.env.RESEND_WEBHOOK_SECRET, receivingDomain: process.env.COMPASS_RECEIVING_DOMAIN });
const conversations = () => { void processConversations({ team: parseUsers(process.env.COMPASS_USERS ?? "Chris:dev,Alex:dev").names }).catch(console.error); };
onConversationQueued(conversations);
setInterval(conversations, 5000);
// Sites, GitHub, the daily scan and email. Off unless COMPASS_PERIODIC=1, so a dev server never mails anyone by accident.
if (process.env.COMPASS_PERIODIC === "1") setInterval(() => { void periodic({ githubToken: process.env.GITHUB_TOKEN, judgeKey: process.env.TYPESAFE_API_KEY }); }, 5 * 60_000);
let judging = false, again = false;
const run = () => {
  if (judging) { again = true; return; }
  judging = true;
  judgePending().finally(() => { judging = false; if (again) { again = false; run(); } });
};
onJudgeQueued(run);
run();

const api = createHandler({
  users: process.env.COMPASS_USERS ?? "Chris:dev,Alex:dev",
  sessionKey: process.env.SESSION_KEY ?? "local-dev-session-key-not-secret",
  agents: process.env.COMPASS_AGENTS,
  mcpOrigin: process.env.MCP_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3040}`,
  mcpRedirectUris: process.env.MCP_REDIRECT_URIS,
  judgeKey: process.env.TYPESAFE_API_KEY,
});

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3040),
  hostname: "127.0.0.1",
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  routes: { "/": index, "/api/*": (req) => api(req as unknown as Request), "/mcp": (req) => api(req as unknown as Request), "/oauth/*": (req) => api(req as unknown as Request), "/.well-known/*": (req) => api(req as unknown as Request) },
});
console.log(`Compass on ${server.url}${process.env.COMPASS_USERS ? "" : "  (dev sign-in: Chris or Alex, passphrase \"dev\")"}`);
