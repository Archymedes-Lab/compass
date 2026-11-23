// The subset of bun:sqlite's Database that Compass uses, on a Durable Object's SQLite storage.
// Copied from archymedes-gtm deploy/worker/do-sqlite.ts (go.archymedes.xyz), where it is tested against bun:sqlite.
//
// Differences it absorbs:
// - Bindings: Durable Object SQL takes positional `?` only. `$name` / `:name` / `@name` placeholders are
//   rewritten to `?` (outside string literals) and filled from the object argument (bun's strict mode: keys
//   without the prefix). Booleans become 0/1, undefined becomes null.
// - PRAGMA: journal_mode / foreign_keys are managed by the platform and skipped; `PRAGMA user_version`
//   is kept in a one-row table so src/db.ts migrations run unchanged.
// - run() returns { changes, lastInsertRowid } from SQLite's changes() / last_insert_rowid().
// - transaction(fn) uses storage.transactionSync.
// Tested against bun:sqlite through the same interface in tests/do-sqlite.test.ts.

export interface SqlCursor { toArray(): Record<string, unknown>[] }
export interface SqlStorage { exec(query: string, ...bindings: unknown[]): SqlCursor }
export interface DoStorageLike { sql: SqlStorage; transactionSync<T>(fn: () => T): T }

type Binding = string | number | null | ArrayBuffer | Uint8Array;

function toBinding(v: unknown): Binding {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v;
  return JSON.stringify(v);
}

/** Rewrites named placeholders to `?` and returns their names in order (empty when positional only). */
export function rewrite(sql: string): { sql: string; names: string[] } {
  let out = "";
  const names: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if ((c === "$" || c === ":" || c === "@") && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))!;
      names.push(m[0]);
      out += "?";
      i += 1 + m[0].length;
      continue;
    }
    out += c;
    i++;
  }
  return { sql: out, names };
}

/** Splits a script into statements on semicolons outside string literals and comments. */
export function statements(script: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (c === "'" || c === '"') {
      const end = script.indexOf(c, i + 1);
      const stop = end === -1 ? script.length : end + 1;
      cur += script.slice(i, stop);
      i = stop - 1;
    } else if (c === "-" && script[i + 1] === "-") {
      const end = script.indexOf("\n", i);
      i = end === -1 ? script.length : end;
      cur += "\n";
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SKIPPED_PRAGMA = /^PRAGMA\s+(journal_mode|foreign_keys|synchronous|busy_timeout)\b/i;
const SET_VERSION = /^PRAGMA\s+user_version\s*=\s*(\d+)$/i;
const GET_VERSION = /^PRAGMA\s+user_version\s*$/i;

export class DoDatabase {
  constructor(private readonly storage: DoStorageLike) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS _compass_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
  }

  private version(): number {
    const row = this.storage.sql.exec(`SELECT value FROM _compass_meta WHERE key = 'user_version'`).toArray()[0];
    return row ? Number(row.value) : 0;
  }

  private run1(sql: string, args: unknown[]): Record<string, unknown>[] {
    const text = sql.trim().replace(/;+\s*$/, "");
    if (SKIPPED_PRAGMA.test(text)) return [];
    const set = SET_VERSION.exec(text);
    if (set) {
      this.storage.sql.exec(`INSERT INTO _compass_meta (key, value) VALUES ('user_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, Number(set[1]));
      return [];
    }
    if (GET_VERSION.test(text)) return [{ user_version: this.version() }];
    const { sql: q, names } = rewrite(text);
    let bindings: Binding[];
    const only = args[0];
    if (names.length && args.length === 1 && only && typeof only === "object" && !Array.isArray(only) && !(only instanceof Uint8Array)) {
      const o = only as Record<string, unknown>;
      bindings = names.map((n) => toBinding(n in o ? o[n] : o[`$${n}`] ?? o[`:${n}`] ?? o[`@${n}`]));
    } else {
      bindings = (args.length === 1 && Array.isArray(only) ? only : args).map(toBinding);
    }
    return this.storage.sql.exec(q, ...bindings).toArray();
  }

  exec(script: string): void {
    for (const st of statements(script)) this.run1(st, []);
  }

  query<T = Record<string, unknown>, _P = unknown>(sql: string) {
    return {
      get: (...args: unknown[]): T | null => (this.run1(sql, args)[0] as T | undefined) ?? null,
      all: (...args: unknown[]): T[] => this.run1(sql, args) as T[],
      run: (...args: unknown[]) => {
        this.run1(sql, args);
        const r = this.storage.sql.exec(`SELECT changes() AS changes, last_insert_rowid() AS id`).toArray()[0] ?? {};
        return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.id ?? 0) };
      },
      values: (...args: unknown[]) => this.run1(sql, args).map((r) => Object.values(r)),
    };
  }

  prepare<T = Record<string, unknown>, P = unknown>(sql: string) { return this.query<T, P>(sql); }

  transaction<A extends unknown[], R>(fn: (...a: A) => R) {
    return (...a: A): R => this.storage.transactionSync(() => fn(...a));
  }

  close(): void {}
}
