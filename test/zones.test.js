import assert from "node:assert/strict";
import test from "node:test";
import { defaultZoneFor, offsetLabel, zoneForOffset, zoneOffsetMinutes } from "../src/zones.js";

const winter = Date.UTC(2026, 0, 15, 12);
const summer = Date.UTC(2026, 6, 15, 12);

test("reads the offset in force at a moment, daylight saving included", () => {
  assert.equal(zoneOffsetMinutes("Europe/Prague", winter), 60);
  assert.equal(zoneOffsetMinutes("Europe/Prague", summer), 120);
  assert.equal(zoneOffsetMinutes("Asia/Yangon", winter), 390);
  assert.equal(zoneOffsetMinutes("UTC", winter), 0);
});

test("labels offsets as ±HH:mm", () => {
  assert.equal(offsetLabel(120), "+02:00");
  assert.equal(offsetLabel(390), "+06:30");
  assert.equal(offsetLabel(-300), "-05:00");
  assert.equal(offsetLabel(0), "+00:00");
});

test("keeps the preferred zone when it matches the watch offset, otherwise picks a matching one", () => {
  assert.equal(zoneForOffset(120, summer, "Europe/Prague"), "Europe/Prague");
  const elsewhere = zoneForOffset(-300, winter, "Europe/Prague");
  assert.equal(zoneOffsetMinutes(elsewhere, winter), -300);
  // Prefers a zone from the same region as the computer.
  assert.match(zoneForOffset(0, winter, "Europe/Prague"), /^Europe\//);
});

test("falls back to the preferred zone without a watch offset", () => {
  assert.equal(defaultZoneFor(null, "Europe/Prague"), "Europe/Prague");
  assert.equal(defaultZoneFor({ utcOffsetMinutes: null, startMs: winter }, "Europe/Prague"), "Europe/Prague");
  assert.equal(defaultZoneFor({ utcOffsetMinutes: 60, startMs: winter }, "Europe/Prague"), "Europe/Prague");
});
