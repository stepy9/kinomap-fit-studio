import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Decoder, Stream } from "@garmin/fitsdk";
import { buildWorkout, decodeGarminFit, estimateOffset, parseKinomap } from "../src/core.js";

const samplesRoot = path.resolve("samples");
const activities = fs.readdirSync(samplesRoot).map((folderName) => {
  const folder = path.join(samplesRoot, folderName);
  const files = fs.readdirSync(folder);
  return {
    folder,
    tcx: files.find((file) => file.toLowerCase().endsWith(".tcx")),
    fit: files.find((file) => file.toLowerCase().endsWith(".fit")),
    pwx: files.find((file) => file.toLowerCase().endsWith(".pwx")),
  };
}).filter((activity) => activity.tcx);

function readKinomap(activity) {
  return parseKinomap(fs.readFileSync(path.join(activity.folder, activity.tcx), "utf8"));
}

function sampleName(activity) {
  return `Kinomap - ${path.parse(activity.tcx).name.replace(/--\d+$/, "")}`;
}

function roundTrip(bytes) {
  const decoder = new Decoder(Stream.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const integrity = decoder.checkIntegrity();
  const decoded = decoder.read({ convertDateTimesToDates: true });
  assert.equal(integrity, true);
  assert.deepEqual(decoded.errors, []);
  return decoded.messages;
}

test("parses fields and UTC dates from all eight TCX samples", () => {
  assert.ok(activities.length >= 8);
  for (const activity of activities) {
    const parsed = readKinomap(activity);
    assert.ok(parsed.records.length > 100, activity.tcx);
    assert.ok(Number.isFinite(parsed.startMs));
    assert.ok(parsed.records.some((record) => record.distance != null));
    assert.ok(parsed.records.some((record) => record.cadence != null));
    assert.ok(parsed.records.some((record) => record.power != null));
    assert.equal(parsed.dateHasZone, true);
    assert.equal(parsed.needsManualStart, false);
  }
});

test("converts every TCX-only activity to a valid indoor-rowing FIT", () => {
  for (const activity of activities) {
    const workout = buildWorkout(readKinomap(activity), null, { activityName: sampleName(activity) });
    const messages = roundTrip(workout.fitBytes);
    assert.equal(messages.fileIdMesgs.length, 1);
    assert.equal(messages.recordMesgs.length, workout.records.length);
    assert.equal(messages.lapMesgs.length, 1);
    assert.equal(messages.sessionMesgs.length, 1);
    assert.equal(messages.activityMesgs.length, 1);
    assert.equal(messages.sessionMesgs[0].sport, "rowing");
    assert.equal(messages.sessionMesgs[0].subSport, "indoorRowing");
    assert.equal(messages.sessionMesgs[0].sportProfileName, sampleName(activity));
    assert.equal(messages.recordMesgs[0].distance, 0);
    assert.equal(messages.recordMesgs.some((record) => record.positionLat != null || record.positionLong != null || record.altitude != null), false);
  }
});

test("merges all five Garmin and Kinomap pairs with valid summaries", () => {
  const paired = activities.filter((activity) => activity.fit);
  assert.ok(paired.length >= 5);
  for (const activity of paired) {
    const kinomap = readKinomap(activity);
    const fit = decodeGarminFit(fs.readFileSync(path.join(activity.folder, activity.fit)));
    const estimate = estimateOffset(kinomap, fit);
    assert.ok(Number.isFinite(estimate.offsetSeconds));
    assert.ok(estimate.sampleCount > 0);
    const workout = buildWorkout(kinomap, fit, { offsetSeconds: estimate.offsetSeconds, activityName: sampleName(activity) });
    const messages = roundTrip(workout.fitBytes);
    assert.equal(messages.sessionMesgs[0].sport, "rowing");
    assert.equal(messages.sessionMesgs[0].subSport, "indoorRowing");
    assert.equal(messages.sessionMesgs[0].sportProfileName, sampleName(activity));
    assert.ok(messages.recordMesgs.length > 100);
    assert.ok(messages.recordMesgs.every((record) => record.heartRate != null));
    assert.ok(messages.recordMesgs.some((record) => record.power != null));
    assert.ok(messages.recordMesgs.some((record) => record.cadence != null));
    assert.ok(messages.recordMesgs.every((record) => record.positionLat == null && record.positionLong == null && record.altitude == null));
    assert.equal(messages.recordMesgs[0].distance, 0);
    assert.equal(messages.lapMesgs[0].totalDistance, messages.sessionMesgs[0].totalDistance);
    assert.equal(messages.activityMesgs[0].numSessions, 1);
    const activityMessage = messages.activityMesgs[0];
    const localDate = new Date(activityMessage.localTimestamp * 1000 + 631065600000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(activityMessage.timestamp).map((part) => [part.type, part.value]));
    assert.equal(localDate.toISOString(), `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000Z`);
    assert.ok(workout.summary.avgPower > 0);
    assert.ok(workout.summary.avgHeartRate > 0);
  }
});

test("parses Kinomap PWX samples too", () => {
  const activity = activities.find((item) => item.pwx);
  const parsed = parseKinomap(fs.readFileSync(path.join(activity.folder, activity.pwx), "utf8"));
  assert.equal(parsed.sourceType, "PWX");
  assert.ok(parsed.records.some((record) => record.power != null));
  assert.ok(parsed.records.some((record) => record.cadence != null));
});

test("maps indoor cycling and treadmill activities to matching FIT sports without GPS", () => {
  const activitiesToTest = [
    { sourceSport: "Biking", sport: "cycling", subSport: "indoorCycling", speed: 8.5 },
    { sourceSport: "Running", sport: "running", subSport: "treadmill", speed: 3.2 },
  ];
  for (const expected of activitiesToTest) {
    const xml = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="${expected.sourceSport}"><Id>2026-10-29T08:00:00Z</Id><Lap><Calories>20</Calories><Track><Trackpoint><Time>2026-10-29T08:00:00Z</Time><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>100</Value></HeartRateBpm><Cadence>80</Cadence><Extensions><TPX><Watts>120</Watts><Speed>${expected.speed}</Speed></TPX></Extensions></Trackpoint><Trackpoint><Time>2026-10-29T08:00:01Z</Time><DistanceMeters>5</DistanceMeters><HeartRateBpm><Value>101</Value></HeartRateBpm><Cadence>81</Cadence><Extensions><TPX><Watts>122</Watts><Speed>${expected.speed}</Speed></TPX></Extensions></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const parsed = parseKinomap(xml);
    assert.equal(parsed.sport, expected.sport);
    assert.equal(parsed.subSport, expected.subSport);
    assert.equal(parsed.records[0].speed, expected.speed);
    const messages = roundTrip(buildWorkout(parsed).fitBytes);
    assert.equal(messages.sessionMesgs[0].sport, expected.sport);
    assert.equal(messages.sessionMesgs[0].subSport, expected.subSport);
    assert.equal(messages.recordMesgs[0].speed, expected.speed);
    assert.equal(messages.recordMesgs[0].enhancedSpeed, expected.speed);
    assert.equal(messages.recordMesgs.some((record) => record.positionLat != null || record.positionLong != null || record.altitude != null), false);
  }
});

test("converts PWX cycling speed from km/h to FIT meters per second", () => {
  const pwx = `<?xml version="1.0"?><pwx><workout><sportType>Cycling</sportType><time>2026-10-29T08:00:00Z</time></workout><sample><timeoffset>0</timeoffset><spd>18</spd><dist>0</dist><cad>80</cad><pwr>120</pwr></sample><sample><timeoffset>1</timeoffset><spd>18</spd><dist>5</dist><cad>81</cad><pwr>122</pwr></sample></pwx>`;
  const parsed = parseKinomap(pwx);
  assert.equal(parsed.sport, "cycling");
  assert.equal(parsed.records[0].speed, 5);
  const messages = roundTrip(buildWorkout(parsed).fitBytes);
  assert.equal(messages.sessionMesgs[0].subSport, "indoorCycling");
  assert.equal(messages.recordMesgs[0].speed, 5);
  assert.equal(messages.recordMesgs[0].enhancedSpeed, 5);
});

test("interprets timezone-less timestamps in Europe/Prague with DST", () => {
  const xml = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="rowing"><Id>2026-07-01T12:00:00</Id><Lap><Calories>1</Calories><Track><Trackpoint><Time>2026-07-01T12:00:00</Time><DistanceMeters>0</DistanceMeters></Trackpoint><Trackpoint><Time>2026-07-01T12:00:01</Time><DistanceMeters>1</DistanceMeters></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const parsed = parseKinomap(xml);
  assert.equal(new Date(parsed.startMs).toISOString(), "2026-07-01T10:00:00.000Z");
  assert.equal(parsed.dateHasZone, false);
  assert.match(parsed.warnings[0], /Europe\/Prague/);
});

test("keeps invalid TCX dates available for a manual start-time correction", () => {
  const xml = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity><Id>not-a-date</Id><Lap><Track><Trackpoint><Time>not-a-date</Time><DistanceMeters>0</DistanceMeters></Trackpoint><Trackpoint><Time>not-a-date</Time><DistanceMeters>1</DistanceMeters></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const fallbackStartMs = Date.parse("2026-10-29T08:30:00Z");
  const parsed = parseKinomap(xml, { fallbackStartMs });
  assert.equal(parsed.needsManualStart, true);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.startMs, fallbackStartMs);
  const corrected = parseKinomap(xml, { fallbackStartMs, manualStart: "2026-10-29T10:00" });
  assert.equal(new Date(corrected.startMs).toISOString(), "2026-10-29T09:00:00.000Z");
});

