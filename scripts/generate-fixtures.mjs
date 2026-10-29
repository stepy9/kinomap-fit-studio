// Generates deterministic synthetic Kinomap TCX/PWX and Garmin watch FIT fixtures for every supported sport.
// Run with `npm run fixtures`; the output in test/fixtures is committed so tests do not depend on private samples.
import fs from "node:fs";
import path from "node:path";
import { Encoder, Profile, Utils } from "@garmin/fitsdk";

const root = path.resolve("test", "fixtures");
const durationSeconds = 600;
// The watch heart rate lags Kinomap by this many seconds; test/core.test.js expects the same offset.
const watchOffsetSeconds = 7;

const sports = [
  {
    folder: "rowing", tcxSport: "rowing", pwxSport: "Rowing", fitSport: "rowing", fitSubSport: "indoorRowing",
    startIso: "2026-10-28T07:11:27Z", speed: 3.4, speedSwing: 0.5, cadence: 24, cadenceSwing: 6, power: 140, powerSwing: 70,
  },
  {
    folder: "cycling", tcxSport: "Biking", pwxSport: "Cycling", fitSport: "cycling", fitSubSport: "indoorCycling",
    startIso: "2026-10-27T17:30:00Z", speed: 9.5, speedSwing: 1.5, cadence: 88, cadenceSwing: 10, power: 190, powerSwing: 80,
  },
  {
    folder: "running", tcxSport: "Running", pwxSport: "Running", fitSport: "running", fitSubSport: "treadmill",
    startIso: "2026-10-26T06:00:00Z", speed: 3.3, speedSwing: 0.5, cadence: 168, cadenceSwing: 8, power: 230, powerSwing: 40,
  },
];

