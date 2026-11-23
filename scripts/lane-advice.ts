// Advise a lane for every open task on a Compass instance, with Jev's beliefs and src/laneAdvice.ts's rule.
//
//   COMPASS_URL=https://compass.archymedes.xyz COMPASS_TOKEN=<agent token> TYPESAFE_API_KEY=... bun scripts/lane-advice.ts [--json FILE]
//
// Reads the team and agent lanes through the agent API (read only), asks Jev one request per task (task title, done-when
// and steps: what Compass already sends Jev to judge a task), prints the advice. Moves nothing.
import { systemOne, type SystemOneQuestion } from "../../orion/server/typesafe.ts";
import { belief, relabel, reversalOrbit } from "../../orion/src/decision-engine/creative.ts";
import { decide, questions, WHO_CAN_FINISH } from "../src/laneAdvice.ts";

const url = process.env.COMPASS_URL ?? "https://compass.archymedes.xyz";
const token = process.env.COMPASS_TOKEN;
if (!token) throw new Error("COMPASS_TOKEN (an agent token) is required");
const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

interface Next { id: string; title: string; doneWhen: string; steps: { text: string }[]; lane: string; track: string }
const read = async (lane: string) => {
  const r = await fetch(`${url}/api/agent/next?lane=${lane}&limit=50`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${lane}: ${r.status}`);
  return ((await r.json()) as { next: Next[] }).next;
};
// --candidates FILE: judge proposed tasks (a JSON list of {title, doneWhen, steps: string[]}) instead of the live ones.
const cand = process.argv.includes("--candidates") ? process.argv[process.argv.indexOf("--candidates") + 1] : null;
const tasks: Next[] = cand
  ? ((await Bun.file(cand).json()) as { title: string; doneWhen?: string; steps?: string[]; track?: string }[]).map((c, i) => ({
    id: `candidate-${i}`, title: c.title, doneWhen: c.doneWhen ?? "", steps: (c.steps ?? []).map((text) => ({ text })), lane: "new", track: c.track ?? "other" }))
  : [...(await read("team")), ...(await read("agent"))];

const rows = [];
for (const t of tasks) {
  const qs: Record<string, SystemOneQuestion> = questions();
  const orbit = reversalOrbit(WHO_CAN_FINISH.length).map((order, g) => {
    qs[`who@${g}`] = { type: "score", instructions: { question: "Who can finish `option`?", scope: "See the other questions' scope: the agent is a background coding agent in a cloud sandbox." }, criteria: order.map((i) => WHO_CAN_FINISH[i]) };
    return { qid: `who@${g}`, order };
  });
  const option = [t.title, t.doneWhen ? `Done when: ${t.doneWhen}` : "", t.steps.length ? `Steps: ${t.steps.map((s) => s.text).join("; ")}` : ""].filter(Boolean).join("\n");
  try {
    const res = await systemOne({ decision: "A small team builds a software product; before revenue.", option }, qs, { timeoutMs: 40_000 });
    const decoded = orbit.map((p) => {
      const a = res.answers[p.qid];
      if (!a || a.type !== "score") throw new Error("incomplete answer");
      return relabel(p.order.map((_, k) => Number(a.probabilities[String(k)] ?? 0)), p.order);
    });
    const who = belief("score", decoded);
    const num = (k: string) => { const a = res.answers[k]; if (!a || a.type !== "noul") throw new Error(`no ${k}`); return a.noul; };
    const b = { who, authority: num("authority"), verifiable: num("verifiable") };
    rows.push({ id: t.id, title: t.title, lane: t.lane, ...decide(b), authority: Math.round(b.authority * 100) / 100, verifiable: Math.round(b.verifiable * 100) / 100 });
  } catch (e) {
    rows.push({ id: t.id, title: t.title, lane: t.lane, advice: "unavailable", error: String(e instanceof Error ? e.message : e).slice(0, 120) });
  }
}
for (const r of rows) {
  const x = r as Record<string, unknown>;
  console.log(`${String(x.advice).padEnd(11)} now:${String(x.lane).padEnd(5)} pAgent ${x.pAgent ?? "-"} pWork ${x.pWork ?? "-"} alone ${x.pAlone ?? "-"} auth ${x.authority ?? "-"} check ${x.verifiable ?? "-"}  ${String(x.title).slice(0, 70)}`);
}
if (out) await Bun.write(out, JSON.stringify(rows, null, 2));
