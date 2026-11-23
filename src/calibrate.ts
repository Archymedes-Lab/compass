// Learning from what actually happened. Every debrief and lagged follow-up compares what Orion expected (snapshotted
// when the task was finished: the expected level and, since v4, the whole belief) with what the team says happened.
//
// Small-sample by design (2 founders, a handful of outcomes a week), so nothing waits for a hard "3 data points" rule:
//   - Level bias (impact, defensibility, quality): normal–normal shrinkage toward zero. One surprise moves the
//     correction a little; a pattern moves it a lot. bias = Σ(actual − predicted) / (n + K), K = σ²/τ₀².
//   - Effort is a ratio, not a level: r = ln(actual size / predicted size) on the Fibonacci size scale, fitted as
//     r = a + b·ln(size/3) by Bayesian linear regression (planning-fallacy research: overruns are multiplicative and
//     depend on size, Halkjelsvik & Jørgensen 2018). The prior is "no correction", so the first outcome only nudges.
//   - Temperature: cdm's Calibrator.fit (MATH.md B2). The log loss of the observed levels under Orion's beliefs is
//     convex in β = 1/T; we minimise it with a log-normal prior on T around 1 (no change), by golden section.
//   - Track record: the ranked probability score (a proper score for ordinal levels), and its skill against a
//     uniform guess. Positive skill means Orion's beliefs beat "no idea".
// The corrections change the ranking only in the calibrated view (silent reweighting erodes trust).
import { DIMS, type Dim, type Dims } from "./dims.ts";
import { temper } from "../../orion/src/decision-engine/creative.ts";
import { FIB, type EffortScale } from "./value.ts";

/** The dimensions a debrief or check-in measures directly. */
export const MEASURED: Dim[] = ["effort", "impact", "defensibility", "quality"];
/** Shrinkage strength: noise σ = 1 level, prior τ₀ = 0.5 levels → K = 4 pseudo-observations of "no bias". */
export const SHRINK = 4;
const EFFORT_PRIOR = { a: 0, sa: 0.5, b: 0, sb: 0.3, sigma: 0.7 };
const LOG_T_SD = 0.5;

/** One outcome. `w` (default 1) is how much it counts: an agent's unconfirmed self-report counts for less. */
export interface Observation { dim: Dim; predicted: number; actual: number; dist?: number[]; w?: number }
const wt = (o: Observation) => o.w ?? 1;
export interface Bias { dim: Dim; n: number; bias: number; raw: number; mae: number; applied: boolean }
export interface EffortModel { n: number; a: number; b: number; /** Typical overrun factor at a "weeks"-sized task. */ ratio: number }
export interface TrackRecord { n: number; rps: number; skill: number }
export interface Learned { bias: Record<string, Bias>; effort: EffortModel; temperature: { n: number; t: number }; record: TrackRecord }

/**
 * `shrink` is the prior's strength in pseudo-observations; `shiftEffort` also applies the effort level bias as a shift
 * (the agent lane, which has no separate effort scale in the ranking).
 */
export function biases(obs: Observation[], shrink = SHRINK, shiftEffort = false): Record<string, Bias> {
  return Object.fromEntries(MEASURED.map((dim) => {
    const xs = obs.filter((o) => o.dim === dim && wt(o) > 0);
    const n = xs.reduce((a, o) => a + wt(o), 0);
    const sum = xs.reduce((a, o) => a + wt(o) * (o.actual - o.predicted), 0);
    const mae = n ? xs.reduce((a, o) => a + wt(o) * Math.abs(o.actual - o.predicted), 0) / n : 0;
    // Effort is corrected multiplicatively (effortModel); its level bias is shown, and applied only on request.
    return [dim, { dim, n: round(n), bias: round(sum / (n + shrink)), raw: round(n ? sum / n : 0), mae: round(mae), applied: n > 0 && (dim !== "effort" || shiftEffort) }];
  }));
}

/** Fibonacci size at a fractional level (linear between the steps). */
export const sizeAt = (level: number) => {
  const x = Math.max(0, Math.min(4, level)), lo = Math.floor(x), hi = Math.ceil(x);
  return FIB[lo] + (FIB[hi] - FIB[lo]) * (x - lo);
};

