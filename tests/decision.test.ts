// The decision layer added in Nov 2026: one value model with simulation, preposterior VOI, small-sample learning,
// proper scoring and the judge's own diagnostics.
import { describe, expect, test } from "bun:test";
import { COD_DIMS, COD_WEIGHT, CONF, FIB, TOP_K, expectedOwn, robustness, rng, valueOfAnswer } from "../src/value.ts";
import { rank } from "../src/rank.ts";
import { effortModel, effortScale, fitTemperature, learn, rps, sizeAt, trackRecord, type Observation } from "../src/calibrate.ts";
import { voiQuestions } from "../src/questions.ts";
import { DIMS, scoreConfidence, uniform, type Dims } from "../src/dims.ts";
import { hash, jsDivergence, widen } from "../src/judge.ts";
import { fromPoint } from "../../orion/src/decision-engine/creative.ts";

const at = (levels: Partial<Record<keyof Dims, number>>, conf = 0.9): Dims =>
  Object.fromEntries(DIMS.map((d) => [d, fromPoint(levels[d] ?? 2, conf)])) as Dims;
const open = (ids: string[]) => ({ links: [], status: new Map(ids.map((i) => [i, "open"])) });
const sum = (p: number[]) => p.reduce((a, b) => a + b, 0);

describe("value model", () => {
  test("E[own] is exact: it matches the mean of direct simulation", () => {
    const d = { ...at({ impact: 3, effort: 1 }, 0.6), urgency: uniform() };
    const r = rng(7), N = 60_000;
    const draw = (p: number[]) => { const u = r(); let c = 0; for (let i = 0; i < p.length; i++) { c += p[i]; if (u < c) return i; } return 4; };
    let acc = 0;
    for (let s = 0; s < N; s++) acc += CONF[draw(d.confidence)] * COD_DIMS.reduce((a, k) => a + COD_WEIGHT[k] * FIB[draw(d[k])], 0) / FIB[draw(d.effort)];
    expect(acc / N).toBeCloseTo(expectedOwn(d), 1);
  });

  test("a clearly better task is first in nearly every draw; twins split P(first)", () => {
    const items = [{ id: "best", dims: at({ impact: 4, urgency: 4, effort: 0 }) }, { id: "a", dims: at({}) }, { id: "b", dims: at({}) }];
    const r = robustness(items, open(items.map((i) => i.id)));
    expect(r.get("best")!.pFirst).toBeGreaterThan(0.95);
    expect(r.get("best")!.rankHi).toBe(1);
    expect(Math.abs(r.get("a")!.pTop - r.get("b")!.pTop)).toBeLessThan(0.05);
    expect(r.get("a")!.rankLo).toBeLessThanOrEqual(r.get("a")!.rankHi);
  });

  test("blocked work is not in the race", () => {
    const items = [{ id: "pre", dims: at({}) }, { id: "big", dims: at({ impact: 4, urgency: 4, effort: 0 }) }];
    const g = { links: [{ from: "pre", to: "big", kind: "unblocks" as const }], status: new Map([["pre", "open"], ["big", "open"]]) };
    const r = rank(items, g);
    expect(r.first).toBe("pre");
    expect(r.rows.find((x) => x.optionId === "big")!.pTop).toBe(0);
    // ... and the prerequisite carries part of what it unlocks.
    expect(r.rows[0].value).toBeGreaterThan(r.rows[0].own);
  });

  test("a transformative, defensible task beats a trivial quick one", () => {
    const items = [
      { id: "trivial", dims: at({ impact: 0, urgency: 0, leverage: 0, defensibility: 0, quality: 0, effort: 0 }) },
      { id: "moat", dims: at({ impact: 4, urgency: 4, leverage: 4, defensibility: 4, quality: 4, effort: 2 }) },
    ];
    expect(rank(items).first).toBe("moat");
  });

  test("lane-specific effort corrections stay separate in expected value, simulation and memoization", () => {
    const d = Object.fromEntries(DIMS.map(dim => [dim, [0, 0, 1, 0, 0]])) as Dims;
    const team = { id: "team", dims: d }, agent = { id: "agent", dims: d, effort: (size: number) => size };
    const base = rank([team, agent], undefined, { effort: size => size * 2 });
    const a = base.rows.find(r => r.optionId === "agent")!, t = base.rows.find(r => r.optionId === "team")!;
    expect(a.own).toBeCloseTo(t.own * 2, 2);
    expect(a.pFirst).toBe(1);
    const next = rank([team, { ...agent, effort: size => size * 4 }], undefined, { effort: size => size * 2 });
    expect(next.first).toBe("team");
    expect(next.rows.find(r => r.optionId === "team")!.pFirst).toBe(1);
  });

  test("the simulation is seeded: the same beliefs give the same page", () => {
    const items = [{ id: "x", dims: { ...at({}), impact: uniform() } }, { id: "y", dims: { ...at({}), urgency: uniform() } }];
    expect(rank(items).rows).toEqual(rank(items).rows);
  });
});

