# Projects, context and the daily email

Compass tracks every project the team works on, pulls context from where the work happens, proposes tasks from it,
and emails each founder what to do today. Orion still decides the order. GPT-6 Luna proposes and people adopt.

```
 this machine ──compass-sync (metadata)──┐
 Codex / Claude ──MCP compass_report_context──┤
 GitHub ──Worker (GITHUB_TOKEN)──────────┼──► project signals ──► attention (rules)
 live sites ──Worker (every 15 min)──────┘          │
                                                    ▼
                         daily scan: GPT-6 Luna reads all context ──► candidate tasks
                                                    │
                         Jev judges each (9 dimensions, orbit-pooled) ──► Orion ranks with the live list
                                                    │         (value, P(top 5), likely rank, bold bet)
                                                    ▼
                         Projects tab: adopt / dismiss ──► tasks (keep their judgment)
                                                    │
                         daily email per founder (template, Resend)
```

## Where context comes from

| Source | How | What is stored |
| --- | --- | --- |
| Working copies | `bun run sync` on each machine (cron) | branch, uncommitted count, unpushed/unpulled counts, last 5 commit subjects |
| Claude Code sessions | same, from `~/.claude/projects` | title, first prompt (scrubbed, 240 chars), branch, time |
| Codex sessions | same, from `~/.codex/state_5.sqlite` (read-only) | title, first prompt (scrubbed, 240 chars), branch, time |
| GitHub | collector via `gh auth token`; Worker via `GITHUB_TOKEN` | default branch, 5 commits, open PRs, latest CI run |
| Live sites | Worker, every 15 minutes | HTTP status, response time |
| Agent reports | Codex/Claude call MCP `compass_report_context` | summary, state, risks, next steps (scrubbed) |

**Never sent:** transcripts, assistant replies, tool output, diffs, file contents or file names. Free text is scrubbed
of credential-shaped strings and email addresses twice: in the collector and again on the server. Check what leaves
the machine with `bun run sync -- --dry-run`.

## Set up

1. **Sync token.** Generate one (`openssl rand -hex 32`). Add `Sync:<token>` to the Worker's `COMPASS_AGENTS` secret
   and `COMPASS_SYNC_TOKEN=<token>` to `~/.config/archymedes/compass-agents.env`. Sync has its own daily write quota.
2. **Schedule the collector** (`crontab -e`). Unchanged readings are not re-sent for 6 hours:
   ```
   17 * * * * cd ~/compass && ~/.bun/bin/bun scripts/compass-sync.ts --quiet
   ```
3. **Server secrets** (`wrangler secret put …`):
   - `RESEND_API_KEY` is required for email. `RESEND_FROM` is optional, a sender on a domain verified in Resend (default `Compass <compass@archymedes.xyz>`).
   - `GITHUB_TOKEN` is optional: a fine-grained, read-only token for the org's repos (metadata, contents, pull requests and actions, all read).
   - `OPENROUTER_API_KEY` is already set for the planner; the scan uses it too.
4. **Codex on a schedule.** Connect Codex to `https://compass.archymedes.xyz/mcp` with `compass:write`, then schedule:
   > Every morning: for each repository you have worked in this week, check git log, open branches, failing tests and
   > open TODOs, then call `compass_report_context` once with a report per project: a summary of where it stands,
   > build/test/deploy state, risks, and concrete next steps. Facts you checked, not guesses. No secrets, customer data
   > or code. Then call `compass_next` and work on the agent-lane tasks it gives you.

   Claude Code can run the same prompt via `/schedule`.
5. **In the app:** Projects tab → edit each project's brief and live sites; archive repos that are not products.
   Planner tab → Daily email → each founder's address and the send hour.

## The scan

