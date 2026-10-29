// Flags data problems in a built workout before export; nothing here changes the exported data.
import { pauseGapSeconds } from "./fit.js";

const heartRateGapSeconds = 15;
const heartRateJumpBpm = 35;
const heartRateJumpSeconds = 2;
const heartRateRange = [35, 220];
// Warn when the watch window drops more than this share of the Kinomap distance (and at least the minimum).
const missedDistanceShare = 0.1;
const missedDistanceMinimum = 100;
// Kinomap keeps counting distance while an idle video plays; effort below this share of the typical power is ignored.
const activePowerShare = 0.5;
// Missed effort at this share of the typical power or more is the workout itself, not an easy warm-up or cool-down.
const workPowerShare = 0.9;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

// Distance trained outside the exported window: all active effort, and the part at full workout intensity.
function missedDistance(sourceRecords, window) {
  const powers = sourceRecords.map((record) => record.power).filter((value) => value > 0);
  const typical = powers.length ? median(powers) : null;
  const atLeast = (record, share) => typical == null || (record.power ?? 0) >= typical * share;
  let total = 0;
  let active = 0;
  let work = 0;
  for (let index = 1; index < sourceRecords.length; index += 1) {
    const before = sourceRecords[index - 1];
    const record = sourceRecords[index];
    const step = (record.distance ?? before.distance ?? 0) - (before.distance ?? 0);
    if (!(step > 0)) continue;
    total += step;
    const outside = record.timeMs <= window.startMs || before.timeMs >= window.endMs;
    if (!outside) continue;
    if (atLeast(record, activePowerShare)) active += step;
    if (atLeast(record, workPowerShare)) work += step;
  }
  return { total, active, work };
}

function heartRateGaps(records) {
  if (!records.some((record) => record.heartRate != null)) return null;
  let count = 0;
  let seconds = 0;
  let lastWithHeartRate = null;
  for (const record of records) {
    if (record.heartRate == null) continue;
    if (lastWithHeartRate) {
      const gap = (record.timeMs - lastWithHeartRate.timeMs) / 1000;
      // A recording pause is reported separately and is not a lost heart-rate signal.
      const paused = records.some((item, index) => index > 0
        && item.timeMs > lastWithHeartRate.timeMs && item.timeMs <= record.timeMs
        && item.timeMs - records[index - 1].timeMs > pauseGapSeconds * 1000);
      if (gap >= heartRateGapSeconds && !paused) {
        count += 1;
        seconds += gap;
      }
    }
    lastWithHeartRate = record;
  }
  return count ? { count, seconds: Math.round(seconds) } : null;
}

function heartRateSpikes(records) {
  let count = 0;
  let previous = null;
  let previousFlagged = false;
  for (const record of records) {
    if (record.heartRate == null) continue;
    const outOfRange = record.heartRate < heartRateRange[0] || record.heartRate > heartRateRange[1];
    const jump = previous && (record.timeMs - previous.timeMs) / 1000 <= heartRateJumpSeconds
      && Math.abs(record.heartRate - previous.heartRate) > heartRateJumpBpm;
    // The jump back down from a spike belongs to the same spike.
    const flagged = outOfRange || (jump && !previousFlagged);
    if (flagged) count += 1;
    previousFlagged = flagged;
    previous = record;
  }
  return count ? { count } : null;
}

function powerSpikes(records) {
  const powers = records.map((record) => record.power).filter((value) => value > 0);
  if (powers.length < 10) return null;
  const typical = median(powers);
  const threshold = Math.max(typical * 3, typical + 150);
  const spikes = powers.filter((value) => value > threshold);
  return spikes.length ? { count: spikes.length, max: Math.round(Math.max(...spikes)), typical: Math.round(typical) } : null;
}

function pauses(records) {
  let count = 0;
  let seconds = 0;
  for (let index = 1; index < records.length; index += 1) {
    const gap = (records[index].timeMs - records[index - 1].timeMs) / 1000;
    if (gap > pauseGapSeconds) {
      count += 1;
      seconds += gap;
    }
  }
  return count ? { count, minutes: Math.max(1, Math.round(seconds / 60)) } : null;
}

// Returns [{ code, severity: "warning" | "info", values }], most important first.
export function checkWorkout(workout, { kinomap = null, estimate = null, trimmed = false } = {}) {
  const issues = [];
  const add = (code, severity, values) => values && issues.push({ code, severity, values });
  const { records } = workout;

  if (workout.mode === "merge") {
    if (estimate?.confidence === "low") add("checkOffsetUncertain", "warning", { method: estimate.method });
    // Distance, not time: Kinomap often keeps an idle video running after the watch has stopped.
    if (kinomap && workout.sourceWindow && !trimmed) {
      const { total, active, work } = missedDistance(kinomap.records, workout.sourceWindow);
      const significant = (meters) => meters > missedDistanceMinimum && meters / total > missedDistanceShare;
      const values = (meters) => ({ meters: Math.round(meters), percent: Math.round((meters / total) * 100) });
      if (significant(work)) add("checkCoverage", "warning", values(work));
      else if (significant(active)) add("checkCoverageEasy", "info", values(active));
    }
  }
  add("checkHeartRateGaps", "warning", heartRateGaps(records));
  add("checkHeartRateSpikes", "warning", heartRateSpikes(records));
  add("checkPowerSpikes", "warning", powerSpikes(records));
  add("checkPauses", "info", pauses(records));
  if (!records.some((record) => record.heartRate != null)) add("checkNoHeartRate", "info", {});
  if (!records.some((record) => record.power != null)) add("checkNoPower", "info", {});
  return issues;
}