test("applies start and end trims and rebases distance at zero", () => {
  const parsed = readKinomap(activities[0]);
  const workout = buildWorkout(parsed, null, { trimStartSeconds: 30, trimEndSeconds: 20 });
  assert.ok(workout.startMs >= parsed.startMs + 30_000);
  assert.ok(workout.endMs <= parsed.records.at(-1).timeMs - 20_000);
  assert.equal(workout.records[0].distance, 0);
});

test("does not interpolate source metrics across a long recording pause", () => {
  const startMs = Date.parse("2026-01-08T17:00:00Z");
  const kinomapRecords = [];
  for (let second = 0; second <= 10; second += 1) {
    kinomapRecords.push({ timeMs: startMs + second * 1000, distance: second * 2, cadence: 24, power: 120, heartRate: null });
  }
  for (let second = 25; second <= 35; second += 1) {
    kinomapRecords.push({ timeMs: startMs + second * 1000, distance: 20 + (second - 25) * 2, cadence: 24, power: 120, heartRate: null });
  }
  const kinomap = { startMs, records: kinomapRecords, calories: 20, warnings: [] };
  const fit = {
    startMs,
    records: Array.from({ length: 36 }, (_, second) => ({
      timeMs: startMs + second * 1000, distance: null, heartRate: 120, cadence: null, power: null,
    })),
  };
  const workout = buildWorkout(kinomap, fit);
  const timestamps = workout.records.map((record) => (record.timeMs - startMs) / 1000);
  assert.equal(timestamps.some((second) => second > 10 && second < 25), false);
  assert.ok(timestamps.includes(10));
  assert.ok(timestamps.includes(25));
  assert.equal(workout.records[0].distance, 0);
});

