import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Decoder, Stream } from "@garmin/fitsdk";
import { buildWorkout, decodeGarminFit, estimateOffset, parseKinomap } from "../src/core.js";
import { translations } from "../src/i18n.js";

const fixturesRoot = path.resolve("test", "fixtures");
// Synthetic fixtures from scripts/generate-fixtures.mjs; the watch heart rate lags Kinomap by this offset.
const fixtureOffsetSeconds = 7;
const fixtures = [
  { sport: "rowing", subSport: "indoorRowing", laps: 4 },
  { sport: "cycling", subSport: "indoorCycling", laps: 2 },
  { sport: "running", subSport: "treadmill", laps: 2 },
].map((fixture) => ({ ...fixture, folder: path.join(fixturesRoot, fixture.sport) }));

const readFixture = (fixture, file) => fs.readFileSync(path.join(fixture.folder, file), file.endsWith(".fit") ? undefined : "utf8");
const fixtureKinomap = (fixture, file = "activity.tcx") => parseKinomap(readFixture(fixture, file));
const fixtureFit = (fixture) => decodeGarminFit(readFixture(fixture, "watch.fit"));

// Private real-world recordings live in the git-ignored samples folder; their test is skipped when it is absent.
const samplesRoot = path.resolve("samples");
const samples = fs.existsSync(samplesRoot) ? fs.readdirSync(samplesRoot).map((folderName) => {
  const folder = path.join(samplesRoot, folderName);
  const files = fs.readdirSync(folder);
  return {
    folder,
    tcx: files.find((file) => file.toLowerCase().endsWith(".tcx")),
    fit: files.find((file) => file.toLowerCase().endsWith(".fit") && !file.startsWith("Kinomap - ")),
  };
}).filter((sample) => sample.tcx) : [];
const skipSamples = samples.length ? false : "samples folder not present";

