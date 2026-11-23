import { expect, test } from "bun:test";
import { influence, type Link } from "../src/flow.ts";

test("influence follows both kinds of links through a branching chain at the shortest distance", () => {
  const links: Link[] = [
    { from: "research", to: "decision", kind: "boosts" },
    { from: "decision", to: "build", kind: "unblocks" },
    { from: "build", to: "launch", kind: "unblocks" },
    { from: "decision", to: "launch", kind: "boosts" },
    { from: "elsewhere", to: "unrelated", kind: "boosts" },
  ];
  const chain = influence("decision", links);
  expect(Object.fromEntries(chain.upstream)).toEqual({ research: 1 });
  expect(Object.fromEntries(chain.downstream)).toEqual({ build: 1, launch: 1 });
  expect(Object.fromEntries(influence("launch", links).upstream)).toEqual({ build: 1, decision: 1, research: 2 });
});

test("isolated tasks and malformed cycles terminate without tracing the task back to itself", () => {
  expect(influence("alone", []).downstream.size).toBe(0);
  const chain = influence("a", [
    { from: "a", to: "b", kind: "boosts" },
    { from: "b", to: "a", kind: "unblocks" },
    { from: "a", to: "a", kind: "boosts" },
  ]);
  expect(Object.fromEntries(chain.upstream)).toEqual({ b: 1 });
  expect(Object.fromEntries(chain.downstream)).toEqual({ b: 1 });
});
