// Local seed: `bun run seed` fills an empty store and judges it with Jev inline.
import { openLocal } from "./local.ts";
import { db } from "./db.ts";
import { judgePending, setJudgeKey } from "./state.ts";
import { syncSeed } from "./seed-data.ts";

openLocal();
setJudgeKey(process.env.TYPESAFE_API_KEY);
const n = syncSeed();
console.log(n ? `Seeded ${n} tasks; Orion is judging them…` : "Store already has tasks; judging anything pending.");
await judgePending();
for (const r of db.query("SELECT title, judge, judge_error FROM tasks").all() as { title: string; judge: string; judge_error: string | null }[]) {
  console.log(`${r.judge.padEnd(7)} ${r.title}${r.judge_error ? `  (${r.judge_error})` : ""}`);
}