function roundTrip(bytes) {
  const decoder = new Decoder(Stream.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const integrity = decoder.checkIntegrity();
  const decoded = decoder.read({ convertDateTimesToDates: true });
  assert.equal(integrity, true);
  assert.deepEqual(decoded.errors, []);
  return decoded.messages;
}

test("defines every static interface translation in Czech and English", () => {
  const html = fs.readFileSync(path.resolve("index.html"), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 30);
  for (const language of ["cs", "en"]) {
    for (const key of keys) assert.ok(translations[language][key], `${language}.${key} is missing`);
  }
});

for (const fixture of fixtures) {
  test(`parses ${fixture.sport} TCX and PWX fixtures into the same records`, () => {
    const tcx = fixtureKinomap(fixture);
    const pwx = fixtureKinomap(fixture, "activity.pwx");
    for (const parsed of [tcx, pwx]) {
      assert.equal(parsed.sport, fixture.sport);
      assert.equal(parsed.subSport, fixture.subSport);
      assert.equal(parsed.records.length, 601);
      assert.equal(parsed.dateHasZone, true);
      assert.ok(parsed.records.some((record) => record.power != null));
      assert.ok(parsed.records.some((record) => record.cadence != null));
      assert.ok(parsed.records.some((record) => record.heartRate != null));
    }
    assert.equal(tcx.needsManualStart, false);
    assert.equal(tcx.sourceType, "TCX");
    assert.equal(pwx.sourceType, "PWX");
    assert.equal(pwx.startMs, tcx.startMs);
    assert.equal(pwx.records.at(-1).distance, tcx.records.at(-1).distance);
    assert.ok(Math.abs(pwx.records[100].speed - tcx.records[100].speed) < 0.03);
  });

  test(`converts the ${fixture.sport} fixture to a valid FIT with sport laps`, () => {
    const workout = buildWorkout(fixtureKinomap(fixture), null, { activityName: `Kinomap - ${fixture.sport}` });
    const messages = roundTrip(workout.fitBytes);
    assert.equal(messages.fileIdMesgs.length, 1);
    assert.equal(messages.fileIdMesgs[0].manufacturer, "development");
    assert.equal(messages.recordMesgs.length, workout.records.length);
    assert.equal(messages.sessionMesgs.length, 1);
    assert.equal(messages.activityMesgs.length, 1);
    assert.equal(messages.sessionMesgs[0].sport, fixture.sport);
    assert.equal(messages.sessionMesgs[0].subSport, fixture.subSport);
    assert.equal(messages.sessionMesgs[0].sportProfileName, `Kinomap - ${fixture.sport}`);
    assert.equal(messages.lapMesgs.length, fixture.laps);
    assert.equal(messages.sessionMesgs[0].numLaps, fixture.laps);
    assert.equal(messages.recordMesgs[0].distance, 0);
    assert.equal(messages.recordMesgs.some((record) => record.positionLat != null || record.positionLong != null || record.altitude != null), false);
    assert.ok(messages.sessionMesgs[0].totalCycles > 0);
    if (fixture.sport === "running") {
      // FIT running cadence is strides/min; 168 steps/min is written as 84.
      assert.ok(messages.sessionMesgs[0].avgCadence >= 75 && messages.sessionMesgs[0].avgCadence <= 95);
      assert.ok(messages.recordMesgs.every((record) => record.cadence == null || record.cadence < 100));
    }
  });

  test(`merges the ${fixture.sport} fixture with its watch FIT at the expected offset`, () => {
    const kinomap = fixtureKinomap(fixture);
    const fit = fixtureFit(fixture);
    assert.equal(fit.fileId.manufacturer, "garmin");
    const estimate = estimateOffset(kinomap, fit);
    assert.equal(estimate.offsetSeconds, fixtureOffsetSeconds);
    assert.equal(estimate.method, "heart-rate");
    assert.equal(estimate.confidence, "high");
    const workout = buildWorkout(kinomap, fit, { offsetSeconds: estimate.offsetSeconds });
    const messages = roundTrip(workout.fitBytes);
    assert.equal(messages.sessionMesgs[0].sport, fixture.sport);
    assert.ok(messages.recordMesgs.every((record) => record.heartRate != null));
    assert.ok(messages.recordMesgs.some((record) => record.power != null));
    assert.ok(messages.recordMesgs.some((record) => record.cadence != null));
    assert.equal(messages.recordMesgs[0].distance, 0);
    const lapDistance = messages.lapMesgs.reduce((sum, lap) => sum + lap.totalDistance, 0);
    assert.ok(Math.abs(lapDistance - messages.sessionMesgs[0].totalDistance) < 0.1);
    const activityMessage = messages.activityMesgs[0];
    const localDate = new Date(activityMessage.localTimestamp * 1000 + 631065600000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(activityMessage.timestamp).map((part) => [part.type, part.value]));
    assert.equal(localDate.toISOString(), `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000Z`);
    assert.ok(workout.summary.avgPower > 0);
    assert.ok(workout.summary.avgHeartRate > 0);
  });
}

test("converts and merges every private sample recording", { skip: skipSamples }, () => {
  for (const sample of samples) {
    const kinomap = parseKinomap(fs.readFileSync(path.join(sample.folder, sample.tcx), "utf8"));
    assert.ok(kinomap.records.length > 100, sample.tcx);
    roundTrip(buildWorkout(kinomap).fitBytes);
    if (!sample.fit) continue;
    const fit = decodeGarminFit(fs.readFileSync(path.join(sample.folder, sample.fit)));
    const estimate = estimateOffset(kinomap, fit);
    const messages = roundTrip(buildWorkout(kinomap, fit, { offsetSeconds: estimate.offsetSeconds }).fitBytes);
    assert.ok(messages.recordMesgs.every((record) => record.heartRate != null), sample.fit);
  }
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
  const parsed = fixtureKinomap(fixtures[0]);
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
  assert.throws(() => buildWorkout(fixtureKinomap(fixtures[0]), fixtureFit(fixtures[0]), { offsetSeconds: 3600 }), /společný časový úsek/);
});

test("splits laps by sport default or custom distance and writes them to FIT", () => {
  const startMs = Date.parse("2026-01-08T17:00:00Z");
  const records = Array.from({ length: 601 }, (_, second) => ({
    timeMs: startMs + second * 1000, distance: second * 4, heartRate: 130, cadence: 24, power: 150, speed: 4,
  }));
  const kinomap = { startMs, records, calories: 100, warnings: [], sport: "rowing", subSport: "indoorRowing" };

  const rowing = buildWorkout(kinomap);
  assert.equal(rowing.lapDistance, 500);
  assert.equal(rowing.laps.length, 5);
  assert.equal(rowing.laps[0].distance, 500);
  assert.equal(rowing.laps[0].cycles, 50);
  assert.equal(rowing.laps[0].avgStrokeDistance, 10);
  assert.equal(rowing.summary.cycles, 240);

  const decoder = new Decoder(Stream.fromArrayBuffer(Uint8Array.from(rowing.fitBytes).buffer));
  const { messages, errors } = decoder.read();
  assert.equal(errors.length, 0);
  assert.equal(messages.lapMesgs.length, 5);
  assert.equal(messages.sessionMesgs[0].numLaps, 5);
  assert.equal(messages.lapMesgs.at(-1).lapTrigger, "sessionEnd");

  assert.equal(buildWorkout(kinomap, null, { lapDistanceMeters: 1000 }).laps.length, 3);
  assert.equal(buildWorkout(kinomap, null, { lapDistanceMeters: 0 }).laps.length, 1);
  assert.equal(buildWorkout({ ...kinomap, sport: "running", subSport: "treadmill" }).laps.length, 3);
  assert.equal(buildWorkout({ ...kinomap, sport: "cycling", subSport: "indoorCycling" }).laps.length, 1);
});

test("ends laps exactly on the lap distance between samples", () => {
  const startMs = Date.parse("2026-01-08T17:00:00Z");
  const records = Array.from({ length: 601 }, (_, second) => ({
    timeMs: startMs + second * 1000, distance: second * 3.4, heartRate: 130, cadence: 22, power: 150, speed: 3.4,
  }));
  const workout = buildWorkout({ startMs, records, calories: 100, warnings: [], sport: "rowing", subSport: "indoorRowing" });
  for (const lap of workout.laps.slice(0, -1)) {
    assert.ok(Math.abs(lap.distance - 500) < 1e-9);
    assert.ok(Math.abs(lap.durationSeconds - 500 / 3.4) < 1e-6);
  }
  const total = workout.laps.reduce((sum, lap) => sum + lap.distance, 0);
  assert.ok(Math.abs(total - workout.summary.distance) < 1e-9);
});

test("normalizes per-leg running cadence to steps per minute", () => {
  const point = (second, cadence) => `<Trackpoint><Time>2026-10-29T08:00:0${second}Z</Time><DistanceMeters>${second * 3}</DistanceMeters><Cadence>${cadence}</Cadence></Trackpoint>`;
  const xml = (cadence) => `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>2026-10-29T08:00:00Z</Id><Lap><Track>${point(0, cadence)}${point(1, cadence)}${point(2, cadence)}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  assert.equal(parseKinomap(xml(85)).records[0].cadence, 170);
  assert.equal(parseKinomap(xml(171)).records[0].cadence, 171);
  const messages = roundTrip(buildWorkout(parseKinomap(xml(171))).fitBytes);
  assert.equal(messages.recordMesgs[0].cadence, 85);
  assert.equal(messages.recordMesgs[0].fractionalCadence, 0.5);
  assert.equal(parseKinomap(xml(85).replace("Running", "Biking")).records[0].cadence, 85);
});

test("moves Kinomap points stamped one second early into the following gap", () => {
  const point = (time, distance) => `<Trackpoint><Time>2026-06-01T19:38:${time}Z</Time><DistanceMeters>${distance}</DistanceMeters><Cadence>80</Cadence></Trackpoint>`;
  const xml = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Biking"><Id>2026-06-01T19:38:04Z</Id><Lap><Track>${point("04", 0)}${point("04", 5)}${point("06", 17)}${point("07", 23)}${point("07", 29)}${point("08", 35)}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const parsed = parseKinomap(xml);
  assert.deepEqual(parsed.records.map((record) => (record.timeMs - parsed.startMs) / 1000), [0, 1, 2, 3, 4]);
  assert.deepEqual(parsed.records.map((record) => record.distance), [0, 5, 17, 23, 35]);
});