test("estimates elapsed-time alignment when calendar timestamps differ", () => {
  const kinomapStart = Date.parse("2026-01-08T17:00:00Z");
  const fitStart = kinomapStart + 4 * 24 * 60 * 60 * 1000;
  const pattern = Array.from({ length: 121 }, (_, index) => 70 + ((index * 37 + index * index * 13) % 80));
  const kinomap = {
    startMs: kinomapStart,
    calories: 15,
    records: pattern.map((heartRate, second) => ({
      timeMs: kinomapStart + second * 1000, distance: second * 2, heartRate, cadence: 24, power: 100,
    })),
  };
  const fit = {
    startMs: fitStart,
    records: pattern.map((heartRate, second) => ({
      timeMs: fitStart + second * 1000, distance: null, heartRate, cadence: null, power: null,
    })),
  };
  const estimate = estimateOffset(kinomap, fit, { alignmentMode: "elapsed", maxOffsetSeconds: 10 });
  const workout = buildWorkout(kinomap, fit, { alignmentMode: "elapsed", offsetSeconds: estimate.offsetSeconds });
  assert.equal(estimate.offsetSeconds, 0);
  assert.equal(workout.startMs, fitStart);
  assert.equal(workout.endMs, fitStart + 120_000);
  assert.equal(workout.records[0].distance, 0);
});

test("estimates offset from heart rate and watts when Kinomap heart rate is absent", () => {
  let seed = 41;
  const watts = Array.from({ length: 181 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return 80 + seed % 180;
  });
  const startMs = Date.parse("2026-01-08T17:00:00Z");
  const kinomap = {
    startMs,
    calories: null,
    records: watts.map((power, second) => ({ timeMs: startMs + second * 1000, distance: second, heartRate: null, cadence: 24, power })),
  };
  const fit = {
    startMs,
    records: watts.map((_, second) => ({
      timeMs: startMs + second * 1000,
      distance: null,
      heartRate: second >= 12 ? watts[second - 12] : null,
      cadence: null,
      power: null,
    })),
  };
  const estimate = estimateOffset(kinomap, fit, { maxOffsetSeconds: 30 });
  assert.equal(estimate.offsetSeconds, 12);
  assert.equal(estimate.method, "heart-rate-power");
});

test("rejects merge settings without a common time window", () => {
  const activity = activities.find((item) => item.fit);
  const fit = decodeGarminFit(fs.readFileSync(path.join(activity.folder, activity.fit)));
  assert.throws(() => buildWorkout(readKinomap(activity), fit, { offsetSeconds: 3600 }), /společný časový úsek/);
});