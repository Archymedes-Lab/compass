// Which lane a task belongs in, advised the Orion way: Jev gives beliefs, this file decides (deterministic, testable).
//
// One score question ("who can finish this?", five situations from "only a person" to "an agent alone, unattended in a
// cloud sandbox"), asked in both level orders and pooled like every Compass judgment (src/judge.ts), plus two yes/no
// questions: does finishing need a person's authority (approval, credentials, money, a signature, a conversation), and
// can success be checked automatically (tests, CI, a URL, a file)? The thresholds below are the whole rule.
// Advice only: a person moves tasks between lanes (an agent cannot, src/api.ts).
import type { SystemOneQuestion } from "../../orion/server/typesafe.ts";

export const WHO_CAN_FINISH = [
  "Only a person can do it: it needs their authority, accounts, money, signature, or conversations with people",
  "A person does it; an agent can prepare material (research, drafts, data) beforehand",
  "An agent does the work; a person must approve one checkpoint (a merge, a deploy, a payment, a send)",
  "An agent does it end to end; a person reviews the result afterwards",
  "An agent does it alone, unattended in a cloud sandbox with the code repository and CI, and tests prove it worked",
];

/** The rule. P(agent end to end) at least AGENT_P, authority unlikely, success checkable: the agent lane. */
export const AGENT_P = 0.6;
export const AUTHORITY_MAX = 0.3;
export const VERIFIABLE_MIN = 0.5;
/** P(an agent does the work, with or without a checkpoint) at least SPLIT_P: agent lane with a person's checkpoint. */
export const SPLIT_P = 0.6;

export type Advice = "agent" | "split" | "team";
export interface Beliefs { who: number[]; authority: number; verifiable: number }

export function decide(b: Beliefs): { advice: Advice; pAgent: number; pWork: number; pAlone: number } {
  const pAgent = b.who[3] + b.who[4], pWork = b.who[2] + pAgent, pAlone = b.who[4];
  const advice: Advice = pAgent >= AGENT_P && b.authority <= AUTHORITY_MAX && b.verifiable >= VERIFIABLE_MIN ? "agent"
    : pWork >= SPLIT_P ? "split" : "team";
  return { advice, pAgent: r(pAgent), pWork: r(pWork), pAlone: r(pAlone) };
}

const SCOPE = "Judge only `option`, a task at Archymedes (a two-founder security software startup, described in `decision`). "
  + "The agent is a coding agent (like Claude Code or Codex) running in the background in a cloud sandbox: it can read and change the "
  + "code repositories, run tests and CI, search the web, open pull requests and use the team's task board. It holds no personal "
  + "accounts, cannot spend money, sign, deploy to production, merge without approval, or speak for the company to people.";

export function questions(): Record<string, SystemOneQuestion> {
  return {
    authority: { type: "noul", instructions: { question: "Does finishing `option` require a person's authority: an approval, their account or credentials, spending money, a legal signature, or talking to customers, partners or officials?", scope: SCOPE },
      criteria: { true: "At least one step needs a person's authority, account, money, signature or a conversation", false: "Every step can be done with code, tests, research and pull requests" } },
    verifiable: { type: "noul", instructions: { question: "Can success on `option` be checked automatically, by tests, CI, a URL that answers, or a file that exists with the right content?", scope: SCOPE },
      criteria: { true: "A machine can check that it is done", false: "Only a person's judgement can tell whether it is done" } },
  };
}

const r = (x: number) => Math.round(x * 100) / 100;
