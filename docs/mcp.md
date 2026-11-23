# Compass MCP

Compass serves a remote MCP endpoint at `/mcp`, using the official TypeScript MCP SDK and stateless Streamable HTTP. The same handler runs locally in Bun and in the Cloudflare Durable Object. Deploy the changes before connecting to the production URL.

## Connect with login

1. Deploy with `bun run deploy` using the existing Compass Worker credentials and secrets.
2. In the MCP client's connection settings, enter `https://compass.archymedes.xyz/mcp`, select OAuth and dynamic client registration (DCR).
3. Follow the Compass login page, inspect the requested permissions and callback URL, then enter your Compass name and passphrase to approve. Every connection requires explicit consent.
4. Start with `compass:read`. To enable agent writes, request `compass:read compass:write` and authorize again. Clients that do not offer scope selection will use read-only access.
5. Sign in to the Compass website and visit `https://compass.archymedes.xyz/oauth/connections` to disconnect a client. Disconnect invalidates its access and refresh tokens immediately.

The authorization server supports public OAuth clients with S256 PKCE, discovery, DCR, issuer identification, refresh rotation and revocation. It does not need an OAuth client secret. The client must send `resource=https://compass.archymedes.xyz/mcp` during both authorization and token exchange, including refresh.

The default callback allowlist is the stable ChatGPT callback `https://chatgpt.com/connector_platform_oauth_redirect`. Compare this with the exact callback shown by your client's connection management page. If it differs, configure `MCP_REDIRECT_URIS` with that exact URI before connecting. Other clients also require their exact callback in this list. Wildcards and arbitrary caller-supplied callbacks are rejected. An unknown callback fails locally without redirecting anywhere.

ChatGPT's current integration guide describes OAuth discovery, DCR, S256 PKCE, resource binding and the stable callback for servers that return the authorization-server issuer: <https://developers.openai.com/plugins/build/auth>. A real ChatGPT Work connection still needs validation after deployment; the SDK integration tests do not establish that a particular workspace's client setup is enabled.

## Configuration

Existing secrets remain `COMPASS_USERS`, `SESSION_KEY`, and optionally `COMPASS_AGENTS`. Never put these in source or a client configuration.

Optional non-secret Worker variables (in `[vars]` in `wrangler.toml`, or through your normal deployment configuration):

```toml
[vars]
MCP_ORIGIN = "https://compass.archymedes.xyz"
MCP_REDIRECT_URIS = "https://chatgpt.com/connector_platform_oauth_redirect,https://your-client.example/oauth/callback"
```

`MCP_ORIGIN` pins the issuer, resource audience and request origin. The production default is `https://compass.archymedes.xyz`. Only HTTPS is accepted outside loopback development. Redirect URIs must be exact HTTPS URLs without fragments or credentials; loopback HTTP callbacks are accepted only when the server itself is in loopback HTTP development mode.

For a local isolated instance:

```sh
COMPASS_DB=:memory: PORT=3041 \
MCP_REDIRECT_URIS=http://127.0.0.1:4321/callback \
bun run dev
```

The Bun server automatically uses `http://127.0.0.1:3041` as its MCP origin. A remote hosted client cannot reach this loopback address directly. Local data is discarded when this process exits.

## Bearer-token clients

Clients that support configured Authorization headers may instead use a separately provisioned `COMPASS_AGENTS` token:

