// Two lanes of work. The team lane is what people do; the agent lane is what agents (Claude, Codex) do on their own.
//
//   - Each task has a lane. People create team tasks by default and may move any task between lanes; an agent's
//     proposals start in the agent lane, and an agent never moves a task (it asks a person instead).
//   - The agent lane learns faster. Its corrections come from outcomes on agent-lane tasks, with a quarter of the
//     shrinkage (AGENT_SHRINK vs calibrate.SHRINK), so each outcome moves them about four times as far, and they
//     are always applied to agent-lane tasks. An agent grading its own work counts for half until a person
//     confirms it, and not at all if a person disputes it. The team lane learns only from people, as before.
//   - When an agent needs a person (an approval, an account, a decision, information), it raises an intervention.
//     Open interventions are the first thing on a person's dashboard. A person answers: done, declined, or "find a
//     way around" with a hint.
//   - What an agent should do on each task is a directive derived from its interventions: proceed, wait, work around
//     or stop. Waiting on a person is never forever for practical blockers: after SLA_HOURS without an answer the
//     directive turns into "work around". It never does for authority: an approval, credential, payment, legal or
//     release decision waits for a person, and "work around" then means finding a path that does not need that
//     authority, never performing, simulating or bypassing it.
// Pure; no store.

export const LANES = ["team", "agent"] as const;
export type Lane = (typeof LANES)[number];
export const isLane = (v: unknown): v is Lane => LANES.includes(v as Lane);

export const KINDS = {
  approval: "Approval: a person must say yes (deploy, merge, publish, sign, send)",
  credential: "Credentials or an account only a person holds",
  spend: "Money: a purchase, a plan, a budget",
  legal: "Legal, licence, privacy or terms",
  decision: "A product or priority decision",
  information: "Information or context the agent cannot find",
  access: "Access or a tool the agent lacks (not a credential)",
  external: "Someone outside the team (a customer, a vendor, a service)",
} as const;
export type Kind = keyof typeof KINDS;
export const isKind = (v: unknown): v is Kind => Object.hasOwn(KINDS, v as string);
/** Kinds where only a person can authorise: never worked around automatically. */
export const AUTHORITY: ReadonlySet<Kind> = new Set<Kind>(["approval", "credential", "spend", "legal"]);

/** How long a practical blocker waits for a person before the agent is told to find a way around it. */
export const SLA_HOURS = 24;
/** Agent-lane shrinkage: 1 pseudo-observation of "no bias" (the team lane uses 4). */
export const AGENT_SHRINK = 1;
/** Weight of an agent's own debrief: unreviewed, confirmed by a person, disputed by a person. */
export const AGENT_DEBRIEF_WEIGHT = { unreviewed: 0.5, confirmed: 1, disputed: 0 } as const;

export type Resolution = "done" | "declined" | "workaround" | "withdrawn";
export interface Intervention {
  id: number; taskId: string; kind: Kind; need: string; tried: string | null; status: "open" | "resolved";
  createdBy: string; createdAt: string; resolvedBy: string | null; resolvedAt: string | null;
  resolution: Resolution | null; note: string | null;
}

export type Action = "proceed" | "wait" | "work-around" | "stop";
export interface Directive { action: Action; why: string; hint?: string; interventionId?: number; auto?: boolean }

const GUARD = "Do not perform, simulate or bypass the protected action itself.";

/** What an agent should do on a task, from that task's interventions (any order), at `clock`. */
export function directive(ivs: Intervention[], clock: Date = new Date()): Directive {
  const open = ivs.filter((i) => i.status === "open").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const authority = open.find((i) => AUTHORITY.has(i.kind));
  if (authority) {
    return { action: "wait", interventionId: authority.id,
      why: `Waiting for a person: ${KINDS[authority.kind].split(":")[0].toLowerCase()}. Work on another task meanwhile. ${GUARD}` };
  }
  if (open.length) {
    const oldest = open[0];
    const hours = (clock.getTime() - Date.parse(oldest.createdAt)) / 3_600_000;
    if (hours >= SLA_HOURS) {
      return { action: "work-around", auto: true, interventionId: oldest.id,
        why: `No answer in ${SLA_HOURS} h to "${oldest.need.slice(0, 120)}": find a way that does not need it, then withdraw the request.` };
    }
    return { action: "wait", interventionId: oldest.id,
      why: `Waiting for a person (asked ${Math.max(0, Math.floor(hours))} h ago); after ${SLA_HOURS} h, work around it. Work on another task meanwhile.` };
  }
  const last = ivs.filter((i) => i.status === "resolved" && i.resolution !== "withdrawn")
    .sort((a, b) => (a.resolvedAt ?? "").localeCompare(b.resolvedAt ?? "")).at(-1);
  if (last?.resolution === "workaround") {
    return { action: "work-around", interventionId: last.id, hint: last.note ?? undefined,
      why: AUTHORITY.has(last.kind)
        ? `${last.resolvedBy ?? "A person"} asked for a way around "${last.need.slice(0, 120)}" that does not need it. ${GUARD}`
        : `${last.resolvedBy ?? "A person"} asked you to find a way around "${last.need.slice(0, 120)}".` };
  }
  if (last?.resolution === "declined") {
    return { action: "stop", interventionId: last.id, hint: last.note ?? undefined,
      why: `${last.resolvedBy ?? "A person"} declined "${last.need.slice(0, 120)}": do not pursue this path. Propose another task or ask a different question.` };
  }
  return { action: "proceed", why: last?.resolution === "done" ? `${last.resolvedBy ?? "A person"} resolved what this was waiting on.` : "Nothing is waiting on a person." };
}

/** Order agent work: what it can act on now (proceed, work around) before what waits; stable within each group. */
export const actionable = (a: Action) => a === "proceed" || a === "work-around";

/** How much one debrief teaches the agent lane. */
export function agentLaneWeight(debriefBy: string | null, review: string | null, isAgent: (who: string | null) => boolean): number {
  if (!isAgent(debriefBy)) return 1;
  if (review === "confirmed") return AGENT_DEBRIEF_WEIGHT.confirmed;
  if (review === "disputed") return AGENT_DEBRIEF_WEIGHT.disputed;
  return AGENT_DEBRIEF_WEIGHT.unreviewed;
}
