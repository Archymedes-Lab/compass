// Why a task sits where it does, in plain words: up to three reasons from Orion's expected levels (0..1 each).
// The framework ranks stay in the task's detail; these are what a person reads in the list.
import type { Dim } from "./dims.ts";

export interface Reason { text: string; tone: "good" | "warn" | "info" }

const EFFORT = ["Hours", "Days", "Weeks", "Months", "Quarters"];

/** The task's place in the flow: what it is waiting on and what it fuels. */
export interface FlowFacts { waitingOn?: string; unlocks: number; boosts: number }

export function reasons(level: Record<Dim, number>, track: string, door: "one_way" | "two_way", f?: FlowFacts): Reason[] {
  const out: (Reason & { weight: number })[] = [];
  if (f?.waitingOn) out.push({ text: `Waiting on: ${f.waitingOn.length > 38 ? f.waitingOn.slice(0, 36) + "…" : f.waitingOn}`, tone: "warn", weight: 9 });
  if (f && f.unlocks > 0) out.push({ text: `Unlocks ${f.unlocks}`, tone: "good", weight: 1.2 + 0.1 * f.unlocks });
  if (f && f.boosts > 1) out.push({ text: `Fuels ${f.boosts} tasks`, tone: "good", weight: 0.75 + 0.05 * f.boosts });
  const effortWord = EFFORT[Math.round(level.effort * 4)];
  if (level.effort <= 0.3) out.push({ text: `Quick: ${effortWord.toLowerCase()}`, tone: "good", weight: 1 - level.effort });
  else if (level.effort >= 0.7) out.push({ text: `Heavy: ${effortWord.toLowerCase()}`, tone: "warn", weight: level.effort - 0.2 });
  if (level.urgency >= 0.65) out.push({ text: "Costly to delay", tone: "warn", weight: level.urgency });
  if (level.impact >= 0.6) out.push({ text: track === "revenue" ? "Moves revenue" : "High impact", tone: "good", weight: level.impact });
  if (level.defensibility >= 0.55) out.push({ text: "Hard to copy", tone: "good", weight: level.defensibility });
  if (level.leverage >= 0.65) out.push({ text: "Foundation work", tone: "good", weight: level.leverage - 0.05 });
  if (level.quality >= 0.65) out.push({ text: "Raises quality", tone: "good", weight: level.quality - 0.1 });
  if (level.confidence <= 0.3) out.push({ text: "Unproven", tone: "warn", weight: 0.6 - level.confidence });
  if (door === "one_way") out.push({ text: "Hard to undo", tone: "info", weight: 0.35 });
  if (!out.length) out.push({ text: "Steady work", tone: "info", weight: 0 });
  return out.sort((a, b) => b.weight - a.weight).slice(0, 3).map(({ text, tone }) => ({ text, tone }));
}
