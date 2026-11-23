# Adaptive research and planning

Compass uses `openai/gpt-6-luna` through OpenRouter plus Exa public search to review the workspace and recommend what to do next. A Durable Object alarm runs the loop while the website is closed. The model chooses its next review time and explains why, within limits set by a person. A Cloudflare cron pulse every 15 minutes recovers a lost alarm; it does not force an inference call if a run is not due.

## How the participants work together

- **Compass planner:** reads ranked tasks, prerequisites, directives, measured goal numbers, trusted lessons and a compact company brief; performs one Exa search; records a cited plan and next-run rationale. It can suggest missing tasks and ask for human input.
- **Codex and Claude:** continue using agent bearer credentials or OAuth on `/mcp`. `compass_plan` reads planning history; `compass_next` also includes the latest completed plan. Agents execute through their existing tools and report progress/debriefs through Compass. A plan does not grant credentials, approval or spending authority.
- **People:** edit guidance, pause/resume planning, change frequency and allowance, request a run, adopt a proposal into the agent lane, assign work, resolve interventions and confirm outcomes. Adoption is explicit and idempotent. The planner cannot alter human assessments, owners, metrics, approvals or task status, and it cannot run commands, deploy or send messages.

The **Planner** tab shows provider readiness, the upcoming run and reason, daily attempts/reservations, reported usage, recommendations, public evidence and history. Human preferences are data supplied to the planner; retrieved pages cannot override its operating rules. A result that races with a workspace or settings change is retained as superseded/cancelled and cannot be adopted.

## Provider setup

Worker secrets:

- `OPENROUTER_API_KEY`
- `EXA_API_KEY`

Set secrets through Wrangler's hidden-input or stdin workflows. Never put them in source, `wrangler.toml`, browser storage, prompts, exports or logs. Local Bun development reads the same environment variable names.

Non-secret Worker configuration:

```toml
[vars]
AUTOMATION_ENABLED = "true"
AUTOMATION_MODEL = "openai/gpt-6-luna"

[triggers]
crons = ["*/15 * * * *"]
```

The persisted human pause/settings override the initial enabled default. Local development stays paused unless `AUTOMATION_ENABLED=true` is explicitly provided. API configuration responses expose readiness booleans, never key values.

## Cadence and cost controls

Defaults are a 30-minute minimum interval, 24-hour maximum interval, eight attempts per UTC day and a $0.25 daily planning allowance. The model chooses the useful interval between these bounds. Human changes apply to subsequent scheduling; normal manual runs respect the minimum interval and daily allowance too. After a failed/interrupted run, a person can explicitly retry after a one-minute cooldown; the daily reservation and attempt limits still apply.

Each attempt reserves $0.025 before a network request. Failed, interrupted and ambiguous requests retain their reservation because a provider may have billed them. Only one run can be active at once. A ten-minute lease recovers a crashed run. Provider failures use bounded backoff and remain visible in history.

Each run permits one Exa `auto` search with at most three results, at most 32,000 UTF-8 bytes of model instructions/context and at most 2,500 model output/reasoning tokens. OpenRouter routing requires the configured parameters and rejects providers above $0.20 per million input tokens or $1 per million output tokens; provider data collection is denied. There is no hidden alternate-model fallback. Strict structured output is validated again locally, including task IDs and evidence URLs.

As checked on 16 November 2026, [OpenRouter's GPT-6 Luna page](https://openrouter.ai/openai/gpt-6-luna) lists standard input/output at $0.10/$0.50 per million tokens. [Exa pricing](https://exa.ai/pricing) lists `auto` search at $7 per 1,000 requests for up to ten results, with text/highlights included. The application records provider-reported cost when available and marks missing billing data explicitly. It pauses automatically if reported search or total planning cost exceeds the per-attempt thresholds.

This is a conservative application allowance, not an account-wide billing guarantee. Provider price changes, unreported usage, other applications sharing keys and existing TypeSafe task judgments are outside that guarantee. Use provider-side key limits for a financial ceiling across applications. Adopting a new task triggers the existing task judge separately.

## Research privacy and evidence

Exa receives a short public research query, not the private workspace or company brief. The model may suggest the next public query; people can override it in the Planner tab. Credential-like strings, contact emails and private task IDs are rejected in model-generated search queries. The private planning context is sent only to OpenRouter's configured model route.

Retrieved source text is untrusted. Results are bounded and rendered as text; URLs must be HTTPS. The model may cite only supplied URLs and existing task IDs. Public claims never become goal measurements or confirmed outcomes. The planner is advisory and has no external execution tools. Human approval remains necessary for protected work even if a recommendation suggests it.

## API

- `GET /api/automation`: authenticated people and agents can read planning status and recent history.
- `PUT /api/automation`: people set the full validated operating configuration.
- `POST /api/automation/run`: people request a run within the same limits; `retryFailed: true` explicitly retries a failed run after the one-minute cooldown.
- `POST /api/automation/:runId/proposals/:index/accept`: people adopt a completed plan's proposal into the agent lane. Retrying returns the existing task.

Planning runs are included in the authenticated workspace export. Provider secrets are not.

## Verification and limits

Tests cover cadence, daily reservations, manual-run limits, overlap prevention, pause during calls, stale results, crash leases, provider errors, citation validation, explicit adoption, agent access restrictions and request schemas. Browser QA covers the Planner controls. Verify a live recorded run and its next alarm after deployment; mocks do not establish provider access.

The planner researches and recommends. It does not autonomously execute development or business tasks. Codex/Claude remain execution participants, and people remain responsible for approvals and outcome evidence. Scheduled backups, tested restoration and broader identity/MFA work remain follow-on priorities in the system review.
