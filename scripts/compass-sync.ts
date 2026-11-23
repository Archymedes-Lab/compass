#!/usr/bin/env bun
// compass-sync: tells Compass what is happening on this machine, as metadata only.
//
//   bun scripts/compass-sync.ts --dry-run     print exactly what would be sent, send nothing
//   bun scripts/compass-sync.ts               send (skipped if nothing changed since the last send)
//   bun scripts/compass-sync.ts --force       send even if unchanged
//
// Per git repository under the roots (default: $HOME, one level deep) with activity in the last DAYS days:
//   - working copy: branch, number of uncommitted files, unpushed/unpulled commit counts, last 5 commit subjects
//   - GitHub (if `gh` is signed in): default branch, last commits, open PRs, latest CI run — token only goes to GitHub
//   - Claude Code sessions (~/.claude/projects) and Codex threads (~/.codex/state_5.sqlite) started in that repo:
//     title, the first prompt (scrubbed of secrets/emails, cut to 240 characters), branch and time.
// Never sent: transcripts, assistant replies, tool output, diffs, file contents, file names.
//
// Configuration (environment, or ~/.config/archymedes/compass-agents.env):
//   COMPASS_SYNC_TOKEN   a token listed in the Worker's COMPASS_AGENTS as "Sync:<token>" (its own daily write quota)
//   COMPASS_URL          default https://compass.archymedes.xyz
//   COMPASS_SYNC_ROOTS   colon-separated directories to look in (default $HOME)
//   COMPASS_SYNC_DAYS    activity window in days (default 30)
//   COMPASS_SYNC_SKIP    comma-separated directory names to leave out
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { repoSlug, repoState, type GithubSignal } from "../src/github.ts";
import { scrub } from "../src/projects.ts";

const HOME = homedir();
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run"), FORCE = args.has("--force"), QUIET = args.has("--quiet");

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(join(HOME, ".config/archymedes/compass-agents.env"));

const URL_BASE = (process.env.COMPASS_URL || "https://compass.archymedes.xyz").replace(/\/+$/, "");
const TOKEN = process.env.COMPASS_SYNC_TOKEN;
const ROOTS = (process.env.COMPASS_SYNC_ROOTS || HOME).split(":").filter(Boolean);
const DAYS = Number(process.env.COMPASS_SYNC_DAYS || 30);
const SKIP = new Set((process.env.COMPASS_SYNC_SKIP || "node_modules").split(",").map(s => s.trim()).filter(Boolean));
const CUTOFF = Date.now() - DAYS * 86_400_000;
const MACHINE = hostname().replace(/[^\w.-]/g, "-").slice(0, 64) || "machine";
const say = (...a: unknown[]) => { if (!QUIET) console.error(...a); };

function git(cwd: string, ...a: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

interface Session { title: string; firstPrompt: string; at: string; branch: string | null }
const meaningful = (s: Session) => s.firstPrompt.length >= 12 || s.title.length >= 12;

/** Claude Code stores a project's sessions under ~/.claude/projects/<cwd with every non-alphanumeric as "-">. */
function claudeSessions(repo: string): Session[] {
  const dir = join(HOME, ".claude/projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .filter(x => x.m >= CUTOFF).sort((a, b) => b.m - a.m).slice(0, 12);
  const out: Session[] = [];
  for (const { f, m } of files) {
    let title = "", first = "", branch: string | null = null;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.includes('"ai-title"') && !(first === "" && line.includes('"type":"user"'))) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "ai-title" && typeof e.aiTitle === "string") title = e.aiTitle;
        else if (e.type === "user" && !first && e.origin?.kind === "human" && typeof e.message?.content === "string" && !e.isSidechain) {
          first = e.message.content; branch = typeof e.gitBranch === "string" ? e.gitBranch : null;
        }
      } catch { /* a partial line from a session still being written */ }
    }
    const s = { title: scrub(title || first, 160), firstPrompt: scrub(first, 240), at: new Date(m).toISOString(), branch };
    if (meaningful(s)) out.push(s);
  }
  return out.slice(0, 8);
}

