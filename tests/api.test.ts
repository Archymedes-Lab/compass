// The store and state builder end to end, on an in-memory database and without calling Jev.
process.env.COMPASS_DB = ":memory:";
process.env.TYPESAFE_API_KEY = "";
import { describe, expect, test } from "bun:test";
const { openLocal } = await import("../src/local.ts");
openLocal();
const { db } = await import("../src/db.ts");
const { buildState, addTask, setStatus, predictedLevels, getTask, judgePending } = await import("../src/state.ts");

describe("state", () => {
  test("a finished task asks for a debrief at once; the daily check-in waits for its person", async () => {
    const a = addTask({ title: "Ship checkout", track: "revenue", owner: "Chris" });
    const b = addTask({ title: "Rotate keys", track: "trust" });
    await judgePending(); // fails fast without a key → uniform beliefs
    expect(getTask(a)!.judge).toBe("error");

    let s = buildState("Chris", false);
    expect(s.list.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(s.questions.daily).not.toBeNull();
    expect(s.questions.debriefs).toEqual([]);

    setStatus(a, "done", "Chris");
    s = buildState("Chris", false);
    expect(s.questions.debriefs.map((d) => d.taskId)).toEqual([a]);
    expect(s.list.map((x) => x.id)).toEqual([b]);

    db.query("INSERT INTO debriefs (task_id, who, at, result, effort, defensibility, quality, predicted) VALUES (?, 'Chris', ?, 'better', 3, 2, 3, ?)")
      .run(a, new Date().toISOString(), JSON.stringify(predictedLevels(getTask(a)!)));
    db.query("INSERT INTO checkins (who, date, at, updates) VALUES ('Chris', ?, ?, '{}')").run(s.today, new Date().toISOString());
    s = buildState("Chris", false);
    expect(s.questions.debriefs).toEqual([]);
    expect(s.questions.daily).toBeNull();
    expect(s.questions.checkedToday).toEqual(["Chris"]);
    expect(s.learning.bias.effort).toMatchObject({ n: 1, applied: false });
    expect(s.learning.dataPoints).toBe(2);
  });

  test("a team answer overrides Orion on that dimension", () => {
    const id = addTask({ title: "Patent", track: "ownership" });
    db.query("INSERT INTO answers (task_id, dim, level, who, at) VALUES (?, 'urgency', 4, 'Evan', ?)").run(id, new Date().toISOString());
    const row = buildState(null, false).list.find((x) => x.id === id)!;
    expect(row.teamAnswers.map((x) => x.dim)).toEqual(["urgency"]);
    expect(row.dims!.urgency[4]).toBeCloseTo(0.9);
  });
});
