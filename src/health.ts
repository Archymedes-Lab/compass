// Workspace diagnostics describe missing evidence and operational work; they never invent business facts.
export interface HealthTask {
  id: string; title: string; status: string; owner: string | null; lane: string; doneWhen: string;
  judge: string; startedAt: string | null; judgedAt: string | null; judgedBriefHash: string | null;
}
export interface HealthIssue {
  key: string; severity: "attention" | "info"; title: string; detail: string; count: number; href: string;
  tasks: { id: string; title: string }[];
}
export interface WorkspaceHealth {
  at: string;
  counts: { open: number; doing: number; blocked: number; pendingJudgments: number; failedJudgments: number; unassigned: number; debriefs: number; followUps: number; missingMetrics: number };
  brief: { default: boolean; updatedAt: string | null; hash: string };
  issues: HealthIssue[];
}
export function workspaceHealth(input: {
  tasks: HealthTask[]; blocked: number; debriefs: { taskId: string }[]; followUps: { taskId: string }[];
  openInterventions: number; missingMetrics: number; briefAt: string | null; briefHash: string;
}, clock = new Date()): WorkspaceHealth {
  const live = input.tasks.filter(t => t.status === "open" || t.status === "doing");
  const pending = live.filter(t => t.judge === "pending"), failed = live.filter(t => t.judge === "error");
  const unassigned = live.filter(t => t.lane === "team" && !t.owner);
  const issues: HealthIssue[] = [];
  const add = (key: string, severity: HealthIssue["severity"], title: string, detail: string, tasks: HealthTask[], href = "#tasks", count = tasks.length) => {
    if (count) issues.push({ key, severity, title, detail, count, href, tasks: tasks.slice(0, 10).map(({ id, title }) => ({ id, title })) });
  };
  add("judgment-errors", "attention", "Judgments need a retry", "These tasks retain their previous estimates, or broad uncertainty if never judged. Retry individual tasks after checking the error.", failed, "#system");
  add("debriefs", "attention", "Finish the outcome loop", "Record what happened so completed work can teach Compass.", input.tasks.filter(t => input.debriefs.some(d => d.taskId === t.id)), "#today");
  add("interventions", "attention", "Agents need a person", "Resolve requests on Today. Authority blockers never expire automatically.", [], "#today", input.openInterventions);
  add("follow-ups", "info", "Measure the impact of finished work", "These tasks finished at least seven days ago and have no impact follow-up. Your daily check-in shows the ones you can answer.", input.tasks.filter(t => input.followUps.some(f => f.taskId === t.id)), "#today");
  add("unassigned", "info", "Give the next team task an owner", "Unassigned team work can appear in both people's queues. Assign the work someone is actually taking on.", unassigned);
  add("done-criteria", "info", "Define what done means", "Add a concrete completion test before starting these tasks.", live.filter(t => !t.doneWhen.trim()));
  add("stale-progress", "attention", "Review work in progress", "These tasks have been in progress for at least seven days. Confirm progress, split the work or record a blocker.", live.filter(t => t.status === "doing" && t.startedAt && clock.getTime() - Date.parse(t.startedAt) >= 7 * 86400000));
  add("metrics", "info", "Record baseline goal numbers", "An unset metric means unknown. Enter measured numbers in Goals; do not assume zero.", [], "#goals", input.missingMetrics);
  add("brief", "info", "Review the company brief", input.briefAt ? "The brief has not been updated for at least two weeks. Check its claims against current evidence." : "Compass is using its initial company brief. Review prices, evidence and current goals before relying on the order.", [], "#learning", !input.briefAt || clock.getTime() - Date.parse(input.briefAt) >= 14 * 86400000 ? 1 : 0);
  add("brief-changed", "info", "Estimates use an earlier brief", "These tasks were judged against a different company brief. Re-judge the important ones deliberately; each call uses the provider.", live.filter(t => !!t.judgedBriefHash && t.judgedBriefHash !== input.briefHash), "#system");
  add("provenance", "info", "Older estimates lack brief provenance", "The brief used for these existing estimates was not recorded. Their scores are preserved; a new judgment records provenance.", live.filter(t => t.judge === "jev" && !t.judgedBriefHash), "#system");
  add("pending", "info", "Orion has queued judgments", "The durable queue processes a bounded batch at a time. Existing estimates stay visible until a fresh response is accepted.", pending, "#system");
  return { at: clock.toISOString(), counts: { open: live.filter(t => t.status === "open").length, doing: live.filter(t => t.status === "doing").length, blocked: input.blocked, pendingJudgments: pending.length, failedJudgments: failed.length, unassigned: unassigned.length, debriefs: input.debriefs.length, followUps: input.followUps.length, missingMetrics: input.missingMetrics }, brief: { default: !input.briefAt, updatedAt: input.briefAt, hash: input.briefHash }, issues };
}
