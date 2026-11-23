// The store. The same SQL runs on bun:sqlite locally (src/local.ts) and on a Durable Object's SQLite in Cloudflare
// (worker/index.ts, through src/do-sqlite.ts). Every answer the team gives is kept as a row with who and when:
// this is the outcome data only Archymedes holds (defensibility audit, moat 1), exportable from /api/export.

/** The part of bun:sqlite's Database Compass uses; DoDatabase implements the same. */
export interface DB {
  exec(sql: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string): { get(...a: unknown[]): T | null; all(...a: unknown[]): T[]; run(...a: unknown[]): unknown };
  transaction<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R;
}

export let db: DB;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_attempts (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, at TEXT NOT NULL, reserved_usd REAL NOT NULL, reported_usd REAL
);
CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY, who TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT,
  context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES conversation_threads(id), who TEXT NOT NULL,
  source TEXT NOT NULL, source_id TEXT UNIQUE, text TEXT NOT NULL, at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  lease_until TEXT, response TEXT, changes TEXT NOT NULL DEFAULT '[]', error TEXT,
  reserved_usd REAL NOT NULL DEFAULT 0, reported_usd REAL,
  reply_sent_at TEXT, reply_attempts INTEGER NOT NULL DEFAULT 0, reply_next_at TEXT, email_message_id TEXT
);
CREATE INDEX IF NOT EXISTS conversation_queue ON conversation_messages(status, available_at);
CREATE TABLE IF NOT EXISTS oauth_records (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_records_expiry ON oauth_records(expires);
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, model TEXT NOT NULL,
  context_hash TEXT, result TEXT, evidence TEXT NOT NULL DEFAULT '[]', error TEXT,
  reserved_usd REAL NOT NULL, reported_usd REAL, billing_complete INTEGER NOT NULL DEFAULT 0, usage TEXT, accepted TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS automation_runs_at ON automation_runs(at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', owner TEXT, track TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'open', dims TEXT, judge TEXT NOT NULL DEFAULT 'pending', judge_error TEXT, judged_at TEXT,
  created_by TEXT, created_at TEXT NOT NULL, started_at TEXT, done_at TEXT
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, dim TEXT NOT NULL,
  level INTEGER NOT NULL, who TEXT, note TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS debriefs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, who TEXT, at TEXT NOT NULL,
  result TEXT NOT NULL, effort INTEGER NOT NULL, defensibility INTEGER NOT NULL, quality INTEGER NOT NULL,
  asset TEXT, metric TEXT, surprise TEXT, lesson TEXT, predicted TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS followups (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, who TEXT, at TEXT NOT NULL,
  impact INTEGER NOT NULL, metric TEXT, notes TEXT, predicted_impact REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY, who TEXT NOT NULL, date TEXT NOT NULL, at TEXT NOT NULL,
  updates TEXT NOT NULL, learned TEXT, blocker TEXT, UNIQUE (who, date)
);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, value REAL NOT NULL, who TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT, who TEXT, at TEXT NOT NULL, payload TEXT
);
CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, who TEXT, at TEXT NOT NULL, PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, at TEXT NOT NULL,
  model TEXT NOT NULL, prompt_hash TEXT NOT NULL, dims TEXT NOT NULL, disagreement TEXT NOT NULL, tokens INTEGER
);
CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL, need TEXT NOT NULL,
  tried TEXT, status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  resolved_by TEXT, resolved_at TEXT, resolution TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', repos TEXT NOT NULL DEFAULT '[]',
  sites TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_signals (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source TEXT NOT NULL, key TEXT NOT NULL,
  payload TEXT NOT NULL, at TEXT NOT NULL, who TEXT, PRIMARY KEY (project_id, source, key)
);
CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, model TEXT NOT NULL, who TEXT,
  overview TEXT, assessments TEXT NOT NULL DEFAULT '[]', error TEXT, reserved_usd REAL NOT NULL, reported_usd REAL, usage TEXT
);
CREATE TABLE IF NOT EXISTS scan_candidates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT, title TEXT NOT NULL, detail TEXT NOT NULL, done_when TEXT NOT NULL,
  steps TEXT NOT NULL, track TEXT NOT NULL, lane TEXT NOT NULL, why TEXT NOT NULL, evidence TEXT NOT NULL,
  judgment TEXT, judge_error TEXT, rank INTEGER, of_total INTEGER, value REAL, p_top REAL, rank_lo INTEGER, rank_hi INTEGER, ei REAL, bold INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed', task_id TEXT, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_candidates_status ON scan_candidates(status, created_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, who TEXT, at TEXT NOT NULL
);
`;

/** Columns added after the first deploy. ALTER fails if the column exists; that is the "already migrated" signal. */
const ADDED_COLUMNS = [
  "ALTER TABLE tasks ADD COLUMN judge_revision INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN forecast_snapshot TEXT",
  "ALTER TABLE tasks ADD COLUMN judged_brief_hash TEXT",
  "ALTER TABLE tasks ADD COLUMN done_when TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'",
  // v4: Orion's whole belief at the time of the outcome, for proper scoring and the temperature fit.
  "ALTER TABLE debriefs ADD COLUMN predicted_dist TEXT",
  "ALTER TABLE followups ADD COLUMN predicted_dist TEXT",
  // v5: two lanes (src/lanes.ts); a person's review of an agent's own debrief.
  "ALTER TABLE tasks ADD COLUMN lane TEXT NOT NULL DEFAULT 'team'",
  "ALTER TABLE debriefs ADD COLUMN review TEXT",
  "ALTER TABLE debriefs ADD COLUMN reviewed_by TEXT",
  "ALTER TABLE debriefs ADD COLUMN reviewed_at TEXT",
  // v6: projects (src/projects.ts). Null means company-wide work.
  "ALTER TABLE tasks ADD COLUMN project_id TEXT",
];

export function useDb(d: DB) {
  db = d;
  db.exec(SCHEMA);
  for (const sql of ADDED_COLUMNS) {
    try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
}

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID().slice(0, 8);
export function log(kind: string, who: string | null, taskId: string | null, payload?: unknown) {
  db.query("INSERT INTO events (kind, task_id, who, at, payload) VALUES (?, ?, ?, ?, ?)").run(kind, taskId, who, now(), payload === undefined ? null : JSON.stringify(payload));
}
