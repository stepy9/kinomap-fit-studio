import { XMLParser } from "fast-xml-parser";
import { decodeGarminFit, encodeFit } from "./fit.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const number = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function parseLocalTime(value, timeZone) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second = "00", fraction = ""] = match;
  const desired = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, Number(`0.${fraction}`) * 1000);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let epoch = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]));
    epoch += desired - Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  }
  return epoch;
}

function timestamp(value, timeZone) {
  const text = String(value ?? "").trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  return { epochMs: hasZone ? Date.parse(text) : parseLocalTime(text, timeZone), hasZone };
}

function pathValue(source, path) {
  return path.split(".").reduce((value, part) => value?.[part], source);
}

function manualStart(value, timeZone) {
  if (value instanceof Date) return value.getTime();
  if (!value) return null;
  const parsed = timestamp(value, timeZone).epochMs;
  return Number.isFinite(parsed) ? parsed : null;
}

function validated(records, label) {
  const sorted = records.filter((record) => Number.isFinite(record.timeMs)).sort((a, b) => a.timeMs - b.timeMs);
  // Kinomap occasionally stamps a point one second early (t, t, t+2); move it into the gap, otherwise drop the duplicate.
  const unique = [];
  sorted.forEach((record, index) => {
    const previous = unique.at(-1);
    if (!previous || record.timeMs > previous.timeMs) unique.push(record);
    else if ((sorted[index + 1]?.timeMs ?? -Infinity) - previous.timeMs >= 2000) unique.push({ ...record, timeMs: previous.timeMs + 1000 });
  });
  if (unique.length < 2) throw new Error(`${label}: potřebuji alespoň dva časové záznamy.`);
  return unique;
}

function sportProfile(value) {
  const normalized = String(value ?? "rowing").toLowerCase().replace(/[^a-z]/g, "");
  if (["cycling", "biking", "bicycling", "bike", "indoorcycling", "spin"].includes(normalized)) {
    return { sport: "cycling", subSport: "indoorCycling", sportLabel: "Cyklistika na trenažéru" };
  }
  if (["running", "run", "treadmill", "indoorrunning"].includes(normalized)) {
    return { sport: "running", subSport: "treadmill", sportLabel: "Běh na pásu" };
  }
  return { sport: "rowing", subSport: "indoorRowing", sportLabel: "Veslování uvnitř" };
}

// Running cadence may arrive per leg (strides/min, ~75–95) or as steps/min (~150–190); keep steps/min internally.
function normalizedCadence(records, sport) {
  if (sport !== "running") return records;
  const cadences = records.map((record) => record.cadence).filter((value) => value > 0).sort((a, b) => a - b);
  if (!cadences.length || cadences[cadences.length >> 1] >= 120) return records;
  return records.map((record) => ({ ...record, cadence: record.cadence == null ? null : record.cadence * 2 }));
}

