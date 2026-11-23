# Compass

Orion-guided to-do list for a small team. Goal: maximise success, the quality of what we ship, and defensibility.

Live at **https://compass.archymedes.xyz** (Cloudflare Worker + one SQLite Durable Object). Sign in with your name and
passphrase (set in the `COMPASS_USERS` Worker secret).

    bun install
    bun run dev      # local, http://127.0.0.1:3040 (dev sign-in: Chris or Alex, passphrase "dev")
    bun run seed     # optional locally: seed + judge inline (the Worker seeds itself on first use)
    bun test
    bun run deploy   # build dist/ and wrangler deploy

Needs `TYPESAFE_API_KEY` and the ORION engine checked out at `~/orion` (the engine is imported and bundled from there).
Worker secrets: `COMPASS_AGENTS` (optional, see Agents), `OPENROUTER_API_KEY` and `EXA_API_KEY` (for adaptive planning), `COMPASS_USERS` ("Name:passphrase,Name:passphrase"), `SESSION_KEY`, `TYPESAFE_API_KEY`
(`wrangler secret put …`). To add a person, add them to `COMPASS_USERS`; the team list follows it.

## Agents
Coding agents read the ranking and report their work through the same API, as themselves.
- `COMPASS_AGENTS` (a Worker secret): `Name:token,Name:token`; tokens at least 32 characters. The local tokens for
  Claude and Codex are in `~/.config/archymedes/compass-agents.env` (owner-only).
- An agent sends `Authorization: Bearer <token>` and is recorded as `<Name> (agent)`, never as a person.
- **May:** `GET /api/agent/next` (the ranked open work with why, done-when, steps, links, debriefs owed, lessons),
  `GET /api/state|me|brief`; propose tasks; set its or anyone's task to doing or done; tick steps; edit tasks it
  proposed; debrief done tasks; add links; ask for a re-judge.
- **May not:** team assessments (they override Orion), the brief, check-ins, follow-ups, metrics, dropping a task,
  changing an owner, unlinking, the export, or replacing a debrief a person wrote. At most 200 writes per agent per day.
- An agent's debrief is shown as evidence but **does not train the calibrator**: an agent grading its own work could
  teach Orion its optimism. Only people's debriefs and follow-ups do.


## MCP connections

Remote tools can connect through `/mcp` using Compass login (OAuth with PKCE) or an existing agent bearer token. OAuth defaults to read-only access; optional write permission keeps Compass's agent restrictions. Manage revocation at `/oauth/connections`. See [MCP setup and security](docs/mcp.md) for deployment, callback allowlists, scopes and client configuration.

## Adaptive planner

The **Planner** tab uses GPT-6 Luna through OpenRouter and Exa public research to recommend next work and choose its
next review time. Durable alarms keep it running with the website closed; a cron pulse recovers missed alarms.
People can pause/resume, set guidance and cadence, inspect evidence and usage, and adopt proposals into the agent lane.
Codex and Claude can read the latest plan through MCP (`compass_plan`) or `/api/automation`; normal agent and human
permissions remain in force. Default limits are eight attempts per UTC day and a $0.25 daily planning allowance,
with $0.025 reserved for every attempt. See [automation setup and operating limits](docs/automation.md).

## Projects and the daily email

Compass covers every project, not just Argus. `bun run sync` (cron, on each machine) sends metadata about local
repos, Claude Code and Codex sessions and GitHub; Codex/Claude send written per-project reports through MCP
`compass_report_context`; the Worker checks live sites and GitHub. A daily **project scan** has GPT-6 Luna read all
of it and propose tasks; Jev judges each and Orion ranks it against the live list; people adopt or dismiss them on the
**Projects** tab. Each founder gets a daily email of what to do (Resend). Setup, privacy limits and costs:
[docs/projects.md](docs/projects.md). Extra Worker secrets: `RESEND_API_KEY`, optional `RESEND_FROM`, `GITHUB_TOKEN`.

## Workspace health and reliability

The **System** tab shows failed/queued judgments, missing owners and goal measurements, overdue outcome evidence,
older company briefs and estimate provenance. It links to MCP connection management and data export. Tasks support
search and owner filters; starting unassigned work claims it for the person who started it. Failed actions are visible,
and a failed checklist save restores the previous values.

New work captures its forecast when started (or at completion if never started in Compass). Debriefs and later impact
follow-ups use that captured forecast. Existing historical evidence is preserved. Judgment responses apply only to the
queued task revision and company brief, with bounded batches and restart recovery. Team and agent effort corrections
stay separate throughout ranking and simulation. Unconfirmed agent lessons are labeled and confined to agent context;
disputed lessons are excluded from judgment context. Active blockers are enforced on agent progress writes, and agents
cannot rewrite checklists, weaken existing dependency links or withdraw their own authority requests.


## Two lanes (src/lanes.ts)
Every task is in the **team** lane or the **agent** lane. People choose (Tasks → open a task → "give to the agents");
an agent's own proposals start in the agent lane, and an agent never moves a task.
- **Faster learning, kept apart.** The agent lane learns from outcomes of agent-lane tasks with a quarter of the team
  lane's shrinkage, and always applies it to its own tasks. An agent's own debrief counts ½ until a person confirms it
  on Today (0 if disputed). The team lane still learns only from people.
