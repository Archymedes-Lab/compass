#!/usr/bin/env bash
# Deploy Compass whenever origin/master moves: a clean worktree, typecheck, tests, then wrangler deploy.
# Nothing ships unless every check passes. Run from cron (every 10 minutes); safe to run any time.
#   */10 * * * * ~/compass/scripts/autodeploy.sh
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
REPO="$HOME/compass"
STATE="$HOME/.cache/compass-deploy"
WT="$STATE/compass"            # src imports ../../orion, so the worktree's sibling must be orion
LOG="$STATE/deploy.log"
mkdir -p "$STATE"
exec 9>"$STATE/lock"; flock -n 9 || exit 0
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

git -C "$REPO" fetch -q origin master
target=$(git -C "$REPO" rev-parse origin/master)
[ "$(cat "$STATE/deployed" 2>/dev/null)" = "$target" ] && exit 0
[ "$(cat "$STATE/failed" 2>/dev/null)" = "$target" ] && exit 0   # don't retry a broken commit every 10 minutes

[ -e "$STATE/orion" ] || ln -s "$HOME/orion" "$STATE/orion"
if [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then git -C "$WT" checkout -q --detach "$target"; git -C "$WT" reset -q --hard "$target"; git -C "$WT" clean -qfdx -e node_modules
else git -C "$REPO" worktree add -q --detach "$WT" "$target"; fi

cd "$WT"
log "deploying $target"
if bun install --frozen-lockfile >>"$LOG" 2>&1 && bun run typecheck >>"$LOG" 2>&1 && bun test tests >>"$LOG" 2>&1 && bun run deploy >>"$LOG" 2>&1; then
  echo "$target" > "$STATE/deployed"; log "deployed $target"
else
  echo "$target" > "$STATE/failed"; log "FAILED $target (see above); fix and push a new commit"
fi
