// Local store on bun:sqlite (dev server, seed, tests). COMPASS_DB=":memory:" for tests.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { useDb, type DB } from "./db.ts";

export function openLocal() {
  const path = process.env.COMPASS_DB ?? new URL("../data/compass.db", import.meta.url).pathname;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const d = new Database(path, { create: true, strict: true });
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  useDb(d as unknown as DB);
}
