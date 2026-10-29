import { Decoder, Encoder, Profile, Stream, Utils } from "@garmin/fitsdk";

const fitTime = (epochMs) => Utils.convertDateToDateTime(new Date(epochMs));

function zoneOffsetMs(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return localAsUtc - Math.floor(epochMs / 1000) * 1000;
}

export function decodeGarminFit(input) {
  const bytes = input instanceof Uint8Array ? Uint8Array.from(input) : new Uint8Array(input);
  const decoder = new Decoder(Stream.fromArrayBuffer(bytes.buffer));
  if (!decoder.isFIT()) throw new Error("Vybraný soubor není FIT.");
  if (!decoder.checkIntegrity()) throw new Error("FIT soubor neprošel kontrolou integrity.");
  const { messages, errors } = decoder.read({ convertDateTimesToDates: true });
  if (errors.length) throw new Error(`FIT nelze načíst: ${errors.map((error) => error.message ?? error).join("; ")}`);
  const records = (messages.recordMesgs ?? []).map((record) => ({
    timeMs: record.timestamp instanceof Date ? record.timestamp.getTime() : NaN,
    distance: Number.isFinite(record.distance) ? record.distance : null,
    heartRate: Number.isFinite(record.heartRate) ? record.heartRate : null,
    cadence: Number.isFinite(record.cadence) ? record.cadence : null,
    power: Number.isFinite(record.power) ? record.power : null,
  })).filter((record) => Number.isFinite(record.timeMs)).sort((a, b) => a.timeMs - b.timeMs);
  if (records.length < 2) throw new Error("FIT: potřebuji alespoň dva časové záznamy.");
  return {
    records,
    startMs: records[0].timeMs,
    endMs: records.at(-1).timeMs,
    sessions: messages.sessionMesgs ?? [],
    fileId: messages.fileIdMesgs?.[0] ?? null,
  };
}

// FIT stores running cadence per leg (strides/min) with a half-step fraction; workout records keep steps/min.
function fitCadence(value, sport) {
  if (value == null) return { cadence: undefined, fractional: undefined };
  if (sport !== "running") return { cadence: Math.round(value), fractional: undefined };
  const strides = Math.round(value) / 2;
  return { cadence: Math.floor(strides), fractional: strides % 1 };
}

function summaryFieldsFor(summary, startMs, endMs, sport, subSport) {
  const elapsedSeconds = Math.max(0, (endMs - startMs) / 1000);
  const avgCadence = fitCadence(summary.avgCadence, sport);
  const maxCadence = fitCadence(summary.maxCadence, sport);
  return {
    timestamp: fitTime(endMs),
    startTime: fitTime(startMs),
    totalElapsedTime: elapsedSeconds,
    totalTimerTime: elapsedSeconds,
    totalDistance: summary.distance,
    totalCalories: summary.calories,
    avgHeartRate: summary.avgHeartRate ?? undefined,
    maxHeartRate: summary.maxHeartRate ?? undefined,
    avgPower: summary.avgPower ?? undefined,
    maxPower: summary.maxPower ?? undefined,
    avgCadence: avgCadence.cadence,
    maxCadence: maxCadence.cadence,
    avgFractionalCadence: avgCadence.fractional,
    maxFractionalCadence: maxCadence.fractional,
    totalCycles: summary.cycles ?? undefined,
    avgStrokeDistance: summary.avgStrokeDistance ?? undefined,
    avgSpeed: summary.avgSpeed ?? undefined,
    maxSpeed: summary.maxSpeed ?? undefined,
    enhancedAvgSpeed: summary.avgSpeed ?? undefined,
    enhancedMaxSpeed: summary.maxSpeed ?? undefined,
    sport,
    subSport,
  };
}

export function encodeFit(records, summary, laps, startMs, endMs, timeZone = "Europe/Prague", activityName = "Kinomap - Rowing Workout", sport = "rowing", subSport = "indoorRowing") {
  const encoder = new Encoder();
  const startTime = fitTime(startMs);
  const endTime = fitTime(endMs);
  const elapsedSeconds = Math.max(0, (endMs - startMs) / 1000);
  const summaryFields = summaryFieldsFor(summary, startMs, endMs, sport, subSport);

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: startTime,
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.EVENT,
    timestamp: startTime,
    event: "timer",
    eventType: "start",
  });

  for (const record of records) {
    const message = {
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: fitTime(record.timeMs),
      distance: record.distance,
    };
    if (record.heartRate != null) message.heartRate = Math.round(record.heartRate);
    if (record.cadence != null) {
      const { cadence, fractional } = fitCadence(record.cadence, sport);
      message.cadence = cadence;
      if (fractional != null) message.fractionalCadence = fractional;
    }
    if (record.power != null) message.power = Math.round(record.power);
    if (record.speed != null) {
      message.speed = record.speed;
      message.enhancedSpeed = record.speed;
    }
    encoder.writeMesg(message);
  }

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.EVENT,
    timestamp: endTime,
    event: "timer",
    eventType: "stop",
  });
  laps.forEach((lap, index) => {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.LAP,
      messageIndex: index,
      ...summaryFieldsFor(lap, lap.startMs, lap.endMs, sport, subSport),
      event: "lap",
      eventType: "stop",
      intensity: "active",
      lapTrigger: index === laps.length - 1 ? "sessionEnd" : "distance",
    });
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.SESSION,
    messageIndex: 0,
    ...summaryFields,
    sportProfileName: activityName,
    firstLapIndex: 0,
    numLaps: laps.length,
    event: "session",
    eventType: "stop",
    trigger: "activityEnd",
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.ACTIVITY,
    timestamp: endTime,
    numSessions: 1,
    localTimestamp: fitTime(endMs + zoneOffsetMs(endMs, timeZone)),
    totalTimerTime: elapsedSeconds,
  });
  return encoder.close();
}