export function parseKinomap(xml, options = {}) {
  const timeZone = options.timeZone ?? "Europe/Prague";
  const source = parser.parse(xml);

  if (source.pwx) {
    const workout = source.pwx.workout ?? {};
    const profile = sportProfile(workout.sportType);
    const parsedStart = timestamp(workout.time, timeZone);
    const startMs = manualStart(options.manualStart, timeZone)
      ?? (Number.isFinite(parsedStart.epochMs) ? parsedStart.epochMs : options.fallbackStartMs ?? Date.now());
    const records = array(source.pwx.sample).map((sample) => {
      const elapsed = number(sample.timeoffset) ?? 0;
      const hr = number(sample.hr);
      return {
        timeMs: startMs + elapsed * 1000,
        distance: number(sample.dist),
        heartRate: hr > 0 ? hr : null,
        cadence: number(sample.cad),
        power: number(sample.pwr),
        speed: number(sample.spd) == null ? null : number(sample.spd) / 3.6,
      };
    });
    return {
      ...profile, sourceType: "PWX", startMs, records: normalizedCadence(validated(records, "PWX"), profile.sport), calories: null,
      dateHasZone: parsedStart.hasZone,
      warnings: parsedStart.hasZone ? [] : ["Čas v PWX nemá pásmo; vyložen jako Europe/Prague."],
    };
  }

  const database = source.TrainingCenterDatabase ?? source;
  const activity = array(database.Activities?.Activity)[0];
  if (!activity) throw new Error("Soubor neobsahuje TCX aktivitu.");
  const profile = sportProfile(activity["@_Sport"]);
  const lap = array(activity.Lap)[0] ?? {};
  const points = array(lap.Track?.Trackpoint);
  if (!points.length) throw new Error("TCX neobsahuje žádné trackpointy.");

  const startText = points.find((point) => point.Time)?.Time ?? activity.Id ?? lap["@_StartTime"];
  const parsedStart = timestamp(startText, timeZone);
  const adjustedStart = manualStart(options.manualStart, timeZone);
  const startMs = adjustedStart
    ?? (Number.isFinite(parsedStart.epochMs) ? parsedStart.epochMs : options.fallbackStartMs ?? Date.now());
  const records = points.map((point, index) => {
    const parsed = timestamp(point.Time, timeZone);
    const elapsed = Number.isFinite(parsed.epochMs) && Number.isFinite(parsedStart.epochMs)
      ? parsed.epochMs - parsedStart.epochMs
      : index * 1000;
    const hr = number(point.HeartRateBpm?.Value);
    return {
      timeMs: startMs + elapsed,
      distance: number(point.DistanceMeters),
      heartRate: hr > 0 ? hr : null,
      cadence: number(point.Cadence),
      power: number(pathValue(point, "Extensions.TPX.Watts") ?? pathValue(point, "Extensions.Watts") ?? point.Watts),
      speed: number(pathValue(point, "Extensions.TPX.Speed") ?? pathValue(point, "Extensions.Speed") ?? point.Speed),
    };
  });

  const year = Number.isFinite(parsedStart.epochMs) ? new Date(parsedStart.epochMs).getUTCFullYear() : NaN;
  const needsManualStart = !Number.isFinite(parsedStart.epochMs) || year < 2000 || year > new Date().getUTCFullYear() + 1;
  const warnings = [];
  if (!parsedStart.hasZone) warnings.push("Čas v TCX nemá pásmo; vyložen jako Europe/Prague.");
  if (needsManualStart && adjustedStart == null) warnings.push("Datum vypadá neplatně; zadejte místní začátek tréninku.");
  if (!records.some((record) => record.power != null)) warnings.push("TCX neobsahuje watty.");

  return {
    ...profile, sourceType: "TCX", startMs, records: normalizedCadence(validated(records, "TCX"), profile.sport),
    calories: number(lap.Calories), dateHasZone: parsedStart.hasZone, needsManualStart, warnings,
  };
}

function interpolate(records, timeMs, field, maxGapSeconds = 10) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (records[middle].timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  const after = records[low];
  const before = records[low - 1];
  if (after?.timeMs === timeMs) return after[field];
  if (before?.timeMs === timeMs) return before[field];
  if (!before || !after || after.timeMs - before.timeMs > maxGapSeconds * 1000) return null;
  if (before[field] == null || after[field] == null) return null;
  const ratio = (timeMs - before.timeMs) / (after.timeMs - before.timeMs);
  return before[field] + (after[field] - before[field]) * ratio;
}

function correlation(left, right) {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] - leftMean;
    const y = right[index] - rightMean;
    numerator += x * y;
    leftVariance += x * x;
    rightVariance += y * y;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? numerator / denominator : 0;
}

