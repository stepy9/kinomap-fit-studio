// Time zone helpers: the export zone defaults to the one the watch recorded, otherwise to the computer's.

export function systemZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Prague";
}

export function allZones() {
  return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
}

// Minutes east of UTC in force at the given moment, e.g. 120 in Prague summer time.
export function zoneOffsetMinutes(timeZone, atMs = Date.now()) {
  const name = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(atMs)).find((part) => part.type === "timeZoneName").value;
  const match = name.match(/([+-])(\d{2}):(\d{2})/);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

// "+02:00", "+06:30" or "-05:00".
export function offsetLabel(minutes) {
  const absolute = Math.abs(minutes);
  const pad = (value) => String(value).padStart(2, "0");
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

const matchCache = new Map();

// A zone matching the watch offset at the workout: the preferred zone when it fits, then one from its region.
export function zoneForOffset(offsetMinutes, atMs, preferred = systemZone()) {
  if (zoneOffsetMinutes(preferred, atMs) === offsetMinutes) return preferred;
  const key = `${offsetMinutes}|${atMs}|${preferred}`;
  if (!matchCache.has(key)) {
    const matches = allZones().filter((zone) => zoneOffsetMinutes(zone, atMs) === offsetMinutes);
    const region = `${preferred.split("/")[0]}/`;
    matchCache.set(key, matches.find((zone) => zone.startsWith(region)) ?? matches[0] ?? preferred);
  }
  return matchCache.get(key);
}

export function defaultZoneFor(fit, preferred = systemZone()) {
  return fit?.utcOffsetMinutes == null ? preferred : zoneForOffset(fit.utcOffsetMinutes, fit.startMs, preferred);
}
