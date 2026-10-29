import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildWorkout, parseKinomap } from "../src/core.js";
import { folderCandidates, titleFromKinomapFileName, withoutExportedFits } from "../src/files.js";

const file = (name, webkitRelativePath = name, lastModified = 0, bytes = new Uint8Array()) => ({
  name, webkitRelativePath, lastModified, arrayBuffer: async () => bytes.buffer,
});

test("strips emoji, Kinomap ids and full-width punctuation from titles", () => {
  assert.equal(titleFromKinomapFileName("⏱10 Min 24spm Stroke Rate Stripes--26409951.tcx"), "10 Min 24spm Stroke Rate Stripes");
  assert.equal(titleFromKinomapFileName("🌅🚣🗻Fuji San - Rowing Lake Motosu--19072939.pwx"), "Fuji San - Rowing Lake Motosu");
  assert.equal(titleFromKinomapFileName("Workout ｜ Build Fitness--1.tcx"), "Workout | Build Fitness");
  assert.equal(titleFromKinomapFileName("Rame Avec Pascal 2K19 - Départ--26388581.tcx"), "Rame Avec Pascal 2K19 - Départ");
});

test("picks the newest date that has both a Kinomap file and a watch FIT", () => {
  const chosen = folderCandidates([
    file("a.tcx", "samples/2026-10-27/a.tcx"),
    file("a.fit", "samples/2026-10-27/a.fit"),
    file("b.tcx", "samples/2026-10-28/b.tcx"),
    file("c.tcx", "samples/2026-10-29/c.tcx"),
    file("c.fit", "samples/2026-10-29/c.fit"),
  ]);
  assert.equal(chosen.kinomap.name, "c.tcx");
  assert.equal(chosen.fit.name, "c.fit");
});

test("skips FIT files previously exported by the tool", async () => {
  const watch = fs.readFileSync(path.resolve("test", "fixtures", "rowing", "watch.fit"));
  const exported = buildWorkout(parseKinomap(fs.readFileSync(path.resolve("test", "fixtures", "rowing", "activity.tcx"), "utf8"))).fitBytes;
  const files = await withoutExportedFits([
    file("activity.tcx"),
    file("Kinomap - export.fit", undefined, 0, Uint8Array.from(exported)),
    file("watch.fit", undefined, 0, Uint8Array.from(watch)),
  ]);
  assert.deepEqual(files.map((item) => item.name), ["activity.tcx", "watch.fit"]);
});
