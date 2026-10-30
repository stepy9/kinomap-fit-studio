import { Decoder, Encoder, Profile, Stream, Utils } from "@garmin/fitsdk";

// Gaps longer than this are recording pauses: metrics are not interpolated across them and the FIT timer stops.
export const pauseGapSeconds = 10;

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
  // The watch stores its local time as raw seconds since the FIT epoch; the difference is its UTC offset.
  const activity = messages.activityMesgs?.[0];
  const utcOffsetMinutes = typeof activity?.localTimestamp === "number" && activity.timestamp instanceof Date
    ? Math.round(((activity.localTimestamp + 631065600) * 1000 - activity.timestamp.getTime()) / 900_000) * 15
    : null;
  return {
    utcOffsetMinutes,
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
    totalTimerTime: summary.timerSeconds ?? elapsedSeconds,
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
    totalAscent: summary.ascent ?? undefined,
    totalDescent: summary.descent ?? undefined,
    avgSpeed: summary.avgSpeed ?? undefined,
    maxSpeed: summary.maxSpeed ?? undefined,
    enhancedAvgSpeed: summary.avgSpeed ?? undefined,
    enhancedMaxSpeed: summary.maxSpeed ?? undefined,
    sport,
    subSport,
  };
}

// A FIT target as a range around the value: cadence ±1 rpm, power ±5 W.
// Power goes in plain watts: Garmin Connect plots the value as is and ignores the spec's 1000 W offset.
function stepTarget(step) {
  if (!(step.target > 0) || !["cadence", "power"].includes(step.targetType)) return { targetType: "open" };
  const value = Math.round(step.target);
  const spread = step.targetType === "cadence" ? 1 : 5;
  return { targetType: step.targetType, targetValue: 0, customTargetValueLow: value - spread, customTargetValueHigh: value + spread };
}

// By default exports present themselves as a Garmin watch (fenix 7 Pro Solar), so Connect works out Training Effect and training load.
// The serial number marks the file as one of ours; older exports used the "development" manufacturer instead.
export const exportSerialNumber = 4_200_000_001;
const exportDevice = { manufacturer: "garmin", product: 4375, serialNumber: exportSerialNumber };
const developmentDevice = { manufacturer: "development", product: 0, serialNumber: exportSerialNumber };
export const isExportedFit = (fileId) => fileId?.manufacturer === "development" || fileId?.serialNumber === exportSerialNumber;

// steps, when given, describe the workout behind interval laps: each step's duration, intensity and target.
export function encodeFit(records, summary, laps, startMs, endMs, timeZone = "Europe/Prague", activityName = "Kinomap - Rowing Workout", sport = "rowing", subSport = "indoorRowing", steps = null, asWatch = true) {
  const device = asWatch ? exportDevice : developmentDevice;
  const encoder = new Encoder();
  const startTime = fitTime(startMs);
  const endTime = fitTime(endMs);
  const elapsedSeconds = Math.max(0, (endMs - startMs) / 1000);
  const summaryFields = summaryFieldsFor(summary, startMs, endMs, sport, subSport);

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    ...device,
    timeCreated: startTime,
  });
  encoder.writeMesg({ mesgNum: Profile.MesgNum.FILE_CREATOR, softwareVersion: 2100 });
  encoder.writeMesg({ mesgNum: Profile.MesgNum.DEVICE_INFO, timestamp: startTime, deviceIndex: "creator", ...device, softwareVersion: 21 });
  // Points at the workout followed, which also lets Connect take the activity name from it.
  encoder.writeMesg({ mesgNum: Profile.MesgNum.TRAINING_FILE, timestamp: startTime, type: "workout", ...device, timeCreated: startTime });
  if (steps?.length) {
    encoder.writeMesg({ mesgNum: Profile.MesgNum.WORKOUT, wktName: activityName, sport, subSport, numValidSteps: steps.length });
    steps.forEach((step, index) => encoder.writeMesg({
      mesgNum: Profile.MesgNum.WORKOUT_STEP,
      messageIndex: index,
      durationType: "time",
      durationValue: Math.round(step.durationSeconds * 1000),
      // Garmin Connect lists an "active" step as Other; its own workouts call the work steps "interval".
      intensity: step.intensity === "active" ? "interval" : step.intensity,
      ...stepTarget(step),
    }));
  }
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.EVENT,
    timestamp: startTime,
    event: "timer",
    eventType: "start",
  });

  records.forEach((record, index) => {
    const previous = records[index - 1];
    // Mirror a watch pause: stop the timer at the last sample before the gap and restart it at the next one.
    if (previous && record.timeMs - previous.timeMs > pauseGapSeconds * 1000) {
      encoder.writeMesg({ mesgNum: Profile.MesgNum.EVENT, timestamp: fitTime(previous.timeMs), event: "timer", eventType: "stopAll" });
      encoder.writeMesg({ mesgNum: Profile.MesgNum.EVENT, timestamp: fitTime(record.timeMs), event: "timer", eventType: "start" });
    }
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
  });

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
      intensity: lap.intensity ?? "active",
      lapTrigger: index === laps.length - 1 ? "sessionEnd" : lap.trigger ?? "distance",
      wktStepIndex: lap.stepIndex,
    });
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.SESSION,
    messageIndex: 0,
    ...summaryFields,
    sportProfileName: activityName,
    // FIT stores perceived effort ten times over, so 1–10 becomes 10–100.
    workoutFeel: summary.workoutFeel ?? undefined,
    workoutRpe: summary.workoutRpe == null ? undefined : summary.workoutRpe * 10,
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
    totalTimerTime: summary.timerSeconds ?? elapsedSeconds,
  });
  return encoder.close();
}