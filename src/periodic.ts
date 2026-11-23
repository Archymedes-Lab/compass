// Work that runs on the clock (the Worker's alarm/cron tick every ~15 minutes; locally with COMPASS_PERIODIC=1):
// live-site checks, GitHub refresh, the daily project scan, re-ranking open proposals, then the daily email.
// Order matters: the scan runs before the email hour so the email carries today's proposals. Each step is isolated:
// one failing provider never stops the others, and none of them throws out of the tick.
import { checkSites, refreshGithub } from "./projects.ts";
import { rerankCandidates, runScan, scanDue } from "./scan.ts";
import { sendDigests } from "./email.ts";
import { automationConfig } from "./automation-store.ts";
import { log } from "./db.ts";
import { dealQuests } from "./game.ts";

export async function periodic(o: { githubToken?: string; judgeKey?: string; fetch?: typeof fetch; clock?: Date } = {}) {
  const clock = o.clock ?? new Date();
  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try { await fn(); } catch (e) { log("periodic.error", null, null, { step: name, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }); }
  };
  await step("sites", () => checkSites(o.fetch, clock));
  await step("github", () => refreshGithub(o.githubToken, o.fetch, clock));
  if (automationConfig().openrouterKey && scanDue(clock)) await step("scan", () => runScan({ fetch: o.fetch, clock: () => clock, judgeKey: o.judgeKey }));
  await step("rerank", () => rerankCandidates());
  await step("quests", () => dealQuests(clock));
  await step("email", () => sendDigests({ fetch: o.fetch, clock }));
}
