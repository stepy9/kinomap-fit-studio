import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBatchWorkout, planBatch } from "../src/batch.js";
import { buildWorkout, parseKinomap } from "../src/core.js";
import { fitFileName, titleFromKinomapFileName } from "../src/files.js";

const fixture = (sport, name) => path.resolve("test", "fixtures", sport, name);

// Mimics the File objects a folder picker returns, rooted at a virtual week folder.
function folderFile(relativePath, bytes) {
  return {
    name: path.basename(relativePath),
    webkitRelativePath: relativePath,
    lastModified: 0,
    text: async () => Buffer.from(bytes).toString("utf8"),
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

const fixtureFile = (sport, name, folder = sport) => folderFile(`week/${folder}/${name}`, fs.readFileSync(fixture(sport, name)));

test("strips emoji, Kinomap ids and full-width punctuation from titles", () => {
  assert.equal(titleFromKinomapFileName("⏱10 Min 24spm Stroke Rate Stripes--26409951.tcx"), "10 Min 24spm Stroke Rate Stripes");
  assert.equal(titleFromKinomapFileName("🌅🚣🗻Fuji San - Rowing Lake Motosu--19072939.pwx"), "Fuji San - Rowing Lake Motosu");
  assert.equal(titleFromKinomapFileName("Workout ｜ Build Fitness--1.tcx"), "Workout | Build Fitness");
  assert.equal(titleFromKinomapFileName("Rame Avec Pascal 2K19 - Départ--26388581.tcx"), "Rame Avec Pascal 2K19 - Départ");
});

test("builds safe FIT file names", () => {
  assert.equal(fitFileName("Kinomap - Work: out / 1. ", "Fallback"), "Kinomap - Work- out - 1.fit");
  assert.equal(fitFileName("   ", "Fallback"), "Fallback.fit");
});

test("plans every Kinomap recording in a folder as its own activity with its watch FIT", async () => {
  const items = await planBatch([
    fixtureFile("rowing", "activity.tcx"),
    fixtureFile("rowing", "activity.pwx"),
    fixtureFile("rowing", "watch.fit"),
    fixtureFile("cycling", "activity.tcx"),
    fixtureFile("running", "activity.tcx"),
    fixtureFile("running", "watch.fit"),
  ]);
  // Newest first; the PWX twin of a TCX is not a separate activity.
  assert.deepEqual(items.map((item) => item.sport), ["rowing", "cycling", "running"]);
  assert.deepEqual(items.map((item) => item.kinomapFile.name), ["activity.tcx", "activity.tcx", "activity.tcx"]);
  assert.deepEqual(items.map((item) => item.fitFile?.name ?? null), ["watch.fit", null, "watch.fit"]);
  assert.ok(items.every((item) => item.selected && !item.exported && !item.error));
});

test("marks activities with an earlier export as done and leaves them unselected", async () => {
  const exported = buildWorkout(parseKinomap(fs.readFileSync(fixture("rowing", "activity.tcx"), "utf8"))).fitBytes;
  const items = await planBatch([
    fixtureFile("rowing", "activity.tcx"),
    fixtureFile("rowing", "watch.fit"),
    folderFile("week/rowing/Kinomap - rowing.fit", exported),
    fixtureFile("cycling", "activity.tcx"),
  ]);
  const rowing = items.find((item) => item.sport === "rowing");
  assert.equal(rowing.fitFile.name, "watch.fit");
  assert.equal(rowing.exported, true);
  assert.equal(rowing.selected, false);
  assert.equal(items.find((item) => item.sport === "cycling").selected, true);
});

test("exports each planned activity with defaults or its own edited settings", async () => {
  const [running] = await planBatch([fixtureFile("running", "activity.tcx"), fixtureFile("running", "watch.fit")]);
  const defaults = buildBatchWorkout(running);
  assert.equal(defaults.mode, "merge");
  assert.equal(defaults.lapDistance, 1000);
  assert.equal(defaults.activityName, "Kinomap - activity");
  const edited = buildBatchWorkout(running, { mode: "convert", offsetSeconds: 0, lapDistanceMeters: 400, activityName: "Kinomap - Tempo" });
  assert.equal(edited.mode, "convert");
  assert.equal(edited.lapDistance, 400);
  assert.equal(edited.activityName, "Kinomap - Tempo");
});
