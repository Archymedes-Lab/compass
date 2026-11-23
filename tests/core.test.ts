import { describe, expect, test } from "bun:test";
import { rank, FRAMEWORKS } from "../src/rank.ts";
import { biases, calibrated, shift, SHRINK } from "../src/calibrate.ts";
import { daily, followUps, kigaliDay, pendingDebriefs, voiQuestions, type TaskLite } from "../src/questions.ts";
import { DIMS, uniform, type Dims } from "../src/dims.ts";
import { fromPoint } from "../../orion/src/decision-engine/creative.ts";

const at = (levels: Partial<Record<keyof Dims, number>>, conf = 0.9): Dims =>
  Object.fromEntries(DIMS.map((d) => [d, levels[d] === undefined ? fromPoint(2, conf) : fromPoint(levels[d]!, conf)])) as Dims;
const sum = (p: number[]) => p.reduce((a, b) => a + b, 0);

describe("rank", () => {
  test("empty list", () => expect(rank([]).rows).toEqual([]));

  test("a high-impact, urgent, cheap, defensible task comes first", () => {
    const r = rank([
      { id: "slow", dims: at({ impact: 1, urgency: 1, effort: 4, defensibility: 0, quality: 1 }) },
      { id: "best", dims: at({ impact: 4, urgency: 4, effort: 1, defensibility: 4, quality: 4, leverage: 4 }) },
      { id: "mid", dims: at({}) },
    ]);
    expect(r.first).toBe("best");
    expect(r.rows.at(-1)!.optionId).toBe("slow");
    expect(r.rows.map((x) => x.rank)).toEqual([1, 2, 3]);
    for (const f of FRAMEWORKS) expect(r.rows[0].ranks[f]).toBe(1);
    expect(r.agreement).toBe(1);
  });

  test("defensibility breaks a tie that Orion's five frameworks cannot see", () => {
    const r = rank([
      { id: "copyable", dims: at({ defensibility: 0 }) },
      { id: "moat", dims: at({ defensibility: 4 }) },
    ]);
    expect(r.first).toBe("moat");
  });

  test("order is independent of input order", () => {
    const items = [
      { id: "a", dims: at({ impact: 3, effort: 2 }) },
      { id: "b", dims: at({ impact: 2, effort: 1, defensibility: 4 }) },
      { id: "c", dims: at({ urgency: 4 }) },
    ];
    const one = rank(items).rows.map((r) => r.optionId);
    const two = rank([...items].reverse()).rows.map((r) => r.optionId);
    expect(two).toEqual(one);
  });
});

describe("calibration", () => {
  test("shift keeps mass and moves the mean by the shift inside the scale", () => {
    const p = fromPoint(2, 0.6);
    const q = shift(p, 0.5);
    expect(sum(q)).toBeCloseTo(1, 10);
    const mean = (x: number[]) => x.reduce((a, v, i) => a + v * i, 0);
    expect(mean(q)).toBeGreaterThan(mean(p));
    expect(shift(p, 0)).toEqual(p);
    expect(shift([0, 0, 0, 0, 1], 2)).toEqual([0, 0, 0, 0, 1]);
  });

  test("bias is shrunk toward zero: one surprise nudges, a pattern moves it", () => {
    const one = biases([{ dim: "impact", predicted: 1, actual: 3 }]);
    expect(one.impact).toMatchObject({ n: 1, raw: 2, applied: true });
    expect(one.impact.bias).toBeCloseTo(2 / (1 + SHRINK), 2);
    const many = biases(Array.from({ length: 40 }, () => ({ dim: "impact" as const, predicted: 1, actual: 3 })));
    expect(many.impact.bias).toBeGreaterThan(1.8);
    const dims = at({ impact: 1 });
    const c = calibrated(dims, { bias: many });
    expect(c.impact).not.toEqual(dims.impact);
    expect(c.quality).toEqual(dims.quality);
  });

  test("effort is never shifted as a level: it is corrected as a ratio in the value model", () => {
    const b = biases(Array.from({ length: 5 }, () => ({ dim: "effort" as const, predicted: 1, actual: 3 })));
    expect(b.effort.applied).toBe(false);
    expect(calibrated(at({ effort: 1 }), { bias: b }).effort).toEqual(at({ effort: 1 }).effort);
  });
});

describe("questions", () => {
  const t = (id: string, status: TaskLite["status"], extra: Partial<TaskLite> = {}): TaskLite =>
    ({ id, title: id, owner: null, status, doneAt: null, startedAt: null, ...extra });
  const now = new Date("2026-11-09T09:00:00Z");

  test("a task is up for debrief as soon as it is done", () => {
    const tasks = [t("a", "done", { doneAt: now.toISOString() }), t("b", "open"), t("c", "done")];
    expect(pendingDebriefs(tasks, new Set(["c"])).map((d) => d.taskId)).toEqual(["a"]);
  });

  test("impact follow-up after a week, once", () => {
    const old = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const tasks = [t("old", "done", { doneAt: old }), t("new", "done", { doneAt: recent }), t("seen", "done", { doneAt: old })];
    expect(followUps(tasks, new Set(["seen"]), now).map((f) => f.taskId)).toEqual(["old"]);
  });

  test("daily check-in once a day per person, Kigali time", () => {
    expect(kigaliDay(new Date("2026-11-09T22:30:00Z"))).toBe("2026-11-10");
    const tasks = [t("mine", "doing", { owner: "Alex" }), t("theirs", "doing", { owner: "Evan" }), t("free", "doing")];
    const d = daily("Alex", now, "2026-11-08", tasks, [], []);
    expect(d?.inProgress.map((x) => x.id)).toEqual(["mine", "free"]);
    expect(daily("Alex", now, "2026-11-09", tasks, [], [])).toBeNull();
  });

  test("VOI asks where Orion is unsure and the answer moves the list", () => {
    const items = [
      { id: "sure", title: "sure", dims: at({ impact: 3, effort: 1 }) },
      { id: "unsure", title: "unsure", dims: { ...at({ effort: 1 }), impact: uniform() } },
      { id: "other", title: "other", dims: at({ impact: 3, effort: 2 }) },
    ];
    const qs = voiQuestions(items, new Set());
    expect(qs.length).toBeGreaterThan(0);
    expect(qs[0]).toMatchObject({ taskId: "unsure", dim: "impact" });
    expect(qs[0].prompt).toContain('"unsure"');
    // Once the team has answered, it is not asked again.
    expect(voiQuestions(items, new Set(["unsure:impact"])).some((q) => q.taskId === "unsure" && q.dim === "impact")).toBe(false);
  });
});