export function estimateOffset(kinomap, fit, options = {}) {
  const maxOffset = Math.max(0, options.maxOffsetSeconds ?? 600);
  const alignmentMode = options.alignmentMode ?? "absolute";
  const fields = kinomap.records.some((record) => record.heartRate != null) ? ["heartRate", "power"] : ["power"];
  let best = null;
  for (const field of fields) {
    for (let offset = -maxOffset; offset <= maxOffset; offset += 1) {
      const watch = [];
      const source = [];
      for (let index = 0; index < fit.records.length; index += 2) {
        const record = fit.records[index];
        if (record.heartRate == null) continue;
        const kinomapTime = alignmentMode === "elapsed"
          ? kinomap.startMs + (record.timeMs - fit.startMs) - offset * 1000
          : record.timeMs - offset * 1000;
        const value = interpolate(kinomap.records, kinomapTime, field);
        if (value != null) {
          watch.push(record.heartRate);
          source.push(value);
        }
      }
      if (watch.length < (options.minimumSamples ?? 60)) continue;
      const score = Math.abs(correlation(watch, source)) * Math.min(1, watch.length / Math.max(120, fit.records.length / 2));
      if (!best || score > best.score) best = { offset, score, correlation: correlation(watch, source), count: watch.length, field };
    }
  }
  if (!best || Math.abs(best.correlation) < 0.15) {
    return {
      offsetSeconds: alignmentMode === "elapsed" ? 0 : Math.round((fit.startMs - kinomap.startMs) / 1000),
      correlation: best?.correlation ?? 0, sampleCount: best?.count ?? 0,
      method: "start-time", confidence: "low",
    };
  }
  return {
    offsetSeconds: best.offset, correlation: best.correlation, sampleCount: best.count,
    method: best.field === "heartRate" ? "heart-rate" : "heart-rate-power",
    confidence: Math.abs(best.correlation) >= 0.6 ? "high" : "medium",
  };
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const values = (records, field) => records.map((record) => record[field]).filter(Number.isFinite);

export const defaultLapDistances = { rowing: 500, running: 1000, cycling: 5000 };
export const lapDistancePresets = {
  rowing: [250, 500, 1000, 2000],
  running: [400, 1000, 1609.344, 5000],
  cycling: [1000, 5000, 10000, 20000],
};

export function defaultLapDistance(sport) {
  return defaultLapDistances[sport] ?? defaultLapDistances.rowing;
}

function cyclesFor(records) {
  let cycles = 0;
  for (let index = 1; index < records.length; index += 1) {
    const before = records[index - 1];
    const after = records[index];
    const seconds = (after.timeMs - before.timeMs) / 1000;
    if (seconds > 10 || before.cadence == null || after.cadence == null) continue;
    cycles += (before.cadence + after.cadence) / 2 * seconds / 60;
  }
  return cycles;
}

function summaryFor(records, durationSeconds, calories, sport) {
  const hr = values(records, "heartRate");
  const power = values(records, "power");
  const cadence = values(records, "cadence");
  const speed = values(records, "speed");
  const distance = records.at(-1).distance - records[0].distance;
  // Running cadence is in steps/min, while FIT counts running cycles as strides (one per two steps).
  const cycles = cadence.length ? Math.round(cyclesFor(records) / (sport === "running" ? 2 : 1)) : null;
  return {
    startMs: records[0].timeMs,
    endMs: records.at(-1).timeMs,
    durationSeconds,
    distance,
    cycles,
    avgStrokeDistance: sport === "rowing" && cycles ? distance / cycles : null,
    calories: Math.max(0, Math.round(calories)),
    avgHeartRate: hr.length ? Math.round(mean(hr)) : null,
    maxHeartRate: hr.length ? Math.max(...hr) : null,
    avgPower: power.length ? Math.round(mean(power)) : null,
    maxPower: power.length ? Math.max(...power) : null,
    avgCadence: cadence.length ? Math.round(mean(cadence)) : null,
    maxCadence: cadence.length ? Math.max(...cadence) : null,
    avgSpeed: speed.length ? mean(speed) : null,
    maxSpeed: speed.length ? Math.max(...speed) : null,
  };
}

function lapsFor(records, lapDistance, calories, durationSeconds, sport) {
  const groups = [];
  let current = [records[0]];
  let boundary = lapDistance > 0 ? lapDistance : Infinity;
  for (let index = 1; index < records.length; index += 1) {
    const before = records[index - 1];
    const record = records[index];
    // Close each lap at a point interpolated exactly on the lap boundary, not on the next sample.
    while (record.distance >= boundary && index < records.length - 1) {
      const ratio = record.distance === before.distance ? 1 : (boundary - before.distance) / (record.distance - before.distance);
      const point = { timeMs: before.timeMs + (record.timeMs - before.timeMs) * ratio, distance: boundary };
      for (const field of ["heartRate", "cadence", "power", "speed"]) {
        point[field] = before[field] == null || record[field] == null ? null : before[field] + (record[field] - before[field]) * ratio;
      }
      current.push(point);
      groups.push(current);
      current = [point];
      boundary += lapDistance;
    }
    current.push(record);
  }
  // A remainder shorter than 10 % of the lap distance is folded into the previous lap.
  const remainder = current.at(-1).distance - current[0].distance;
  if (groups.length && remainder < lapDistance * 0.1) groups.push([...groups.pop(), ...current.slice(1)]);
  else groups.push(current);
  return groups.map((group) => {
    const seconds = (group.at(-1).timeMs - group[0].timeMs) / 1000;
    return summaryFor(group, seconds, calories * seconds / Math.max(1, durationSeconds), sport);
  });
}

export function buildWorkout(kinomap, fit = null, options = {}) {
  const timeZone = options.timeZone ?? "Europe/Prague";
  const alignmentMode = options.alignmentMode ?? "absolute";
  const offsetMs = (Number(options.offsetSeconds) || 0) * 1000;
  const trimStartMs = Math.max(0, Number(options.trimStartSeconds) || 0) * 1000;
  const trimEndMs = Math.max(0, Number(options.trimEndSeconds) || 0) * 1000;
  let records;
  let startMs;
  let endMs;

  if (fit) {
    const baseShift = alignmentMode === "elapsed" ? fit.startMs - kinomap.startMs : 0;
    startMs = Math.max(kinomap.records[0].timeMs + baseShift + offsetMs, fit.records[0].timeMs) + trimStartMs;
    endMs = Math.min(kinomap.records.at(-1).timeMs + baseShift + offsetMs, fit.records.at(-1).timeMs) - trimEndMs;
    if (endMs <= startMs) throw new Error("Po zarovnání a ořezu nezůstal společný časový úsek.");
    records = fit.records.filter((record) => record.timeMs >= startMs && record.timeMs <= endMs).map((watch) => {
      const kinomapTime = watch.timeMs - baseShift - offsetMs;
      return {
        timeMs: watch.timeMs,
        distance: interpolate(kinomap.records, kinomapTime, "distance"),
        heartRate: watch.heartRate ?? interpolate(kinomap.records, kinomapTime, "heartRate"),
        cadence: interpolate(kinomap.records, kinomapTime, "cadence"),
        power: interpolate(kinomap.records, kinomapTime, "power"),
        speed: interpolate(kinomap.records, kinomapTime, "speed") ?? watch.speed,
      };
    }).filter((record) => record.distance != null);
    if (records.length < 2) throw new Error("Ve společném úseku nejsou dostatečné záznamy.");
  } else {
    startMs = kinomap.records[0].timeMs + trimStartMs;
    endMs = kinomap.records.at(-1).timeMs - trimEndMs;
    if (endMs <= startMs) throw new Error("Po ořezu nezůstal časový úsek.");
    records = kinomap.records.filter((record) => record.timeMs >= startMs && record.timeMs <= endMs).map((record) => ({ ...record }));
    if (records.length < 2) throw new Error("Po ořezu nezůstaly dostatečné záznamy.");
  }

  const firstDistance = records[0].distance ?? 0;
  records = records.map((record) => ({ ...record, distance: Math.max(0, (record.distance ?? firstDistance) - firstDistance) }));
  startMs = records[0].timeMs;
  endMs = records.at(-1).timeMs;
  const durationSeconds = (endMs - startMs) / 1000;
  const sourceDuration = Math.max(1, (kinomap.records.at(-1).timeMs - kinomap.records[0].timeMs) / 1000);
  const calories = kinomap.calories == null
    ? (mean(values(records, "power")) ?? 0) * durationSeconds * 0.0012
    : kinomap.calories * durationSeconds / sourceDuration;
  const summary = summaryFor(records, durationSeconds, calories, kinomap.sport);
  const lapDistance = options.lapDistanceMeters == null || options.lapDistanceMeters === ""
    ? defaultLapDistance(kinomap.sport)
    : Math.max(0, Number(options.lapDistanceMeters) || 0);
  const laps = lapsFor(records, lapDistance, calories, durationSeconds, kinomap.sport);
  const activityName = String(options.activityName ?? "Kinomap - Rowing Workout").trim();
  const fitBytes = encodeFit(records, summary, laps, startMs, endMs, timeZone, activityName, kinomap.sport, kinomap.subSport);
  return {
    mode: fit ? "merge" : "convert", records, startMs, endMs, summary, laps, lapDistance, activityName,
    sport: kinomap.sport, subSport: kinomap.subSport, sportLabel: kinomap.sportLabel,
    fitBytes, warnings: [...(kinomap.warnings ?? [])],
  };
}

export { decodeGarminFit };