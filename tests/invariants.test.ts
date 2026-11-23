// System invariants: properties that must hold for every input, checked over many seeded random cases.
// A failure prints the seed; re-run one case with INVARIANT_SEED=<seed> bun test tests/invariants.test.ts.
//
//   Privacy     nothing secret-shaped survives scrubbing or reaches storage; payloads are strict
//   Ingest      re-sending the same context changes nothing; one project per repository; archived stays quiet
//   Authority   no agent token can perform a person's action, and a refused request changes nothing
//   Proposals   only known projects, no duplicates of live work, bounded count; rank = 1 + #valued higher
//   Decisions   a proposal is decided at most once; adoption keeps its judgment (exactly one forecast)
//   Spend       a scan never starts past the daily allowance; one scan at a time
//   Email       at most one email per person per day under any interleaving; delivered when it can be
//   Content     a founder's list holds only live team work that is theirs or unclaimed; HTML is escaped
//   Attention   sorted by severity; outages are high; paused/archived projects raise nothing
process.env.COMPASS_DB = ":memory:";
import { describe, expect, test } from "bun:test";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { db } = await import("../src/db.ts");
const { createHandler } = await import("../src/api.ts");
const { onJudgeQueued, addTask, setStatus, buildState } = await import("../src/state.ts");
const P = await import("../src/projects.ts");
const S = await import("../src/scan.ts");
const E = await import("../src/email.ts");
const { setAutomationConfig } = await import("../src/automation-store.ts");
const V = await import("../src/value.ts");
const G = await import("../src/game.ts");
const { rng } = V;
const { DIMS } = await import("../src/dims.ts");
onJudgeQueued(() => {});