/** Bayesian linear regression of ln(actual/predicted) on ln(predicted/3), with independent normal priors. */
export function effortModel(obs: Observation[]): EffortModel {
  const xs = obs.filter((o) => o.dim === "effort");
  const { a: ma, sa, b: mb, sb, sigma } = EFFORT_PRIOR;
  // Posterior precision Λ = Λ₀ + XᵀX/σ², mean = Λ⁻¹(Λ₀μ₀ + Xᵀr/σ²), with X rows [1, x].
  let p11 = 1 / sa ** 2, p12 = 0, p22 = 1 / sb ** 2, v1 = ma / sa ** 2, v2 = mb / sb ** 2;
  for (const o of xs) {
    const x = Math.log(sizeAt(o.predicted) / 3), r = Math.log(sizeAt(o.actual) / sizeAt(o.predicted)), w = wt(o) / sigma ** 2;
    p11 += w; p12 += w * x; p22 += w * x * x; v1 += w * r; v2 += w * x * r;
  }
  const det = p11 * p22 - p12 * p12;
  const a = (p22 * v1 - p12 * v2) / det, b = (p11 * v2 - p12 * v1) / det;
  return { n: xs.length, a: round(a), b: round(b), ratio: round(Math.exp(a)) };
}

/** Effort in size units, corrected: size × exp(a + b·ln(size/3)). */
export const effortScale = (m: EffortModel): EffortScale => (size) => size * Math.exp(m.a + m.b * Math.log(size / 3));

/** cdm B2: maximum a-posteriori temperature on top of Orion's beliefs, from observed levels. */
export function fitTemperature(obs: Observation[]): { n: number; t: number } {
  const xs = obs.filter((o) => o.dist && o.dist.length === 5 && wt(o) > 0);
  if (!xs.length) return { n: 0, t: 1 };
  const loss = (logT: number) => {
    const t = Math.exp(logT);
    return xs.reduce((a, o) => a - wt(o) * Math.log(Math.max(1e-12, temper(o.dist!, t)[Math.round(o.actual)])), 0) + logT ** 2 / (2 * LOG_T_SD ** 2);
  };
  return { n: xs.length, t: round(Math.exp(goldenMin(loss, -2, 2))) };
}

/** Ranked probability score for an ordinal belief and the observed level: 0 is perfect, lower is better. */
export function rps(p: number[], actual: number): number {
  let cp = 0, s = 0;
  for (let k = 0; k < p.length - 1; k++) { cp += p[k]; s += (cp - (k >= Math.round(actual) ? 1 : 0)) ** 2; }
  return s / (p.length - 1);
}

export function trackRecord(obs: Observation[]): TrackRecord {
  const xs = obs.filter((o) => o.dist && o.dist.length === 5 && wt(o) > 0);
  if (!xs.length) return { n: 0, rps: 0, skill: 0 };
  const W = xs.reduce((a, o) => a + wt(o), 0);
  const mean = xs.reduce((a, o) => a + wt(o) * rps(o.dist!, o.actual), 0) / W;
  const base = xs.reduce((a, o) => a + wt(o) * rps([0.2, 0.2, 0.2, 0.2, 0.2], o.actual), 0) / W;
  return { n: round(W), rps: round(mean), skill: round(base > 0 ? 1 - mean / base : 0) };
}

export function learn(obs: Observation[], shrink = SHRINK, shiftEffort = false): Learned {
  return { bias: biases(obs, shrink, shiftEffort), effort: effortModel(obs), temperature: fitTemperature(obs), record: trackRecord(obs) };
}

/** Move a five-level belief by `by` levels (fractional), keeping the mass inside the scale. */
export function shift(p: number[], by: number): number[] {
  const out = new Array<number>(p.length).fill(0);
  const last = p.length - 1;
  p.forEach((mass, i) => {
    const x = Math.max(0, Math.min(last, i + by));
    const lo = Math.floor(x), hi = Math.ceil(x), w = x - lo;
    out[lo] += mass * (1 - w);
    out[hi] += mass * w;
  });
  return out;
}

/** Orion's beliefs corrected by our track record: the fitted temperature, then the shrunk level bias. */
export function calibrated(dims: Dims, l: Pick<Learned, "bias"> & Partial<Pick<Learned, "temperature">>): Dims {
  const t = l.temperature?.t ?? 1;
  return Object.fromEntries(DIMS.map((d) => {
    const p = Math.abs(t - 1) > 1e-6 ? temper(dims[d], t) : dims[d];
    return [d, l.bias[d]?.applied ? shift(p, l.bias[d].bias) : p];
  })) as Dims;
}

function goldenMin(f: (x: number) => number, lo: number, hi: number, tol = 1e-5): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  while (b - a > tol) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

const round = (x: number) => Math.round(x * 100) / 100;