let codexDb: Database | null | undefined;
function codexSessions(repo: string): Session[] {
  if (codexDb === undefined) {
    const path = join(HOME, ".codex/state_5.sqlite");
    try { codexDb = existsSync(path) ? new Database(path, { readonly: true }) : null; } catch { codexDb = null; }
  }
  if (!codexDb) return [];
  try {
    return codexDb.query<{ title: string; first: string; at: number; branch: string | null }, [string, string, number]>(
      "SELECT title, first_user_message first, updated_at at, git_branch branch FROM threads WHERE archived = 0 AND (cwd = ? OR cwd LIKE ?) AND updated_at >= ? ORDER BY updated_at DESC LIMIT 16")
      .all(repo, `${repo}/%`, Math.floor(CUTOFF / 1000))
      .map(r => ({ title: scrub(r.title || r.first, 160), firstPrompt: scrub(r.first, 240), at: new Date(r.at * 1000).toISOString(), branch: r.branch }))
      .filter(meaningful).slice(0, 8);
  } catch { return []; }
}

function ghToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

function repos(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    // A root is a project only if it isn't $HOME (a dotfiles repo in the home directory is not a product).
    if (root !== HOME && existsSync(join(root, ".git"))) found.push(root);
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const p = join(root, name);
      try { if (existsSync(join(p, ".git"))) found.push(p); } catch { /* unreadable */ }
    }
  }
  return [...new Set(found)];
}

async function collect() {
  const token = ghToken();
  if (!token) say("gh is not signed in and GITHUB_TOKEN is unset: skipping GitHub (the Worker can still refresh it with its own token).");
  const projects = [];
  for (const path of repos()) {
    const last = git(path, "log", "-1", "--format=%cI");
    const claude = claudeSessions(path), codex = codexSessions(path);
    const dirty = (git(path, "status", "--porcelain")?.split("\n").filter(Boolean).length) ?? 0;
    const recent = last && Date.parse(last) >= CUTOFF;
    if (!recent && !claude.length && !codex.length) continue;
    const remote = git(path, "remote", "get-url", "origin");
    const repo = repoSlug(remote);
    // Name a project after its repository, so several checkouts of one repo share a name.
    const name = repo ? repo.split("/")[1] : path.split("/").pop()!;
    const counts = git(path, "rev-list", "--left-right", "--count", "@{u}...HEAD")?.split(/\s+/).map(Number);
    const commits = (git(path, "log", "-5", "--format=%h%x09%cI%x09%s") ?? "").split("\n").filter(Boolean).map(l => {
      const [sha, at, ...subject] = l.split("\t");
      return { sha: sha.slice(0, 12), at, subject: scrub(subject.join("\t"), 200) };
    });
    let github: GithubSignal | undefined;
    if (repo && token) {
      try { github = await repoState(repo, token); } catch (e) { say(`GitHub ${repo}: ${e instanceof Error ? e.message : e}`); }
    }
    projects.push({
      key: repo ? repo.split("/")[1] : name, name, repo,
      git: { path: path.replace(HOME, "~"), branch: git(path, "branch", "--show-current") || null, dirty, ahead: counts?.[1] ?? null, behind: counts?.[0] ?? null, lastCommitAt: last, commits },
      ...(github ? { github } : {}),
      claude, codex,
    });
  }
  return { machine: MACHINE, projects };
}

async function send(payload: Awaited<ReturnType<typeof collect>>) {
  if (!TOKEN) throw new Error("Set COMPASS_SYNC_TOKEN (add \"Sync:<token>\" to the Worker's COMPASS_AGENTS and this token to ~/.config/archymedes/compass-agents.env).");
  // The Worker accepts 64 KB per request: split by project.
  const batches: typeof payload.projects[] = [[]];
  for (const p of payload.projects) {
    const cur = batches.at(-1)!;
    if (cur.length && JSON.stringify({ machine: payload.machine, projects: [...cur, p] }).length > 56_000) batches.push([p]); else cur.push(p);
  }
  for (const projects of batches) {
    const res = await fetch(`${URL_BASE}/api/context`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ machine: payload.machine, projects }), signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({})) as { error?: string; projects?: number; created?: string[] };
    if (!res.ok) throw new Error(`Compass returned HTTP ${res.status}: ${body.error ?? "no detail"}`);
    say(`Sent ${projects.length} project(s)${body.created?.length ? `; new in Compass: ${body.created.join(", ")}` : ""}.`);
  }
}

const payload = await collect();
if (DRY) { console.log(JSON.stringify(payload, null, 2)); process.exit(0); }
const stateDir = join(HOME, ".cache/compass-sync"), stateFile = join(stateDir, "last.json");
const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex");
const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) as { digest: string; at: string } : null;
if (!FORCE && previous?.digest === digest && Date.now() - Date.parse(previous.at) < 6 * 3_600_000) { say("Nothing changed since the last send."); process.exit(0); }
try {
  await send(payload);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ digest, at: new Date().toISOString() }));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
