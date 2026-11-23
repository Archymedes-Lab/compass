#!/usr/bin/env bash
# Daily: Codex reviews each active repository read-only and reports where it stands to Compass over MCP
# (compass_report_context). Runs before the project scan so GPT-6 Luna and Orion see fresh agent reports.
#   30 3 * * * ~/compass/scripts/codex-report.sh
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
set -a; . "$HOME/.config/archymedes/compass-agents.env"; set +a
export COMPASS_TOKEN="$COMPASS_AGENT_CODEX_TOKEN"
LOG="$HOME/.cache/compass-sync/codex-report.log"; mkdir -p "$(dirname "$LOG")"
exec 9>"$HOME/.cache/compass-sync/codex.lock"; flock -n 9 || exit 0
PROMPT='You are reporting project status to Compass, the team task system (MCP server "compass").
1. Call compass_projects to see the projects Compass tracks and their alerts.
2. For each active project with a local checkout under ~ (at most 12, most recently active first): read-only review of
   git log -15, git status, open branches, the README/TODO files, and test or CI configuration. Do not modify files.
3. Call compass_report_context ONCE with one report per project: summary (where it stands, what changed recently),
   state (build/test/deploy/release), risks, and concrete next steps, most valuable first. Defensibility is the prime
   law: say which next steps make Archymedes harder to copy. Facts you checked, never guesses; no secrets, customer data or code.
4. Reply with one line per project reported.'
cd "$HOME"
echo "== $(date -u +%FT%TZ)" >> "$LOG"
codex exec --sandbox read-only --skip-git-repo-check -c 'mcp_servers.compass.default_tools_approval_mode="approve"' "$PROMPT" >> "$LOG" 2>&1