function random(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

function samplesFor(sport, seed) {
  const next = random(seed);
  const samples = [];
  let distance = 0;
  let heartRate = 95;
  for (let second = 0; second <= durationSeconds; second += 1) {
    // Alternate 90 s hard and 60 s easy blocks after a 60 s warm-up.
    const block = second < 60 ? 0 : (second - 60) % 150 < 90 ? 1 : -1;
    const warmup = Math.min(1, second / 60);
    const speed = Math.max(0, (sport.speed + block * sport.speedSwing + (next() - .5) * .2) * warmup);
    const cadence = second === 0 ? null : Math.round(sport.cadence + block * sport.cadenceSwing + (next() - .5) * 2);
    const power = second === 0 ? null : Math.round(Math.max(0, (sport.power + block * sport.powerSwing + (next() - .5) * 20) * warmup));
    heartRate += ((block === 1 ? 168 : block === -1 ? 140 : 120) - heartRate) * .04 + (next() - .5) * 1.5;
    if (second > 0) distance += speed;
    samples.push({ second, speed, cadence, power, heartRate: second === 0 ? null : Math.round(heartRate), distance: Math.floor(distance) });
  }
  return samples;
}

function writeTcx(sport, samples, file) {
  const startMs = Date.parse(sport.startIso);
  const iso = (second) => new Date(startMs + second * 1000).toISOString().replace(".000Z", "Z");
  // Kinomap running exports carry the virtual route's position and altitude; the tool must not pass them to FIT.
  const position = (sample) => (sport.fitSport !== "running" ? "" : `<Position><LatitudeDegrees>${(41.021 + sample.distance * 1e-5).toFixed(8)}</LatitudeDegrees><LongitudeDegrees>${(-112.2312 + sample.distance * 5e-6).toFixed(8)}</LongitudeDegrees></Position><AltitudeMeters>${(1329.3 + Math.sin(sample.distance / 300) * 12).toFixed(1)}</AltitudeMeters>`);
  const points = samples.map((sample) => [
    `<Trackpoint><Time>${iso(sample.second)}</Time>${position(sample)}<DistanceMeters>${sample.distance}</DistanceMeters>`,
    sample.heartRate == null ? "" : `<HeartRateBpm><Value>${sample.heartRate}</Value></HeartRateBpm>`,
    sample.cadence == null ? "" : `<Cadence>${sample.cadence}</Cadence>`,
    `<Extensions><ns3:TPX><ns3:Speed>${sample.speed.toFixed(1)}</ns3:Speed>`,
    sample.power == null ? "" : `<ns3:Watts>${sample.power}</ns3:Watts>`,
    "</ns3:TPX></Extensions></Trackpoint>",
  ].join("")).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Activities><Activity Sport="${sport.tcxSport}"><Id>${iso(0)}</Id><Lap StartTime="${iso(0)}"><TotalTimeSeconds>${durationSeconds}</TotalTimeSeconds><DistanceMeters>${samples.at(-1).distance}</DistanceMeters><Calories>${Math.round(sport.power * durationSeconds * .0012)}</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>${points}</Track></Lap><Creator><Name>KinomapVirtual</Name></Creator></Activity></Activities></TrainingCenterDatabase>
`;
  fs.writeFileSync(file, xml);
}

function writePwx(sport, samples, file) {
  const rows = samples.map((sample) => [
    `<sample><timeoffset>${sample.second}</timeoffset>`,
    sample.heartRate == null ? "" : `<hr>${sample.heartRate}</hr>`,
    `<spd>${(sample.speed * 3.6).toFixed(1)}</spd>`,
    sample.power == null ? "" : `<pwr>${sample.power}</pwr>`,
    sample.cadence == null ? "" : `<cad>${sample.cadence}</cad>`,
    `<dist>${sample.distance}</dist></sample>`,
  ].join("")).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pwx xmlns="http://www.peaksware.com/PWX/1/0" version="1.0" creator="KinomapApiPWX"><workout><sportType>${sport.pwxSport}</sportType><title>Kinomap - </title><time>${sport.startIso}</time><summarydata><beginning>0</beginning><duration>${durationSeconds}</duration></summarydata></workout>${rows}</pwx>
`;
  fs.writeFileSync(file, xml);
}

function writeWatchFit(sport, samples, file) {
  const startMs = Date.parse(sport.startIso);
  const fitTime = (epochMs) => Utils.convertDateToDateTime(new Date(epochMs));
  // The watch starts 15 s before Kinomap, stops 10 s after it, and records heart rate only.
  const firstSecond = -15;
  const lastSecond = durationSeconds + 10;
  const heartRateAt = (second) => {
    const source = samples[Math.min(samples.length - 1, Math.max(1, second - watchOffsetSeconds))];
    return source.heartRate;
  };
  const encoder = new Encoder();
  const start = fitTime(startMs + firstSecond * 1000);
  const end = fitTime(startMs + lastSecond * 1000);
  const elapsed = lastSecond - firstSecond;
  encoder.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: "activity", manufacturer: "garmin", product: 4440, serialNumber: 1234567890, timeCreated: start });
  encoder.writeMesg({ mesgNum: Profile.MesgNum.EVENT, timestamp: start, event: "timer", eventType: "start" });
  let watchDistance = 0;
  for (let second = firstSecond; second <= lastSecond; second += 1) {
    const record = { mesgNum: Profile.MesgNum.RECORD, timestamp: fitTime(startMs + second * 1000), heartRate: heartRateAt(second) };
    // On a treadmill the watch also logs wrist-based cadence per leg plus a half-step fraction, speed and distance.
    if (sport.fitSport === "running") {
      const source = samples[Math.min(samples.length - 1, Math.max(1, second))];
      const strides = source.cadence / 2;
      watchDistance += second > 0 && second <= durationSeconds ? source.speed * .97 : 0;
      Object.assign(record, { cadence: Math.floor(strides), fractionalCadence: strides % 1, speed: source.speed * .97, enhancedSpeed: source.speed * .97, distance: watchDistance });
    }
    encoder.writeMesg(record);
  }
  encoder.writeMesg({ mesgNum: Profile.MesgNum.EVENT, timestamp: end, event: "timer", eventType: "stop" });
  const summary = { timestamp: end, startTime: start, totalElapsedTime: elapsed, totalTimerTime: elapsed, sport: sport.fitSport, subSport: sport.fitSubSport };
  encoder.writeMesg({ mesgNum: Profile.MesgNum.LAP, messageIndex: 0, ...summary, event: "lap", eventType: "stop", lapTrigger: "sessionEnd" });
  encoder.writeMesg({ mesgNum: Profile.MesgNum.SESSION, messageIndex: 0, ...summary, firstLapIndex: 0, numLaps: 1, event: "session", eventType: "stop", trigger: "activityEnd" });
  encoder.writeMesg({ mesgNum: Profile.MesgNum.ACTIVITY, timestamp: end, numSessions: 1, totalTimerTime: elapsed });
  fs.writeFileSync(file, encoder.close());
}

sports.forEach((sport, index) => {
  const folder = path.join(root, sport.folder);
  fs.mkdirSync(folder, { recursive: true });
  const samples = samplesFor(sport, 1000 + index);
  writeTcx(sport, samples, path.join(folder, "activity.tcx"));
  writePwx(sport, samples, path.join(folder, "activity.pwx"));
  writeWatchFit(sport, samples, path.join(folder, "watch.fit"));
  console.log(`${sport.folder}: ${samples.length} samples, ${samples.at(-1).distance} m`);
});
