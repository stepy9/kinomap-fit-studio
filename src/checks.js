// Flags data problems in a built workout before export; nothing here changes the exported data.
import { pauseGapSeconds } from "./fit.js";

const heartRateGapSeconds = 15;
const heartRateJumpBpm = 35;
const heartRateJumpSeconds = 2;
const heartRateRange = [35, 220];
// Warn when the watch window drops more than this share of the Kinomap distance (and at least the minimum).
const missedDistanceShare = 0.1;
const missedDistanceMinimum = 100;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

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
    if (kinomap && !trimmed) {
      const distances = kinomap.records.map((record) => record.distance).filter(Number.isFinite);
      const sourceDistance = distances.length ? Math.max(...distances) - Math.min(...distances) : 0;
      const missed = sourceDistance - workout.summary.distance;
      if (missed > missedDistanceMinimum && missed / sourceDistance > missedDistanceShare) {
        add("checkCoverage", "warning", { meters: Math.round(missed), percent: Math.round((missed / sourceDistance) * 100) });
      }
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
