// The Worker's store: Compass's schema and queries through DoDatabase, backed here by bun:sqlite standing in for
// Durable Object SQL storage (positional exec + toArray, transactionSync).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DoDatabase } from "../src/do-sqlite.ts";
import { useDb, db, type DB } from "../src/db.ts";

test("schema and a task round-trip through the DO adapter", () => {
  const raw = new Database(":memory:");
  const storage = {
    sql: { exec: (q: string, ...b: unknown[]) => ({ toArray: () => raw.query(q).all(...(b as never[])) as Record<string, unknown>[] }) },
    transactionSync: <T,>(fn: () => T) => raw.transaction(fn)(),
  };
  useDb(new DoDatabase(storage) as unknown as DB);
  db.query("INSERT INTO tasks (id, title, created_at) VALUES (?, ?, ?)").run("t1", "Sign the release", "2026-11-09");
  db.transaction(() => db.query("UPDATE tasks SET status = ? WHERE id = ?").run("done", "t1"))();
  expect(db.query("SELECT id, status, judge FROM tasks").all()).toEqual([{ id: "t1", status: "done", judge: "pending" }]);
  expect(db.query("SELECT COUNT(*) n FROM settings").get()).toEqual({ n: 0 });
});