// ------------------------------------------------------------------------------------------- generators
type R = () => number;
const CASES = Number(process.env.INVARIANT_CASES ?? 60);
const seeds = () => process.env.INVARIANT_SEED ? [Number(process.env.INVARIANT_SEED)] : Array.from({ length: CASES }, (_, i) => 1000 + i);
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chars = (r: R, alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64 = ALNUM + "-_";
const WORDS = ["fix", "the", "release", "pipeline", "for", "argus", "add", "export", "check", "orion", "phone", "relay", "install", "price", "<b>", "\"quoted\"", "naïve", "日本", "—", "&amp;", "it's", "(see", "notes)", "v1.2.3"];
const prose = (r: R, n = int(r, 0, 12)) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");
async function forAll(name: string, body: (r: R, seed: number) => void | Promise<void>) {
  for (const seed of seeds()) {
    try { await body(rng(seed), seed); }
    catch (e) { throw new Error(`${name} failed for INVARIANT_SEED=${seed}: ${e instanceof Error ? e.message : e}`); }
  }
}

/** Secrets as real providers issue them, including ones a careless prompt or commit message might carry. */
const SECRET_MAKERS: ((r: R) => string)[] = [
  r => `sk-or-v1-${chars(r, "0123456789abcdef", 64)}`,
  r => `sk-ant-api03-${chars(r, B64, 40)}`,
  r => `sk-proj-${chars(r, B64, 30)}`,
  r => `sk_live_${chars(r, ALNUM, 24)}`,
  r => `rk_test_${chars(r, ALNUM, 24)}`,
  r => `whsec_${chars(r, ALNUM, 32)}`,
  r => `re_${chars(r, ALNUM, 8)}_${chars(r, ALNUM, 24)}`,
  r => `polar_oat_${chars(r, ALNUM, 30)}`,
  r => `ghp_${chars(r, ALNUM, 36)}`,
  r => `gho_${chars(r, ALNUM, 36)}`,
  r => `github_pat_${chars(r, ALNUM, 22)}_${chars(r, ALNUM, 40)}`,
  r => `AKIA${chars(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)}`,
  r => `xoxb-${chars(r, "0123456789", 12)}-${chars(r, ALNUM, 24)}`,
  r => `AIza${chars(r, B64, 35)}`,
  r => `eyJ${chars(r, B64, 20)}.${chars(r, B64, 30)}.${chars(r, B64, 25)}`,
  r => `${chars(r, "abcdefghij", 6)}.${chars(r, "klmnop", 4)}@${pick(r, ["gmail.com", "archymedes.xyz", "hubfly.space", "example.co.rw"])}`,
  r => `-----BEGIN OPENSSH PRIVATE KEY-----\n${chars(r, B64, 70)}\n-----END OPENSSH PRIVATE KEY-----`,
];
const SECRET_FRAMES = [(s: string) => s, (s: string) => `"${s}"`, (s: string) => `key=${s}`, (s: string) => `Authorization: Bearer ${s}`, (s: string) => `(${s})`, (s: string) => `https://api.example.com/v1?token=${s}&x=1`, (s: string) => `${s}.`, (s: string) => `\n${s}\n`];
/** Leak check: no 12-character window of the secret's high-entropy part may survive. */
const leaks = (out: string, secret: string) => {
  const core = secret.replace(/^-----BEGIN [A-Z ]+-----\n|\n-----END [A-Z ]+-----$/g, "");
  for (let i = 0; i + 12 <= core.length; i++) if (out.includes(core.slice(i, i + 12))) return core.slice(i, i + 12);
  return null;
};
const embed = (r: R) => {
  const secrets = Array.from({ length: int(r, 1, 3) }, () => pick(r, SECRET_MAKERS)(r));
  const text = [prose(r), ...secrets.flatMap(s => [pick(r, SECRET_FRAMES)(s), prose(r)])].join(" ");
  return { text, secrets };
};

// ------------------------------------------------------------------------------------------- fixtures
const TABLES = ["scan_candidates", "scan_runs", "project_signals", "projects", "links", "answers", "debriefs", "followups", "forecasts", "interventions", "checkins", "metrics", "tasks", "events", "settings"];
const reset = () => { for (const t of TABLES) db.exec(`DELETE FROM ${t}`); };
const snapshot = (skip: string[] = []) => JSON.stringify(TABLES.filter(t => !skip.includes(t)).map(t => db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const peaked = (r: R) => { const k = int(r, 0, 4); const p = [0, 1, 2, 3, 4].map(i => (i === k ? 0.6 : 0.1)); return p; };
const randomDims = (r: R) => Object.fromEntries(DIMS.map(d => [d, peaked(r)]));
const judgment = (r: R) => ({ dims: randomDims(r), model: "jev-test", promptHash: "h", disagreement: Object.fromEntries(DIMS.map(d => [d, 0])), tokens: 1 });
const DAY = "2026-11-18";
const at = (h: number, m = 0, day = DAY) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
const REPOS = ["Archymedes-Lab/orion", "Archymedes-Lab/compass", "Archymedes-Lab/archymedes-cli", "chrisnkuno/JARVIS", "Archymedes-Lab/sage"];
const session = (r: R) => ({ title: prose(r, int(r, 2, 6)) || "work", firstPrompt: embed(r).text, at: at(int(r, 0, 23)).toISOString(), branch: pick(r, [null, "main", "feat/x"]) });
const contextPayload = (r: R) => ({
  machine: pick(r, ["laptop", "DESKTOP-9JDP8BV", "server-1"]),
  projects: Array.from({ length: int(r, 1, 5) }, () => {
    const repo = r() < 0.8 ? pick(r, REPOS) : null;
    const key = repo ? (r() < 0.5 ? repo.split("/")[1] : `${repo.split("/")[1]}-${chars(r, "abc", 3)}`) : `local-${chars(r, "xyz", 3)}`;
    return {
      key, name: key, repo,
      git: { path: `~/${key}`, branch: pick(r, [null, "main", "seo/x", "feat/y"]), dirty: int(r, 0, 200), ahead: pick(r, [null, 0, int(r, 1, 9)]), behind: pick(r, [null, 0, 2]), lastCommitAt: at(int(r, 0, 23), 0, pick(r, ["2026-11-01", "2026-11-15", DAY])).toISOString(), commits: Array.from({ length: int(r, 0, 5) }, () => ({ sha: chars(r, "0123456789abcdef", 7), at: at(1).toISOString(), subject: embed(r).text })) },
      claude: Array.from({ length: int(r, 0, 3) }, () => session(r)),
      codex: Array.from({ length: int(r, 0, 3) }, () => session(r)),
    };
  }),
});

// ------------------------------------------------------------------------------------------- privacy
describe("privacy", () => {
  test("no secret survives scrub, in any frame, at any length limit", () => forAll("scrub", r => {
    const { text, secrets } = embed(r);
    const max = pick(r, [80, 160, 240, 1500]);
    const out = P.scrub(text, max);
    expect(out.length).toBeLessThanOrEqual(max);
    for (const s of secrets) expect(leaks(out, s)).toBeNull();
  }));

  test("scrub is idempotent", () => forAll("idempotent", r => {
    const once = P.scrub(embed(r).text, 240);
    expect(P.scrub(once, 240)).toBe(once);
  }));

  test("nothing secret-shaped reaches the database through context ingest", () => forAll("ingest-privacy", r => {
    reset();
    const payload = contextPayload(r);
    const secrets: string[] = [];
    // Plant secrets in every free-text field a collector sends.
    for (const p of payload.projects) {
      for (const c of p.git.commits) { const e = embed(r); c.subject = e.text; secrets.push(...e.secrets); }
      for (const s of [...p.claude, ...p.codex]) { const a = embed(r), b = embed(r); s.firstPrompt = a.text; s.title = b.text.slice(0, 300); secrets.push(...a.secrets, ...b.secrets); }
    }
    P.ingestContext(payload, "Sync (agent)");
    const stored = db.query<{ payload: string }>("SELECT payload FROM project_signals").all().map(x => x.payload).join("\n");
    for (const s of secrets) expect(leaks(stored, s)).toBeNull();
  }));

  test("an unexpected field anywhere in a payload is rejected and stores nothing", () => forAll("strict", r => {
    reset();
    const payload = contextPayload(r) as any;
    const p = payload.projects[0];
    const target = pick(r, [payload, p, p.git, ...(p.claude.length ? [p.claude[0]] : []), ...(p.git.commits.length ? [p.git.commits[0]] : [])]);
    target[pick(r, ["transcript", "diff", "content", "messages", "env"])] = "everything the user typed";
    const before = snapshot();
    expect(() => P.ingestContext(payload, "Sync (agent)")).toThrow();
    expect(snapshot()).toBe(before);
  }));
});

// ------------------------------------------------------------------------------------------- ingest
describe("ingest", () => {
  test("re-sending the same context is a no-op for projects and signal content", () => forAll("idempotent-ingest", r => {
    reset();
    const payload = contextPayload(r);
    P.ingestContext(payload, "Sync (agent)");
    const rows = () => JSON.stringify([db.query("SELECT id, name, repos, status FROM projects ORDER BY id").all(), db.query("SELECT project_id, source, key, payload FROM project_signals ORDER BY project_id, source, key").all()]);
    const first = rows();
    P.ingestContext(structuredClone(payload), "Sync (agent)");
    expect(rows()).toBe(first);
  }));

  test("each repository belongs to exactly one project, whatever the keys and order", () => forAll("one-project-per-repo", r => {
    reset();
    for (let i = int(r, 1, 4); i > 0; i--) P.ingestContext(contextPayload(r), "Sync (agent)");
    const owners = new Map<string, number>();
    for (const p of P.allProjects()) for (const repo of JSON.parse(p.repos) as string[]) owners.set(repo.toLowerCase(), (owners.get(repo.toLowerCase()) ?? 0) + 1);
    for (const [, n] of owners) expect(n).toBe(1);
  }));

  test("an archived project receives no new context and raises no attention", () => forAll("archived", r => {
    reset();
    const payload = contextPayload(r);
    P.ingestContext(payload, "Sync (agent)");
    const victim = pick(r, P.allProjects());
    P.updateProject(victim.id, { status: "archived" }, "Chris");
    const before = db.query("SELECT * FROM project_signals WHERE project_id = ? ORDER BY source, key").all(victim.id);
    P.ingestContext(contextPayload(r), "Sync (agent)");
    P.ingestContext(payload, "Sync (agent)");
    expect(db.query("SELECT * FROM project_signals WHERE project_id = ? ORDER BY source, key").all(victim.id)).toEqual(before);
    expect(P.projectOverview(at(9)).find(p => p.id === victim.id)!.attention).toEqual([]);
  }));
});

// ------------------------------------------------------------------------------------------- authority
describe("authority", () => {
  const TOKEN = "agent-token-0123456789abcdefghijklmnopqrstuvwxyz";
  const handle = createHandler({ users: "Chris:alpha beta,Alex:gamma delta", sessionKey: "test-session-key-0123456789", agents: `Codex:${TOKEN},Sync:${TOKEN.replace("agent", "synca")}` });
  const PEOPLE_ONLY: [string, string, (r: R) => unknown][] = [
    ["POST", "/api/projects", r => ({ name: prose(r, 2) || "x" })],
    ["PATCH", "/api/projects/PROJECT", r => ({ status: pick(r, ["paused", "archived"]) })],
    ["PUT", "/api/scan", () => ({ enabled: true, hourUtc: 1, dailyBudgetUsd: 2, guidance: "" })],
    ["POST", "/api/scan/run", () => ({})],
    ["POST", "/api/scan/candidates/CANDIDATE/adopt", () => ({})],
    ["POST", "/api/scan/candidates/CANDIDATE/dismiss", () => ({})],
    ["PUT", "/api/digest", () => ({ enabled: true, sendHourUtc: 0, recipients: { Chris: "attacker@example.com" } })],
    ["POST", "/api/digest/send", () => ({})],
    ["GET", "/api/digest", () => undefined],
    ["GET", "/api/digest/preview", () => undefined],
    ["PUT", "/api/brief", r => ({ text: prose(r, 30) + " ".repeat(40) })],
    ["PUT", "/api/automation", () => ({})],
    ["POST", "/api/metrics", () => ({ name: "Paying Argus customers", value: 999 })],
    ["GET", "/api/export", () => undefined],
  ];
  test("no agent token performs a person's action, and the refusal changes nothing", () => forAll("authority", async r => {
    reset();
    P.ingestContext(contextPayload(r), "Sync (agent)");
    db.query("INSERT INTO scan_candidates (id, run_id, project_id, title, detail, done_when, steps, track, lane, why, evidence, created_at) VALUES ('c1', 'r', NULL, 't', 'd', 'w', '[]', 'quality', 'team', 'y', '[]', ?)").run(at(1).toISOString());
    const [method, path, body] = pick(r, PEOPLE_ONLY);
    const url = path.replace("PROJECT", P.allProjects()[0].id).replace("CANDIDATE", "c1");
    const token = pick(r, [TOKEN, TOKEN.replace("agent", "synca")]);
    const b = body(r);
    const before = snapshot(["events"]);
    const res = await handle(new Request(`https://compass.test${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(b === undefined ? {} : { "content-type": "application/json" }) }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }));
    expect(res.status).toBe(403);
    expect(snapshot(["events"])).toBe(before);
  }));
});

// ------------------------------------------------------------------------------------------- proposals
describe("scan proposals", () => {
  setAutomationConfig({ openrouterKey: "or-test-key", exaKey: "exa", enabled: false });
  const TRACKS = ["revenue", "quality", "trust", "distribution"];
  const lunaFor = (out: unknown) => (async () => Response.json({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: "stop" }], usage: { cost: 0.01 } })) as unknown as typeof fetch;
  const setup = (r: R) => {
    reset();
    S.updateScanSettings({ enabled: true, hourUtc: 0, dailyBudgetUsd: 2, guidance: "" }, "Chris");
    const projects = Array.from({ length: int(r, 1, 4) }, (_, i) => P.createProject({ name: `p${i}-${chars(r, "abc", 2)}` }, "Chris"));
    const live = Array.from({ length: int(r, 0, 10) }, (_, i) => {
      const id = addTask({ title: `Live task ${i}`, who: "Chris", lane: pick(r, ["team", "agent"] as const), projectId: pick(r, [null, ...projects]) });
      db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(JSON.stringify(randomDims(r)), id);
      return id;
    });
    // Some "boosts" links among live work, so passed-on value matters too (no unblocks: nothing waits).
    for (let k = int(r, 0, 3); k > 0 && live.length > 1; k--) {
      const [a, b] = [pick(r, live), pick(r, live)];
      if (a < b) db.query("INSERT OR IGNORE INTO links (from_id, to_id, kind, who, at) VALUES (?, ?, 'boosts', 'Chris', ?)").run(a, b, at(1).toISOString());
    }
    return { projects, live };
  };
  const lunaOutput = (r: R, projects: string[]) => ({
    overview: prose(r, 6) || "overview",
    projects: Array.from({ length: int(r, 1, 5) }, () => ({
      projectId: r() < 0.8 ? pick(r, projects) : `invented-${chars(r, "xyz", 3)}`,
      assessment: prose(r, 5),
      candidates: Array.from({ length: int(r, 0, 3) }, () => ({
        title: r() < 0.25 ? `Live task ${int(r, 0, 9)}` : r() < 0.2 ? "Repeated idea" : `Idea ${chars(r, ALNUM, 6)}`,
        detail: prose(r), doneWhen: "observable test passes", steps: [prose(r, 3)].filter(Boolean), track: pick(r, TRACKS), lane: pick(r, ["team", "agent"]), why: prose(r, 4) || "why", evidence: [],
      })),
    })),
  });

  test("only known projects, no duplicates of live work or each other, at most MAX_CANDIDATES", () => forAll("proposal-shape", async r => {
    const { projects } = setup(r);
    await S.runScan({ fetch: lunaFor(lunaOutput(r, projects)), judgeTask: (async () => judgment(r)) as never, clock: () => at(5) });
    const props = S.scanStatus(at(5)).proposals;
    expect(props.length).toBeLessThanOrEqual(S.MAX_CANDIDATES);
    expect(props.every(c => c.projectId && projects.includes(c.projectId))).toBe(true);
    const titles = props.map(c => c.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
    const liveTitles = new Set(db.query<{ title: string }>("SELECT title FROM tasks WHERE status IN ('open','doing')").all().map(t => t.title.toLowerCase()));
    expect(titles.some(t => liveTitles.has(t))).toBe(false);
  }));

  test("a proposal's rank is 1 + the number of live tasks and proposals Orion values more", () => forAll("rank-consistency", async r => {
    const { projects } = setup(r);
    await S.runScan({ fetch: lunaFor(lunaOutput(r, projects)), judgeTask: (async () => judgment(r)) as never, clock: () => at(5) });
    const props = S.scanStatus(at(5)).proposals.filter(c => c.judged);
    const live = buildState(null, false, at(5)).list.map(t => t.row.value);
    const values = [...live, ...props.map(c => c.value!)];
    const bolds = props.filter(c => c.bold).length;
    expect(bolds).toBeLessThanOrEqual(1);
    for (const c of props) {
      expect(c.ofTotal).toBe(live.length + props.length);
      const higher = values.filter(v => v > c.value! + 1e-6).length, tiedOrHigher = values.filter(v => v >= c.value! - 1e-6).length;
      expect(c.rank!).toBeGreaterThanOrEqual(higher + 1);
      expect(c.rank!).toBeLessThanOrEqual(tiedOrHigher);
      expect(c.pTop5!).toBeGreaterThanOrEqual(0); expect(c.pTop5!).toBeLessThanOrEqual(1);
      expect(c.rankRange![0]).toBeLessThanOrEqual(c.rankRange![1]);
    }
  }));

  test("any sequence of adopt/dismiss decides each proposal once; adoption keeps one judgment", () => forAll("decide-once", async r => {
    const { projects } = setup(r);
    await S.runScan({ fetch: lunaFor(lunaOutput(r, projects)), judgeTask: (async () => judgment(r)) as never, clock: () => at(5) });
    const props = S.scanStatus(at(5)).proposals;
    const outcomes = new Map<string, string>();
    for (let i = int(r, 0, 12); i > 0 && props.length; i--) {
      const c = pick(r, props), op = pick(r, ["adopt", "adopt-other", "dismiss"]);
      try {
        if (op === "dismiss") S.dismissCandidate(c.id, "Chris");
        else S.adoptCandidate(c.id, pick(r, ["Chris", "Alex"]), op === "adopt-other" ? (c.lane === "agent" ? "team" : "agent") : undefined);
        expect(outcomes.has(c.id)).toBe(false);
        outcomes.set(c.id, op);
      } catch { expect(outcomes.has(c.id)).toBe(true); }
    }
    for (const [id, op] of outcomes) {
      const row = db.query<{ status: string; task_id: string | null }>("SELECT status, task_id FROM scan_candidates WHERE id = ?").get(id)!;
      if (op === "dismiss") { expect(row).toEqual({ status: "dismissed", task_id: null }); continue; }
      expect(row.status).toBe("adopted");
      const task = db.query<{ judge: string }>("SELECT judge FROM tasks WHERE id = ?").get(row.task_id)!;
      const judged = props.find(c => c.id === id)!.judged;
      expect(task.judge).toBe(judged ? "jev" : "pending");
      expect(db.query<{ n: number }>("SELECT COUNT(*) n FROM forecasts WHERE task_id = ?").get(row.task_id)!.n).toBe(judged ? 1 : 0);
    }
  }));

  test("scans never start past the daily allowance, and never run two at once", () => forAll("spend", async r => {
    reset();
    P.createProject({ name: "Only" }, "Chris");
    const budget = pick(r, [0.03, 0.05, 0.1, 0.25]);
    S.updateScanSettings({ enabled: true, hourUtc: 0, dailyBudgetUsd: budget, guidance: "" }, "Chris");
    let inFlight = 0, maxInFlight = 0;
    const slowLuna = (async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(res => setTimeout(res, 0));
      inFlight--;
      if (r() < 0.3) return new Response("down", { status: 502 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ overview: "o", projects: [] }) }, finish_reason: "stop" }], usage: { cost: pick(r, [0.004, 0.01, 0.029]) } });
    }) as unknown as typeof fetch;
    const attempts = int(r, 1, 12);
    await Promise.all(Array.from({ length: attempts }, (_, i) => S.runScan({ fetch: slowLuna, clock: () => at(int(r, 0, 23), i) }).catch(() => null)));
    for (let i = 0; i < attempts; i++) await S.runScan({ fetch: slowLuna, clock: () => at(int(r, 0, 23), i) }).catch(() => null);
    expect(maxInFlight).toBeLessThanOrEqual(1);
    const runs = db.query<{ n: number }>("SELECT COUNT(*) n FROM scan_runs WHERE substr(at, 1, 10) = ?").get(DAY)!.n;
    expect(runs).toBeLessThanOrEqual(Math.floor(budget / S.SCAN_RESERVATION_USD + 1e-9));
  }));
});

// ------------------------------------------------------------------------------------------- email
describe("daily email", () => {
  const TEAM = ["Chris", "Alex"];
  test("at most one email per person per day under any interleaving; sent whenever the provider allows", () => forAll("email-once", async r => {
    reset();
    E.setEmailConfig({ resendKey: "re_test_0123456789abcdef" });
    const hour = int(r, 0, 12);
    E.updateDigestSettings({ enabled: true, sendHourUtc: hour, recipients: { Chris: "c@example.test", Alex: r() < 0.7 ? "s@example.test" : "" } }, "Chris", TEAM);
    const delivered = new Map<string, number>();
    const days = ["2026-11-18", "2026-11-19", "2026-11-20"];
    const healthy = new Map(days.map(d => [d, r() < 0.6]));
    let currentDay = days[0];
    const provider = (async (_url: string, init: RequestInit) => {
      await new Promise(res => setTimeout(res, int(r, 0, 2)));
      if (!healthy.get(currentDay) && r() < 0.8) return new Response("bad gateway", { status: 502 });
      const to = JSON.parse(String(init.body)).to[0] as string;
      delivered.set(`${currentDay}:${to}`, (delivered.get(`${currentDay}:${to}`) ?? 0) + 1);
      return Response.json({ id: "e" });
    }) as unknown as typeof fetch;
    const lateTick = new Set<string>();
    for (const day of days) {
      currentDay = day;
      const ticks = Array.from({ length: int(r, 1, 6) }, () => at(int(r, 0, 23), int(r, 0, 59), day)).sort((a, b) => a.getTime() - b.getTime());
      for (const t of ticks) {
        if (t.getUTCHours() >= hour) lateTick.add(day);
        const parallel = int(r, 1, 3); // the alarm and the cron can fire together
        await Promise.all(Array.from({ length: parallel }, () => E.sendDigests({ fetch: provider, clock: t })));
      }
    }
    for (const [, n] of delivered) expect(n).toBe(1);
    // Liveness: on a healthy day with a tick after the hour, everyone with an address got their email.
    for (const day of days) if (healthy.get(day) && lateTick.has(day)) {
      expect(delivered.get(`${day}:c@example.test`)).toBe(1);
      if (E.digestSettings().recipients.Alex) expect(delivered.get(`${day}:s@example.test`)).toBe(1);
    }
    for (const s of Object.values(E.digestSent())) expect(s.attempts).toBeLessThanOrEqual(3);
  }));

  test("a founder's list holds only live team work that is theirs or unclaimed; HTML is escaped", () => forAll("email-content", r => {
    reset();
    const ids = Array.from({ length: int(r, 0, 12) }, (_, i) => {
      const id = addTask({ title: `T${i} ${pick(r, ["<script>alert(1)</script>", "a & b", "\"q\"", "plain"])}`, who: "Chris", owner: pick(r, [null, "Chris", "Alex"]), lane: pick(r, ["team", "agent"] as const) });
      db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(JSON.stringify(randomDims(r)), id);
      const status = pick(r, ["open", "open", "doing", "done", "dropped"] as const);
      if (status !== "open") setStatus(id, status, "Chris");
      return id;
    });
    const who = pick(r, TEAM);
    const d = E.buildDigest(who, at(9));
    const rows = db.query<{ title: string; owner: string | null; status: string; lane: string }>("SELECT title, owner, status, lane FROM tasks").all();
    const mine = d.sections.filter(s => s.title === "Your focus today" || s.title === "After that").flatMap(s => s.items);
    for (const item of mine) {
      const t = rows.find(x => item.includes(x.title));
      if (!t) continue; // the "nothing assigned" line
      expect(["open", "doing"]).toContain(t.status);
      expect(t.lane).toBe("team");
      expect(t.owner === who || t.owner === null).toBe(true);
    }
    expect(d.html).not.toMatch(/<script/i);
    expect(ids.length >= 0).toBe(true);
  }));
});

// ------------------------------------------------------------------------------------------- attention
describe("attention", () => {
  test("sorted by severity; outages are high; paused and archived projects raise nothing", () => forAll("attention", r => {
    reset();
    P.ingestContext(contextPayload(r), "Sync (agent)");
    for (const p of P.allProjects()) {
      if (r() < 0.5) db.query("INSERT INTO project_signals (project_id, source, key, payload, at) VALUES (?, 'site', ?, ?, ?)").run(p.id, `https://${p.id}.example`, JSON.stringify({ url: `https://${p.id}.example`, ok: r() < 0.5, status: pick(r, [0, 200, 503]), ms: int(r, 10, 9000), error: null }), at(8).toISOString());
      if (r() < 0.3) P.updateProject(p.id, { status: pick(r, ["paused", "archived"]) }, "Chris");
    }
    const RANK = { high: 0, medium: 1, low: 2 };
    for (const p of P.projectOverview(at(9))) {
      if (p.status !== "active") { expect(p.attention).toEqual([]); continue; }
      const sev = p.attention.map(a => RANK[a.severity]);
      expect(sev).toEqual([...sev].sort((a, b) => a - b));
      for (const a of p.attention) {
        if (a.kind === "site-down" || a.kind === "ci-failing") expect(a.severity).toBe("high");
        if (a.task) { expect(a.task.title.length).toBeGreaterThan(0); expect(a.task.title.length).toBeLessThanOrEqual(200); }
      }
      for (const s of p.siteChecks) if (!s.ok) expect(p.attention.some(a => a.kind === "site-down" && a.text.includes(s.url))).toBe(true);
    }
  }));
});

// ------------------------------------------------------------------------------------------- prime law: defensibility
describe("defensibility is the prime law", () => {
  const up = (p: number[]) => { const q = [...p]; for (let i = 4; i > 0; i--) { q[i] += q[i - 1] * 0.5; q[i - 1] *= 0.5; } return q; };

  test("no cost-of-delay term outweighs defensibility", () => {
    for (const [k, w] of Object.entries(V.COD_WEIGHT)) expect(V.COD_WEIGHT.defensibility).toBeGreaterThanOrEqual(w);
  });

  test("more defensibility never lowers value, the moat verdict, or the rank", () => forAll("monotone", r => {
    const items = Array.from({ length: int(r, 1, 8) }, (_, i) => ({ id: `t${i}`, dims: randomDims(r) as never }));
    const target = pick(r, items);
    const raised = { ...target, dims: { ...(target.dims as Record<string, number[]>), defensibility: up((target.dims as Record<string, number[]>).defensibility) } as never };
    expect(V.expectedOwn(raised.dims)).toBeGreaterThanOrEqual(V.expectedOwn(target.dims) - 1e-9);
    expect(V.moatVerdict(raised.dims)!.p).toBeGreaterThanOrEqual(V.moatVerdict(target.dims)!.p);
    const graph = { links: [], status: new Map(items.map(i => [i.id, "open"])) };
    const rankOf = (xs: typeof items) => V.order(xs.map(i => i.id), id => V.expectedOwn(xs.find(i => i.id === id)!.dims), () => false).indexOf(target.id);
    expect(rankOf(items.map(i => i.id === target.id ? raised : i))).toBeLessThanOrEqual(rankOf(items));
    void graph;
  }));

  test("a step of defensibility is worth at least a step of any other cost-of-delay term", () => forAll("prime", r => {
    const d = randomDims(r) as Record<string, number[]>;
    const gain = (k: string) => V.expectedOwn({ ...d, [k]: up(d[k]) } as never) - V.expectedOwn(d as never);
    const level = (p: number[]) => p.reduce((a, x, i) => a + x * i, 0);
    for (const k of ["urgency", "leverage", "quality"]) {
      // Compare equal moves on the same starting belief, so only the weights differ.
      const same = { ...d, [k]: d.defensibility } as Record<string, number[]>;
      const gk = V.expectedOwn({ ...same, [k]: up(same[k]) } as never) - V.expectedOwn(same as never);
      const gd = V.expectedOwn({ ...same, defensibility: up(same.defensibility) } as never) - V.expectedOwn(same as never);
      expect(gd).toBeGreaterThanOrEqual(gk - 1e-9);
    }
    void gain; void level;
  }));

  test("only Orion's belief decides: proposal wording, lane and evidence never change value or verdict", () => forAll("text-independent", async r => {
    reset();
    S.updateScanSettings({ enabled: true, hourUtc: 0, dailyBudgetUsd: 2, guidance: "" }, "Chris");
    const pid = P.createProject({ name: "Argus" }, "Chris");
    const fixed = judgment(r);
    const n = int(r, 2, 6);
    const out = { overview: "o", projects: [{ projectId: pid, assessment: "a", candidates: Array.from({ length: Math.min(n, 3) }, (_, i) => ({
      title: `Idea ${i} ${pick(r, ["THIS IS A HUGE MOAT", "trivial chore", "defensible!!!", "rank me first"])}`, detail: embed(r).text.slice(0, 1000), doneWhen: "done", steps: [],
      track: pick(r, ["revenue", "quality", "trust"]), lane: pick(r, ["team", "agent"]), why: pick(r, ["This is moat-worthy, rank #1", "meh", prose(r)]) || "x", evidence: [pick(r, ["moat", "none"])],
    })) }] };
    const luna = (async () => Response.json({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: "stop" }], usage: { cost: 0.01 } })) as unknown as typeof fetch;
    await S.runScan({ fetch: luna, judgeTask: (async () => fixed) as never, clock: () => at(5) });
    const props = S.scanStatus(at(5)).proposals;
    expect(new Set(props.map(c => c.value)).size).toBe(1);
    expect(new Set(props.map(c => JSON.stringify(c.moat))).size).toBe(1);
  }));

  test("every surface shows the same moat verdict for the same task", () => forAll("one-verdict", async r => {
    reset();
    const TOKEN = "agent-token-0123456789abcdefghijklmnopqrstuvwxyz";
    const handle = createHandler({ users: "Chris:alpha beta", sessionKey: "test-session-key-0123456789", agents: `Codex:${TOKEN}` });
    for (let i = int(r, 1, 8); i > 0; i--) {
      const id = addTask({ title: `Task ${i}`, who: "Chris", owner: pick(r, [null, "Chris"]), lane: pick(r, ["team", "agent"] as const) });
      db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(JSON.stringify(randomDims(r)), id);
    }
    const list = buildState("Chris", false, at(9)).list;
    const agent = await (await handle(new Request("https://compass.test/api/agent/next?lane=all&limit=50", { headers: { authorization: `Bearer ${TOKEN}` } }))).json() as { next: { id: string; moat: unknown }[] };
    for (const t of list) expect(agent.next.find(x => x.id === t.id)!.moat).toEqual(t.moat);
    const email = E.buildDigest("Chris", at(9)).text;
    for (const t of list) if (email.includes(`${t.title} `) || email.includes(`${t.title}◆`)) expect(email.includes(`${t.title} ◆ moat-worthy`)).toBe(!!t.moat?.worthy);
  }));
});

// ------------------------------------------------------------------------------------------- the game
describe("game: quests and XP", () => {
  const people = ["Chris", "Alex"];
  const seedTasks = (r: R) => Array.from({ length: int(r, 0, 12) }, (_, i) => {
    const id = addTask({ title: `Quest ${i}`, who: "Chris", owner: r() < 0.25 ? pick(r, [...people, null]) : null, lane: pick(r, ["team", "team", "agent"] as const) });
    db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(JSON.stringify(randomDims(r)), id);
    if (r() < 0.15) setStatus(id, pick(r, ["doing", "done", "dropped"] as const), "Chris");
    return id;
  });

  test("dealing never shares a quest, never overrides an owner, never re-deals a pass, and leaves no one idle", () => forAll("deal", r => {
    reset();
    const ids = seedTasks(r);
    const ownersBefore = new Map(db.query<{ id: string; owner: string | null }>("SELECT id, owner FROM tasks").all().map(t => [t.id, t.owner]));
    // Some recent passes.
    const passes = new Set<string>();
    for (const id of ids) if (r() < 0.2) { const w = pick(r, people); db.query("INSERT INTO events (kind, task_id, who, at, payload) VALUES ('quest.pass', ?, ?, ?, '{}')").run(id, w, at(1).toISOString()); passes.add(`${w}:${id}`); }
    const dealt = G.dealQuests(at(9), people);
    expect(new Set(dealt.map(d => d.taskId)).size).toBe(dealt.length);
    expect(new Set(dealt.map(d => d.who)).size).toBe(dealt.length);
    for (const d of dealt) {
      expect(ownersBefore.get(d.taskId)).toBeNull();
      expect(passes.has(`${d.who}:${d.taskId}`)).toBe(false);
    }
    // Liveness: anyone still idle had nothing dealable left.
    const st = buildState(null, false, at(9));
    for (const who of people) {
      const busy = st.list.some(t => t.lane === "team" && t.owner === who && (t.status === "open" || t.status === "doing"));
      if (busy) continue;
      const dealable = st.list.filter(t => t.lane === "team" && t.status === "open" && !t.owner && !t.row.blockedBy.length && !passes.has(`${who}:${t.id}`));
      expect(dealable.length).toBe(0);
    }
    // Idempotent: a second deal right away changes nothing.
    expect(G.dealQuests(at(9), people)).toEqual([]);
  }));

  test("quest XP comes from Orion's value, not the debrief's verdict; moat forging is exactly defensibility ≥ Clearly", () => forAll("xp-honest", r => {
    reset();
    const id = addTask({ title: "A quest", who: "Chris", owner: "Chris" });
    db.query("UPDATE tasks SET dims = ?, judge = 'jev' WHERE id = ?").run(JSON.stringify(randomDims(r)), id);
    setStatus(id, "done", "Chris");
    const defensibility = int(r, 0, 4);
    const debrief = (result: string) => db.query("INSERT OR REPLACE INTO debriefs (task_id, who, at, result, effort, defensibility, quality, predicted) VALUES (?, 'Chris', ?, ?, 2, ?, 2, '{}')").run(id, at(10).toISOString(), result, defensibility);
    debrief("much-worse");
    const low = G.xpEvents().filter(e => e.who === "Chris").reduce((a, e) => a + e.xp, 0);
    debrief(pick(r, ["much-better", "better", "as-expected"]));
    const high = G.xpEvents().filter(e => e.who === "Chris").reduce((a, e) => a + e.xp, 0);
    expect(high).toBe(low);
    expect(G.xpEvents().some(e => e.kind === "moat")).toBe(defensibility >= 3);
    // Marking it done again can't farm XP.
    setStatus(id, "open", "Chris"); setStatus(id, "done", "Chris");
    expect(G.xpEvents().filter(e => e.kind === "quest")).toHaveLength(1);
  }));

  test("XP never goes down as the company plays on, and levels follow XP", () => forAll("xp-monotone", r => {
    reset();
    let last = new Map<string, number>();
    for (let step = int(r, 1, 15); step > 0; step--) {
      const who = pick(r, people);
      const move = pick(r, ["checkin", "metric", "answer", "quest"]);
      if (move === "checkin") db.query("INSERT OR IGNORE INTO checkins (who, date, at, updates) VALUES (?, ?, ?, '{}')").run(who, `2026-11-${String(int(r, 1, 18)).padStart(2, "0")}`, at(8).toISOString());
      if (move === "metric") db.query("INSERT INTO metrics (name, value, who, at) VALUES ('Paying Argus customers', ?, ?, ?)").run(int(r, 0, 9), who, at(8).toISOString());
      if (move === "quest") { const id = addTask({ title: `Q${step}`, who, owner: who }); setStatus(id, "done", who); }
      if (move === "answer") { const id = addTask({ title: `A${step}`, who }); db.query("INSERT INTO answers (task_id, dim, level, who, at) VALUES (?, 'impact', 2, ?, ?)").run(id, who, at(8).toISOString()); }
      const g = G.gameState(at(9), people);
      for (const p of g.players) {
        expect(p.xp).toBeGreaterThanOrEqual(last.get(p.who) ?? 0);
        expect(p.level).toBe(G.levelOf(p.xp));
        expect(p.xp).toBeGreaterThanOrEqual(p.levelFloor); expect(p.xp).toBeLessThan(p.levelCeil);
      }
      last = new Map(g.players.map(p => [p.who, p.xp]));
    }
  }));
});
