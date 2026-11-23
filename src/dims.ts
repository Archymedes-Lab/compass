// The nine things Orion judges about every task: Orion's seven prioritisation dimensions plus two that encode
// what Archymedes cares about most (the defensibility audit of 1 Nov 2026 and the founders' bar for quality).
import { PRIORITY_DIMENSIONS, PRIORITY_QUESTIONS, type PriorityDimension } from "../../orion/src/decision-engine/prioritize.ts";

export const EXTRA_DIMENSIONS = ["defensibility", "quality"] as const;
export type ExtraDimension = (typeof EXTRA_DIMENSIONS)[number];
export type Dim = PriorityDimension | ExtraDimension;
export const DIMS: readonly Dim[] = [...PRIORITY_DIMENSIONS, ...EXTRA_DIMENSIONS];
export type Dims = Record<Dim, number[]>;

/**
 * `levels` are the short words people answer with; `criteria`, when present, are what Jev is shown instead: concrete
 * situations, one per level, because the Jev docs advise "describe situations, not degrees" (primitives/score). Orion's
 * seven questions are shared with Orion and keep their wording here.
 */
export const QUESTIONS: Record<Dim, { question: string; levels: string[]; criteria?: string[] }> = {
  ...PRIORITY_QUESTIONS,
  defensibility: {
    question:
      "How much harder to copy would `option` make Archymedes: data that compounds with use, paid access enforced on our servers, signed releases people can trust, ownership of code, IP and brand, or customer relationships a competitor cannot take?",
    levels: ["Not at all", "Slightly", "Somewhat", "Clearly", "It creates a durable moat"],
    criteria: [
      "A competitor could do the same next week without anything Archymedes holds",
      "It leaves little behind, or only what is public or quick to rebuild",
      "It leaves something a competitor would need months to rebuild, such as our own code, a signed release or a working process",
      "It creates something a competitor cannot simply rebuild: outcome data from use, paid access enforced on our servers, owned IP or brand, or customer relationships",
      "It strengthens a moat that compounds: every customer or use makes our data, trust or relationships harder to match",
    ],
  },
  quality: {
    question: "How much would `option` raise the quality and trustworthiness of what Archymedes ships to customers and investors?",
    levels: ["Not at all", "Slightly", "Somewhat", "Clearly", "It sets a new bar"],
    criteria: [
      "Customers and investors would see no difference",
      "A small fix that few people would notice",
      "It removes a problem customers or investors could actually run into",
      "Something people rely on becomes clearly more reliable, tested or trustworthy",
      "It sets a standard customers and investors would cite as a reason to trust Archymedes",
    ],
  },
};

/** Short names for the UI. */
export const DIM_LABEL: Record<Dim, string> = {
  impact: "Impact", urgency: "Urgency", reach: "Reach", confidence: "Confidence", effort: "Effort",
  leverage: "Leverage", reversibility: "Reversibility", defensibility: "Defensibility", quality: "Quality",
};

/** What kind of moat or outcome a task mainly builds. */
export const TRACKS = {
  revenue: "Revenue: someone can pay",
  data_loop: "Data loop: outcomes only we hold",
  paid_access: "Paid access enforced on our servers",
  trust: "Trust: signing, keys, security",
  ownership: "Ownership: org, IP, marks, backups",
  distribution: "Distribution: leads, channels, reach",
  quality: "Quality: tests, installs, reliability",
  other: "Other",
} as const;
export type Track = keyof typeof TRACKS;


export const uniform = () => [0.2, 0.2, 0.2, 0.2, 0.2];
export const expectedLevel = (p: number[]) => p.reduce((a, x, i) => a + x * i, 0);
/**
 * Jev's documented Score confidence (docs.typesafe.ai/confidence): 1 − (mean distance from the most likely level) ÷
 * (the same for a uniform answer), floored at 0. Distance-aware: a split between neighbours is surer than a split
 * between opposite ends, which entropy cannot see.
 */
export function scoreConfidence(p: number[]): number {
  const m = p.indexOf(Math.max(...p));
  const mad = p.reduce((a, x, i) => a + x * Math.abs(i - m), 0);
  const unif = p.reduce((a, _, i) => a + Math.abs(i - m), 0) / p.length;
  return unif > 0 ? Math.max(0, 1 - mad / unif) : 1;
}
export const entropy = (p: number[]) => -p.reduce((a, x) => a + (x > 0 ? x * Math.log(x) : 0), 0) / Math.log(p.length);
