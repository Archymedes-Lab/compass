// Jev (TypeSafe System One) judges each task on the nine dimensions, the same way Orion's prioritiser does: every
// score question is asked twice with the levels reversed, decoded, pooled and tempered (cdm's belief layer).
// One request per task. The key comes from TYPESAFE_API_KEY (env locally, a Worker secret in Cloudflare).
//
// The Jev docs (Nov 2026) say Score levels are judged one at a time, so the reversal may be unnecessary on 1.14; cdm's
// jev-1.13 audit found a direction bias. We keep the orbit (questions are cheap: $0.042/M input tokens) and measure
// it: the Jensen–Shannon divergence between the two orders is stored per dimension, and a disagreeing pair widens the
// belief toward uniform (an honest "the model is not sure"), never sharpens it. The forecast ledger (state.ts) keeps
// the model that answered and a hash of the questions, so a model or prompt change is visible in the track record.
// Guidance lives in each question's instructions; the state carries only data (docs: concepts/state).
import { systemOne, type SystemOneAnswer, type SystemOneQuestion } from "../../orion/server/typesafe.ts";
import { belief, relabel, reversalOrbit } from "../../orion/src/decision-engine/creative.ts";
import { DIMS, QUESTIONS, TRACKS, type Dim, type Dims, type Track } from "./dims.ts";

/** Orion's own cap on decision context. */
const MAX_CONTEXT = 4000;

/**
 * Brief, then the results of finished tasks that feed this one (the evidence that flows down the graph), then the
 * team's recent lessons. Cut at Orion's cap, so the brief and the upstream evidence are what survive.
 */
export function companyContext(brief: string, lessons: string[], upstream: string[] = []): string {
  const up = upstream.length ? `\n\nFinished work that feeds this task:\n${upstream.map((u) => `- ${u}`).join("\n")}` : "";
  const recent = lessons.length ? `\n\nWhat the team learned from recent finished tasks:\n${lessons.map((l) => `- ${l}`).join("\n")}` : "";
  return (brief.trim() + up + recent).slice(0, MAX_CONTEXT);
}

// Orion's scoreOrbit/decode (orion/server/creative.ts), restated here so the Worker bundle doesn't pull in Orion's
// model providers.
interface Presented { qid: string; order: number[] }
function scoreOrbit(key: string, instructions: string | object, levels: string[], qs: Record<string, SystemOneQuestion>): Presented[] {
  return reversalOrbit(levels.length).map((order, g) => {
    const qid = `${key}@${g}`;
    qs[qid] = { type: "score", instructions, criteria: order.map((i) => levels[i]) };
    return { qid, order };
  });
}
/** Jensen–Shannon divergence ÷ ln 2, in [0, 1]. */
export function jsDivergence(p: number[], q: number[]): number {
  const m = p.map((x, i) => (x + q[i]) / 2);
  const kl = (a: number[]) => a.reduce((s, x, i) => s + (x > 0 ? x * Math.log(x / m[i]) : 0), 0);
  return Math.max(0, Math.min(1, (kl(p) + kl(q)) / 2 / Math.LN2));
}
/** Mix toward uniform by the disagreement: (1 − d)·p + d·u. */
export const widen = (p: number[], d: number) => p.map((x) => (1 - d) * x + d / p.length);
/** FNV-1a, 32-bit: a stable id for the exact questions asked. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const LENS = "This is a business decision for a pre-revenue startup: judge the effect on getting paying customers and on becoming hard to copy, and be conservative on demand and timelines.";

export interface Judgment {
  dims: Dims;
  /** The model that answered, the questions' hash, and how far the two level orders disagreed per dimension. */
  model: string; promptHash: string; disagreement: Record<Dim, number>; tokens: number | null;
}

function decode(answer: SystemOneAnswer | undefined, p: Presented): number[] {
  if (!answer || answer.type !== "score") throw new Error("Incomplete Jev answers");
  return relabel(p.order.map((_, k) => Number(answer.probabilities[String(k)] ?? 0)), p.order);
}

export async function judge(task: { title: string; detail: string; track: string; done_when?: string; steps?: string }, context: string, apiKey?: string): Promise<Judgment> {
  const qs: Record<string, SystemOneQuestion> = {};
  const orbits = Object.fromEntries(DIMS.map((d) => [d, scoreOrbit(d, {
    question: QUESTIONS[d].question,
    scope: "Judge only `option`, for Archymedes as described in `decision`. `track` says what kind of outcome the task mainly builds.",
    lens: LENS,
  }, QUESTIONS[d].criteria ?? QUESTIONS[d].levels, qs)])) as Record<Dim, Presented[]>;
  const steps = (JSON.parse(task.steps || "[]") as { text: string }[]).map((s) => s.text);
  const option = [task.detail ? `${task.title}: ${task.detail}` : task.title,
    task.done_when ? `Done when: ${task.done_when}` : "", steps.length ? `Steps: ${steps.join("; ")}` : ""].filter(Boolean).join("\n");
  const res = await systemOne({ decision: context, track: TRACKS[task.track as Track] ?? task.track, option }, qs, { timeoutMs: 40_000, apiKey });
  const disagreement = {} as Record<Dim, number>;
  const dims = Object.fromEntries(DIMS.map((d) => {
    const decoded = orbits[d].map((p) => decode(res.answers[p.qid], p));
    disagreement[d] = Math.round(jsDivergence(decoded[0], decoded[1]) * 1000) / 1000;
    return [d, widen(belief("score", decoded), disagreement[d])];
  })) as Dims;
  return { dims, model: res.model, promptHash: hash(JSON.stringify(qs)), disagreement, tokens: res.usage?.input_tokens ?? null };
}