- **Needs you.** An agent that needs a person raises an intervention (`POST /api/interventions` with `taskId`, `kind`,
  `need`, optional `tried`). Open requests head Today. A person answers Done, Find a way around (with a hint), or
  Decline. An agent can withdraw its own practical request; a person must resolve an authority request.
- **Directives.** `GET /api/agent/next` (default `?lane=agent`; also `team`, `all`) gives each task a directive:
  `proceed`, `wait`, `work-around` (with the person's hint) or `stop`, with actionable work first. A practical blocker
  (information, access, decision, external) turns into `work-around` after 24 h without an answer. Authority
  (approval, credential, spend, legal) never does: the agent waits, and "a way around" means a path that does not need
  that authority, never performing, simulating or bypassing it.
- **Sync.** People see what agents did since they last looked ("From the agents" on Today, *Mark as read*), and the
  Agents tab shows the agents' queue, their requests, their activity and what their lane learned. Agents get
  `teamChanges` in `/api/agent/next`: what people changed in the last week (lane moves, edits, finishes, answers).
## Hosting
- `worker/index.ts`: static page from `dist/` (headers in `web/_headers`); `/api/*` → Durable Object `CompassStore`,
  which runs the same handler as local (`src/api.ts`) on DO SQLite via `src/do-sqlite.ts`.
- Jev judging runs from the object's alarm, so it survives restarts. The store seeds itself (`src/seed-data.ts`); a newer
  SEED_VERSION replaces the list only if nobody has used it.
- After a deploy the Durable Object keeps old code until it goes idle (~2–3 min without requests).
- Sign-in: HMAC-signed HttpOnly cookie (`src/auth.ts`); writes require a JSON body, so cross-site forms can't post.

## How it works
- **Appearance.** The header's Theme control offers System, Light and Dark, including on sign-in. The choice is
  saved on this browser; System follows the operating system as it changes.
- **Influence.** On Flow, select a task to trace every upstream input and downstream effect, including indirect
  links. The detail panel shows link distance, task status, team assessments and completed-work evidence.
  Team assessments change estimates and ranking; debriefs re-judge directly linked open tasks. More distant
  links describe possible effects, rather than claiming those tasks were automatically re-judged.
- **Judging.** Jev (`jev-1.14.0`, pinned in Orion) scores each task on Orion's seven prioritisation dimensions plus
  *defensibility* and *quality*. Each question is asked twice with the levels reversed and pooled in log space (cdm's
  belief layer); how far the two orders disagree is stored and widens the belief. Guidance sits in each question's
  instructions, not in the state; Compass's own two dimensions show Jev concrete situations per level. Every judgment
  is logged in a forecast ledger with the model that answered and a hash of the questions (`src/judge.ts`).
- **Ranking** (`src/value.ts`, `src/rank.ts`). One explicit value model: risk-adjusted cost of delay ÷ effort
  (CoD = 2·impact + 2·defensibility + urgency + leverage + quality, Fibonacci scale; × RICE's confidence steps). Defensibility is the prime law: no term outweighs it, and Orion alone marks work **moat-worthy** (P(defensibility ≥ "Clearly") ≥ 0.5 from Jev's belief), the same verdict on every surface, plus
  the value a task passes on to the open work it feeds. The order is by expected value, which is exact (no sampling).
  A seeded simulation over the same beliefs gives each task's P(top 5), P(first) and likely rank range, so a close
  call shows as one. RICE, ICE, WSJF, Leverage, Eisenhower, Moat, Craft and Flow are still computed, as views that
  explain a position; they no longer vote (five of them divide by effort, so a Borda count mostly re-weighted effort).
- **Bold bet** (cdm's innovation slot). The unproven task with the largest expected improvement over #1,
  E[max(V − V₁, 0)], if that upside is at least 1% of #1's value. Unknown is not risky: test it cheaply first.
- **Asks, at two moments only** (`src/questions.ts`):
  1. **As soon as a task is done**: a debrief — result vs expected, real effort, moat created, quality raised,
     the asset it left us, the number it moved, surprise, lesson.
  2. **Once a day per founder** (Kigali day): tasks in progress (on track / blocked / done / drop), impact follow-ups
     for tasks finished 7+ days ago, and up to three questions with the highest preposterior value of information: the expected change to the top 5
     if the team answered, weighted by what Orion thinks the answer is, plus what we learned from customers and any blockers.
- **Learning** (`src/calibrate.ts`): every debrief and follow-up compares Orion's belief with what happened, from the
  first outcome on. Level bias is shrunk toward zero (one surprise nudges, a pattern moves it); effort is corrected as
  a ratio, ln(actual/predicted size) fitted on size by Bayesian regression; a temperature is fitted to the observed
  levels (cdm's Calibrator.fit, with a prior at "no change"). The Learning tab shows Orion's ranked probability score
  and skill against a blind guess, the models that judged, and how much the level order mattered. The *Calibrated
  view* applies the corrections; lessons go back to Jev as context; team answers override Orion on that dimension.
- **Data we hold**: every answer is a row in `data/compass.db`; `/api/export` dumps them all (outcome loop, moat 1).

The company brief Jev judges against is edited in the app (section 05); `src/brief.ts` is only the default.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