```http
POST /mcp
Authorization: Bearer <agent-token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

These tokens have the existing agent permissions, including writes. Active intervention and prerequisite blockers are enforced on progress writes. Agents cannot withdraw authority requests, rewrite existing checklists or weaken dependency links. Use a different random token for each agent, at least 32 characters, stored in the client's secret storage. Remove or rotate the Worker secret entry to revoke it. Browser session cookies never authenticate MCP requests. OAuth access tokens are restricted to MCP and cannot authenticate the ordinary Compass API.

## Available tools

| Tool | Permission | Purpose |
| --- | --- | --- |
| `compass_next` | read | Ranked work, directives, dependencies, team changes, blockers and lessons; optional `project` filter |
| `compass_state` | read | Shared workspace details, links and learning evidence |
| `compass_brief` | read | Company brief |
| `compass_plan` | read | Adaptive planner history, recommendations, public research and human requests |
| `search`, `fetch` | read | ChatGPT deep research / company knowledge: search tasks, projects and proposals; fetch one with a citation URL |
| `compass_projects` | read | Projects, their context (commits, PRs, CI, sessions, sites, agent reports), attention items and the scan's ranked proposals |
| `compass_report_context` | write | Per-project report (summary, state, risks, next steps) for the scan and the daily email; replaces the agent's previous report |
| `compass_propose_task` | write | Agent-lane proposal; optional `projectId`; queues an Orion judgment |
| `compass_set_status` | write | Open, doing or done |
| `compass_request_help` | write | Ask a person for context, access or authority |
| `compass_debrief` | write | Outcome evidence for a completed task |

Write tools appear only with `compass:write`. Schemas reject extra fields. Changes use the existing agent authorization and attribution path. OAuth connections are recorded as `MCP for <person> (agent)`; all connections for that person share the existing 200 daily write limit. This keeps new client registrations from resetting the quota. Connect/disconnect events separately record the client and grant. Agents cannot edit the company brief, impersonate people, override assessments, change owners or lanes, drop tasks, export the database or replace people's debriefs.

## Security behavior and operational limits

- Credentials use 256 bits of randomness. Codes, access tokens, refresh tokens and consent nonces are stored as SHA-256 hashes in Durable Object SQLite. Clients and grant identifiers are opaque non-secret identifiers.
- Authorization codes expire after two minutes and can be exchanged once. Access tokens last at most one hour. Grants expire after 30 days, so reauthorization is required then even if a refresh token was recently rotated. Expired credentials and removed users are rejected.
- Reusing a consumed code or refresh token for the same client revokes the entire grant. Clients must serialize refresh and reconnect after a replay failure.
- Login and consent are rate limited by source IP and account. Registration is rate limited and capped at 1,000 clients. Clients persist across restarts and deployments. Operators can inspect/prune unused client records if the cap is reached; removing an active client prevents refreshing its connection.
- Login/consent and connection management use browser-bound nonces and same-origin checks. Pages cannot be framed and do not send referrers to other origins. Same-origin referrers preserve the browser Origin header on the consent form. OAuth responses and MCP data are not cached. No passphrase or token is included in audit events or exports.
- MCP requires a bearer token on every request, including discovery of tools. Its public OAuth metadata contains no workspace data. Untrusted origins and hosts are rejected; browser cross-origin CORS access is not enabled. Bodies are capped at 64 KiB, including streamed bodies.
- The transport uses JSON responses without persistent sessions or server-initiated SSE. GET and DELETE on `/mcp` return 405 after authentication. Hosted clients must support Streamable HTTP.
- Cloudflare forwarding does not automatically retry mutations, avoiding duplicate writes when a response is lost. On a deployment reset, clients may need to retry after checking whether their action committed.
- The workspace is shared. Read consent exposes the brief, tasks, activity, blockers and lessons across the team; this is not per-task or per-project isolation. Choose clients accordingly. There is no MFA or external identity-provider integration in this implementation; it uses Compass's existing passphrase accounts.
- Agent task proposals invoke the existing judge and can incur provider usage. The daily write quota bounds actions, but is not a currency budget.

## Validation

Run `bun run typecheck`, `bun test tests`, `bun run build`, and `bunx wrangler deploy --dry-run --outdir /tmp/compass-mcp-worker` before deploying. Tests include a real SDK client/transport handshake, authorization-code exchange, permissions, malformed inputs, CSRF, PKCE, expiry, code and refresh replay, revocation, persistent grants and parallel client isolation.

Before claiming the hosted integration works, complete login from the actual target client, call a read tool, confirm the approved write behavior if needed, and disconnect it. Local SDK and bundle checks cannot verify Cloudflare edge access rules or workspace client availability.

The app's System tab links to connections and shows workspace health. Cloudflare routes API, MCP and OAuth paths before SPA fallback, including browser navigations.

## Keeping ChatGPT Work context current

Reads never save progress. When a conversation or repository work establishes new project facts, decisions, risks or next steps, call `compass_report_context` before finishing. Repository access is not required for user-reported facts; label those facts as user-reported rather than independently verified. Use the project id returned by `compass_projects` and send a complete current summary: each report replaces that connection identity's previous report for the project.

Check `stored` and `unknown`, then read `compass_projects` to confirm the saved report. Unknown or archived projects produce a tool error while preserving successful reports in the same batch; retry only the rejected entries with corrected references. Reports appear in projects, next-work readings, search/fetch, the project scan and daily email. The adaptive planner receives bounded excerpts from the six most recently reported active projects on its next scheduled run. Reports preserve attribution and do not change task status, the company brief or project briefs; use `compass_set_status` for task progress.

`compass_next.connection.canWrite` tells the client whether its current grant can save changes. If false, reconnect with `compass:read compass:write` and approve write access. Existing read-only grants are never silently upgraded. Clients that cache tool descriptions may need to refresh their connection to pick up updated write-back guidance.
