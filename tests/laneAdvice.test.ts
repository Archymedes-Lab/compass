// The lane-advice rule: Jev's beliefs in, a deterministic lane out.
import { describe, expect, test } from "bun:test";
import { AGENT_P, decide, questions, SPLIT_P, WHO_CAN_FINISH } from "../src/laneAdvice.ts";

const who = (p: number[]) => p;
describe("lane advice", () => {
  test("agent end to end, no authority, checkable: agent lane", () => {
    expect(decide({ who: who([0.02, 0.03, 0.1, 0.35, 0.5]), authority: 0.1, verifiable: 0.9 }).advice).toBe("agent");
  });
  test("an agent could do it but a person's authority is likely: split, never agent", () => {
    expect(decide({ who: who([0.02, 0.03, 0.1, 0.35, 0.5]), authority: 0.8, verifiable: 0.9 }).advice).toBe("split");
  });
  test("success only a person can judge keeps it out of the unattended agent lane", () => {
    expect(decide({ who: who([0.02, 0.03, 0.1, 0.35, 0.5]), authority: 0.1, verifiable: 0.2 }).advice).toBe("split");
  });
  test("mostly a person's work: team", () => {
    expect(decide({ who: who([0.6, 0.2, 0.1, 0.05, 0.05]), authority: 0.9, verifiable: 0.3 }).advice).toBe("team");
  });
  test("the thresholds sit where the rule says", () => {
    const at = (pAgent: number) => decide({ who: [1 - pAgent, 0, 0, pAgent, 0], authority: 0, verifiable: 1 }).advice;
    expect(at(AGENT_P)).toBe("agent");
    expect(at(AGENT_P - 0.01)).toBe(SPLIT_P <= AGENT_P - 0.01 ? "split" : "team");
  });
  test("five situations, two yes/no questions, both scoped to a background agent without authority", () => {
    expect(WHO_CAN_FINISH).toHaveLength(5);
    const q = questions();
    expect(Object.keys(q).sort()).toEqual(["authority", "verifiable"]);
    expect(JSON.stringify(q)).toContain("cannot spend money, sign, deploy to production");
  });
});
