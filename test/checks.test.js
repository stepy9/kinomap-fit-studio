import assert from "node:assert/strict";
import test from "node:test";
import { checkWorkout } from "../src/checks.js";

const startMs = Date.parse("2026-01-08T17:00:00Z");
// One record per second; `patch` overrides fields for selected seconds.
function workout(seconds, patch = () => ({}), extra = {}) {
  const records = Array.from({ length: seconds + 1 }, (_, second) => ({
    timeMs: startMs + second * 1000, distance: second * 4, heartRate: 140, power: 150, cadence: 24, ...patch(second),
  }));
  return { mode: "convert", records, summary: { distance: records.at(-1).distance, durationSeconds: seconds }, ...extra };
}
const codes = (issues) => issues.map((issue) => issue.code);

test("reports nothing for clean data", () => {
  assert.deepEqual(checkWorkout(workout(300)), []);
});

test("flags heart-rate dropouts of 15 s or more but not shorter ones", () => {
  const issues = checkWorkout(workout(300, (second) => (
    (second > 50 && second < 70) || (second > 100 && second < 110) ? { heartRate: null } : {}
  )));
  const gap = issues.find((issue) => issue.code === "checkHeartRateGaps");
  assert.deepEqual(gap.values, { count: 1, seconds: 20 });
});

test("does not count a recording pause as a heart-rate dropout", () => {
  const records = workout(120).records.filter((record) => record.timeMs < startMs + 40_000 || record.timeMs > startMs + 90_000);
  const issues = checkWorkout({ ...workout(120), records });
  assert.deepEqual(codes(issues), ["checkPauses"]);
  assert.deepEqual(issues[0].values, { count: 1, minutes: 1 });
});

test("flags implausible heart-rate values and jumps", () => {
  const issues = checkWorkout(workout(300, (second) => (second === 10 ? { heartRate: 250 } : second === 200 ? { heartRate: 190 } : {})));
  assert.equal(issues.find((issue) => issue.code === "checkHeartRateSpikes").values.count, 2);
});

test("flags power spikes well above the typical value", () => {
  const issues = checkWorkout(workout(300, (second) => (second < 3 ? { power: 600 + second } : {})));
  assert.deepEqual(issues.find((issue) => issue.code === "checkPowerSpikes").values, { count: 3, max: 602, typical: 150 });
});

test("warns about an uncertain offset and about Kinomap distance the watch missed", () => {
  const kinomap = workout(600);
  const merged = workout(400, () => ({}), { mode: "merge" });
  const issues = checkWorkout(merged, { kinomap, estimate: { confidence: "low", method: "start-time" } });
  assert.deepEqual(codes(issues), ["checkOffsetUncertain", "checkCoverage"]);
  assert.deepEqual(issues[1].values, { meters: 800, percent: 33 });
  // A deliberate trim is not a coverage problem.
  assert.deepEqual(codes(checkWorkout(merged, { kinomap, trimmed: true })), []);
});

test("notes missing heart rate and power as information", () => {
  const issues = checkWorkout(workout(60, () => ({ heartRate: null, power: null })));
  assert.deepEqual(issues.map((issue) => [issue.code, issue.severity]), [["checkNoHeartRate", "info"], ["checkNoPower", "info"]]);
});