- Runs once a day after the scan hour (default 04:00 UTC), and on **Scan now** (at most once an hour).
- Costs one GPT-6 Luna call (reserved $0.03 against a default $0.10/day scan allowance, separate from the planner's)
  plus one Jev judgment per proposal, eight at most.
- Proposals that duplicate a live task or an open proposal, or that name an unknown project, are dropped.
- Each proposal shows where Orion would put it today: rank among the live list plus open proposals, P(top 5), likely
  rank range, and whether it would be the bold bet. Ranks are refreshed every tick as the list changes.
- **Adopt** creates the task with the judgment it already has (no second Jev call) in the lane Luna suggested, or
  the other one. **Dismiss** removes it. Nothing is added without a person.

## Attention rules (src/projects.ts `attentionFor`)

| Rule | Severity |
| --- | --- |
| Live site not answering | high |
| CI failing on the default branch | high |
| 50+ uncommitted files, no commit for 2+ days | medium (15+: low) |
| Commits not pushed, 1+ day old | medium |
| Branch with no upstream, 1+ day old | medium |
| Open non-draft PR untouched for 7 days | low |
| Site slower than 4 s | low |
| Recent Claude/Codex session with no matching task | low |
| No fresh repo context for 3 days | low |

Each rule (except slow sites and stale context) offers a ready-made task, "make it a task".

## The daily email

One per founder, after the send hour (UTC), once a day, with up to 3 retries. The sections:

1. Your focus.
2. Your next tasks.
3. What needs you (agents' requests, owed debriefs, check-in, unmeasured goals).
4. High and medium project alerts.
5. Top 3 proposals with Orion's odds.
6. The agents' work.

A fixed template: no model call. "Preview mine" shows it in the app, and "Send me today's now" sends only to you.

## Defensibility is the prime law

- The value model weights defensibility as heavily as impact: `CoD = 2·impact + 2·defensibility + urgency + leverage + quality`.
  No term may outweigh it (`tests/invariants.test.ts` enforces this).
- **Moat-worthy** is Orion's verdict alone: P(Jev's defensibility belief ≥ "Clearly harder to copy") ≥ 0.5.
  The task list, `/api/agent/next`, MCP, the scan proposals and the email all show the same verdict.
- GPT-6 Luna proposes with defensibility in mind, but never labels or ranks: identical judgments get identical value
  and verdict whatever the proposal says (an invariant).

## Connecting Codex

Use the bearer token. Codex's OAuth sign-in redirects to `http://127.0.0.1:<random port>/callback`, which Compass's
exact allowlist rejects. Codex's own docs don't pin down that callback's exact path, so loopback OAuth is not enabled.

1. Export the token Codex will use (from `~/.config/archymedes/compass-agents.env`) in the shell or service that
   starts Codex, for example in `~/.bashrc`:
   ```sh
   export COMPASS_TOKEN="$(grep ^COMPASS_AGENT_CODEX_TOKEN= ~/.config/archymedes/compass-agents.env | cut -d= -f2)"
   ```
2. Add the server (CLI, IDE extension and Codex app share `~/.codex/config.toml`):
   ```sh
   codex mcp add compass --url https://compass.archymedes.xyz/mcp --bearer-token-env-var COMPASS_TOKEN
   ```
   or by hand:
   ```toml
   [mcp_servers.compass]
   url = "https://compass.archymedes.xyz/mcp"
   bearer_token_env_var = "COMPASS_TOKEN"
   default_tools_approval_mode = "writes"   # reads run freely; writes ask (set "approve" for unattended runs)
   ```
3. Check: `codex mcp list`, then `/mcp` in the TUI. You should see `compass_next`, `compass_projects`,
   `compass_report_context` and the other tools.
4. Schedule it in the Codex app: **Scheduled → new task**, daily, "start a new chat", run in the local project
   (keep the app open) with this prompt:
   > Check Compass first: call compass_next (lane agent) and compass_projects. For each repository you worked in
   > this week, review git log, open branches, failing tests and TODOs, then call compass_report_context once with a
   > report per project (summary, build/test/deploy state, risks, next steps; facts you checked, no secrets or code).
   > Then work the first agent-lane task whose directive is "proceed", following its done-when and steps, and record
   > progress with compass_set_status / compass_debrief. Ask with compass_request_help when a person is needed.

   Without the app, use cron:
   `0 7 * * * cd ~/compass && COMPASS_TOKEN=… codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"`.
   Unattended MCP calls must not wait on approval: set `default_tools_approval_mode = "approve"` for that profile.

Open questions in OpenAI's docs: whether MCP servers from `config.toml` run inside desktop scheduled tasks
(standalone tasks "can use plugins"), and whether `codex exec` accepts `-a`. Check `codex exec --help` and one
scheduled run's output.

## Connecting ChatGPT Work (Business / Enterprise)

1. **Admin:** Workspace settings → Permissions & roles → enable "Use plugins" and "Create plugins with MCPs"
   (Business: only admins/owners create and publish custom MCP plugins; Enterprise: grant it by role).
2. Go to chatgpt.com/plugins → **+** → **Add custom MCP server**. Name it "Compass", set the URL to
   `https://compass.archymedes.xyz/mcp`, choose **OAuth**, accept the warning, then **Create as a plugin** and install it.
3. Sign in on Compass's consent page with your Compass name and passphrase. ChatGPT asks for `compass:read`, plus
   `compass:write` because it reads `scopes_supported`. Approving write lets ChatGPT propose tasks, report context and
   record progress under "MCP for <you> (agent)", within the agent rules and the shared 200 writes/day.
4. Redirect: Compass returns `iss` on every authorization response (RFC 9207), so ChatGPT uses the stable
   `https://chatgpt.com/connector_platform_oauth_redirect`, which is the default allowlist. If the plugin's
   management page shows a different callback (`https://chatgpt.com/connector/oauth/<id>`), add it to
   `MCP_REDIRECT_URIS` and redeploy.
5. Use it with `@Compass` in a chat. Write tools always ask for confirmation in ChatGPT. Read tools are marked
   read-only and don't ask. `search`/`fetch` make Compass available to deep research and company knowledge.
6. Publishing to the workspace freezes the tool list until an admin publishes an update: re-publish after deploys
   that add tools.
7. Disconnect any time at `https://compass.archymedes.xyz/oauth/connections`.

Not confirmed by OpenAI's docs: custom MCP plugins inside ChatGPT scheduled tasks or agent mode.