describe("cdm innovation slot", () => {
  test("an unproven task with big upside is the bold bet, not the first choice", () => {
    // Proven and modest vs. a transformative guess: expected value favours the proven task (a guess counts for
    // half), but the guess has the upside, so it takes the innovation slot: test it cheaply.
    const items = [
      { id: "proven", dims: at({ impact: 1, urgency: 0, reach: 3, confidence: 4, effort: 2, leverage: 3, reversibility: 0, defensibility: 1, quality: 2 }) },
      { id: "guess", dims: at({ impact: 4, urgency: 4, reach: 4, confidence: 0, effort: 3, leverage: 2, reversibility: 2, defensibility: 4, quality: 4 }) },
      { id: "dull", dims: at({ impact: 0, urgency: 0, leverage: 0, defensibility: 0, quality: 0, effort: 3, confidence: 4 }) },
    ];
    const r = rank(items);
    expect(r.first).toBe("proven");
    expect(r.bold).toBe("guess");
    expect(r.rows.find((x) => x.optionId === "guess")!.ei).toBeGreaterThan(r.rows.find((x) => x.optionId === "dull")!.ei);
  });
  test("no unproven task, no bold bet", () => {
    expect(rank([{ id: "a", dims: at({ confidence: 4 }) }, { id: "b", dims: at({ confidence: 3, impact: 3 }) }]).bold).toBeNull();
  });
});

describe("value of information", () => {
  const items = [
    { id: "sure", title: "sure", dims: at({ impact: 3, effort: 1 }) },
    { id: "unsure", title: "unsure", dims: { ...at({ effort: 1 }), impact: uniform() } },
    ...Array.from({ length: TOP_K }, (_, i) => ({ id: `f${i}`, title: `f${i}`, dims: at({ impact: 2, effort: 1 }) })),
  ];
  test("nothing to learn from a dimension the model is certain about", () => {
    const point = items.map((i) => i.id === "unsure" ? { ...i, dims: { ...i.dims, impact: [0, 0, 0, 1, 0] } } : i);
    expect(valueOfAnswer(point, open(items.map((i) => i.id)), "unsure", "impact")).toBe(0);
  });
  test("an uncertain dimension on a contended task is worth asking", () => {
    expect(valueOfAnswer(items, open(items.map((i) => i.id)), "unsure", "impact")).toBeGreaterThan(0.3);
    const qs = voiQuestions(items, new Set());
    expect(qs[0]).toMatchObject({ taskId: "unsure", dim: "impact" });
  });
});

describe("learning from outcomes", () => {
  const effortObs = (pred: number, act: number, n: number): Observation[] => Array.from({ length: n }, () => ({ dim: "effort", predicted: pred, actual: act }));

  test("no outcomes, no correction", () => {
    const m = effortModel([]);
    expect(m).toMatchObject({ n: 0, a: 0, b: 0, ratio: 1 });
    expect(effortScale(m)(5)).toBeCloseTo(5, 9);
  });

  test("consistent 'days became weeks' overruns move the ratio toward the truth, gradually", () => {
    const truth = sizeAt(2) / sizeAt(1);
    const one = effortModel(effortObs(1, 2, 1)).ratio, many = effortModel(effortObs(1, 2, 30)).ratio;
    expect(one).toBeGreaterThan(1);
    expect(one).toBeLessThan(many);
    expect(many).toBeCloseTo(truth, 0);
  });

  test("when only big tasks overrun, big tasks lose value relative to small ones", () => {
    const m = effortModel([...effortObs(3, 4, 6), ...effortObs(0, 0, 6)]);
    expect(m.b).toBeGreaterThan(0);
    const s = effortScale(m);
    expect(s(8) / 8).toBeGreaterThan(s(1) / 1);
  });

  test("temperature: an overconfident judge is softened, no data changes nothing", () => {
    expect(fitTemperature([])).toEqual({ n: 0, t: 1 });
    const sharp = [0.02, 0.02, 0.92, 0.02, 0.02];
    const obs: Observation[] = Array.from({ length: 20 }, (_, i) => ({ dim: "impact", predicted: 2, actual: i % 2 ? 2 : (i % 4 === 0 ? 0 : 4), dist: sharp }));
    expect(fitTemperature(obs).t).toBeGreaterThan(1.3);
  });

  test("ranked probability score: 0 when sure and right, worse the further off; skill vs. a uniform guess", () => {
    expect(rps([0, 0, 1, 0, 0], 2)).toBe(0);
    expect(rps([0, 0, 1, 0, 0], 4)).toBeGreaterThan(rps([0, 0, 1, 0, 0], 3));
    const good: Observation[] = [{ dim: "quality", predicted: 3, actual: 3, dist: fromPoint(3, 0.7) }];
    expect(trackRecord(good).skill).toBeGreaterThan(0.5);
    expect(trackRecord([{ dim: "quality", predicted: 2, actual: 0, dist: uniform() }]).skill).toBe(0);
    expect(learn(good).record.n).toBe(1);
  });
});

describe("judge diagnostics", () => {
  test("Score confidence follows the documented formula: distance-aware", () => {
    expect(scoreConfidence([0, 0, 1, 0, 0])).toBe(1);
    expect(scoreConfidence(uniform())).toBeCloseTo(0, 9);
    expect(scoreConfidence([0, 0.5, 0.5, 0, 0])).toBeGreaterThan(scoreConfidence([0.5, 0, 0, 0, 0.5]));
  });
  test("disagreement between the two level orders widens, never sharpens", () => {
    const p = [0.1, 0.6, 0.2, 0.05, 0.05];
    expect(jsDivergence(p, p)).toBe(0);
    expect(jsDivergence([1, 0, 0, 0, 0], [0, 0, 0, 0, 1])).toBeCloseTo(1, 9);
    const w = widen(p, 0.3);
    expect(sum(w)).toBeCloseTo(1, 12);
    expect(Math.max(...w)).toBeLessThan(Math.max(...p));
    expect(scoreConfidence(w)).toBeLessThanOrEqual(scoreConfidence(p));
  });
  test("questions hash is stable and sensitive", () => {
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
  });
});
