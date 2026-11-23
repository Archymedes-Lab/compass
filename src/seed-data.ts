// Starting list: an example for a small software product before its first paying customer. Replace it with your own.
// Every task has a test for "done" and a few steps. A store nobody has touched yet is re-seeded when the version
// rises; once anyone answers, checks in or edits, the list is theirs and is never replaced.
import { db, log, now } from "./db.ts";
import { addTask } from "./state.ts";
import type { LinkKind } from "./flow.ts";

export const SEED_VERSION = 4;

/** `feeds`: the tasks this one fuels, by key, and how ("unblocks" = they can't finish without it; "boosts" = it makes them
 * more valuable or likelier to work). */
interface Seed { key: string; feeds: [string, LinkKind][]; title: string; detail: string; track: string; doneWhen: string; steps: string[] }

export const SEED: Seed[] = [
  {
    key: "pay", feeds: [],
    title: "Take the first real payment end to end", track: "revenue",
    detail: "Checkout is wired, but nobody outside the team has paid through the whole path yet",
    doneWhen: "A real card buys the product, the receipt and access arrive by email, access works on a clean account, and the payment is refunded",
    steps: ["Check the live payment keys and prices on the checkout", "Buy with a real card", "Confirm the webhook grants access", "Refund and confirm access is revoked"],
  },
  {
    key: "thanks", feeds: [["pay", "unblocks"]],
    title: "Build the after-payment page and welcome email", track: "revenue",
    detail: "A buyer who pays and then sees nothing asks for a refund",
    doneWhen: "Every paid checkout lands on a page with clear next steps, and the same arrives by email within a minute",
    steps: ["Thanks page with the next three steps", "Welcome email with the same content", "Test with a discount code and with a real payment"],
  },
  {
    key: "talk", feeds: [["watch", "unblocks"], ["launch", "boosts"]],
    title: "Talk to 5 named people who have the problem", track: "distribution",
    detail: "There is no demand evidence on record yet: no person, no quote",
    doneWhen: "5 conversations held with named people in the target audience, each logged with their own words on how they solve the problem today",
    steps: ["Pick 10 names", "Ask for 20 minutes about how they work today (no pitch)", "Hold 5 calls", "Write each person's words into the check-in"],
  },
  {
    key: "watch", feeds: [["launch", "boosts"]],
    title: "Watch 3 strangers set up the product without help", track: "quality",
    detail: "No one outside the team has set it up. Every stumble a stranger hits is a lost sale",
    doneWhen: "3 people outside the team set it up from the public site while we watch silently, and every stumble is logged and fixed or filed",
    steps: ["Recruit 3 people from the 5 conversations", "Share only the public getting-started page", "Watch without helping and note every stumble", "Fix the top three stumbles"],
  },
  {
    key: "launch", feeds: [["pay", "boosts"]],
    title: "Publish a launch post with one real result", track: "distribution",
    detail: "A post with a measured result from a real user travels further than a feature list",
    doneWhen: "One launch post is live on the site and shared in two places the audience reads, quoting one result a real user agreed to share",
    steps: ["Pick the strongest result from the conversations", "Write the post", "Share it in two communities", "Log the visits and sign-ups it brought"],
  },
  {
    key: "backup", feeds: [["support", "boosts"]],
    title: "Restore the production database from a backup", track: "ownership",
    detail: "Backups that were never restored are a hope, not a backup",
    doneWhen: "Last night's backup is restored into a fresh environment and the app runs against it, with the steps written down",
    steps: ["Find last night's backup", "Restore it into a fresh environment", "Run the app against it", "Write the restore steps into the runbook"],
  },
  {
    key: "support", feeds: [["watch", "boosts"], ["pay", "boosts"]],
    title: "Ship supportability basics", track: "trust",
    detail: "security.txt, a changelog and a support contact are what a careful buyer checks first",
    doneWhen: "security.txt returns 200, every release has a changelog entry, and a support address is on the site and in the app",
    steps: ["Write security.txt and deploy", "Changelog generated at release", "Support address in the site footer and in the app"],
  },
];

/** Has a person worked on this task? Then it is theirs and a new starting list never removes it. */
function touched(id: string): boolean {
  const t = db.query("SELECT created_by, status, owner, steps FROM tasks WHERE id = ?").get(id) as { created_by: string | null; status: string; owner: string | null; steps: string } | null;
  if (!t) return false;
  if (t.created_by || t.status !== "open" || t.owner) return true;
  if ((JSON.parse(t.steps || "[]") as { done: boolean }[]).some((s) => s.done)) return true;
  const n = (sql: string) => (db.query(sql).get(id) as { n: number }).n;
  return n("SELECT COUNT(*) n FROM answers WHERE task_id = ?") + n("SELECT COUNT(*) n FROM debriefs WHERE task_id = ?")
    + n("SELECT COUNT(*) n FROM events WHERE task_id = ? AND kind = 'task.edit'")
    + (db.query("SELECT COUNT(*) n FROM links WHERE (from_id = ? OR to_id = ?) AND who IS NOT NULL").get(id, id) as { n: number }).n > 0;
}

/**
 * Bring the starting list up to SEED_VERSION. Starting tasks nobody has worked on are replaced; anything a person
 * created or touched stays, and a new starting task whose title is already on the list is not added twice.
 * Returns how many tasks were added.
 */
export function syncSeed(): number {
  const row = db.query("SELECT value FROM settings WHERE key = 'seed_version'").get() as { value: string } | null;
  const version = row ? Number(row.value) : (db.query("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n ? 1 : 0;
  if (version >= SEED_VERSION) return 0;
  const seeded = (db.query("SELECT id FROM tasks WHERE created_by IS NULL").all() as { id: string }[]).map((r) => r.id);
  const removed = seeded.filter((id) => !touched(id));
  for (const id of removed) db.query("DELETE FROM tasks WHERE id = ?").run(id);
  const kept = new Set((db.query("SELECT title FROM tasks").all() as { title: string }[]).map((r) => r.title.toLowerCase()));
  const add = SEED.filter((t) => !kept.has(t.title.toLowerCase()));
  for (const t of add) addTask({ ...t, who: null });
  // Link the starting tasks, including ones a person kept (matched by title).
  const idOf = new Map((db.query("SELECT id, title FROM tasks").all() as { id: string; title: string }[]).map((r) => [r.title.toLowerCase(), r.id]));
  const byKey = new Map(SEED.map((t) => [t.key, idOf.get(t.title.toLowerCase())]));
  for (const t of SEED) for (const [to, kind] of t.feeds) {
    const a = byKey.get(t.key), b = byKey.get(to);
    if (a && b) db.query("INSERT OR IGNORE INTO links (from_id, to_id, kind, who, at) VALUES (?, ?, ?, NULL, ?)").run(a, b, kind, now());
  }
  db.query("INSERT OR REPLACE INTO settings (key, value, who, at) VALUES ('seed_version', ?, NULL, ?)").run(String(SEED_VERSION), now());
  if (version > 0) log("seed.replace", null, null, { from: version, to: SEED_VERSION, removed: removed.length, kept: seeded.length - removed.length, added: add.length });
  return add.length;
}
