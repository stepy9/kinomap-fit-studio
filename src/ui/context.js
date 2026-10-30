import { translations } from "../i18n.js";

export const byId = (id) => document.getElementById(id);

export const elements = {
  kinomapInput: byId("kinomapInput"), fitInput: byId("fitInput"), folderInput: byId("folderInput"),
  kinomapName: byId("kinomapName"), fitName: byId("fitName"), kinomapDetail: byId("kinomapDetail"), fitDetail: byId("fitDetail"),
  offset: byId("offsetInput"), alignmentMode: byId("alignmentMode"), trimStart: byId("trimStart"), trimEnd: byId("trimEnd"),
  sourcesPanel: byId("sourcesPanel"),
  sources: { heartRate: byId("sourceHeartRate"), power: byId("sourcePower"), cadence: byId("sourceCadence") },
  timeZone: byId("timeZoneSelect"), asWatch: byId("asWatchToggle"), cadenceAsPower: byId("cadenceAsPowerToggle"), zoneBadge: byId("zoneBadge"), footerZone: byId("footerZone"),
  manualStartLabel: byId("manualStartLabel"),
  workoutFeel: byId("workoutFeel"), workoutRpe: byId("workoutRpe"),
  lapPreset: byId("lapPreset"), lapCustomField: byId("lapCustomField"), lapDistance: byId("lapDistance"), lapNote: byId("lapNote"),
  manualPanel: byId("manualDatePanel"), manualStart: byId("manualStart"), alignmentPanel: byId("alignmentPanel"),
  alignmentHint: byId("alignmentHint"), estimateNote: byId("estimateNote"), notice: byId("notice"), liveState: byId("liveState"),
  chart: byId("comparisonChart"), export: byId("exportButton"), startStamp: byId("startStamp"), activityName: byId("activityName"),
  lightThemeButton: byId("lightThemeButton"), darkThemeButton: byId("darkThemeButton"), languageControl: byId("languageControl"),
  languageButton: byId("languageButton"), languageCode: byId("languageCode"), languageMenu: byId("languageMenu"), languageFlag: byId("languageFlag"),
};

export const state = {
  kinomapFile: null,
  kinomapText: null,
  outputDirectoryHandle: null,
  kinomap: null,
  fitFile: null,
  fit: null,
  mode: "convert",
  language: "cs",
  result: null,
  estimate: null,
  error: null,
  // Activities found in a chosen folder, shown as preview tabs: { items, activeId, busy }.
  batch: null,
  // Zone picked by hand for the open activity; null follows the watch or the computer.
  zoneChoice: null,
  // Lap types chosen in the lap table, by lap number.
  lapIntensities: [],
  // Interval segments edited for the open activity; null lets the export estimate them.
  segments: null,
};

// Output time zone: reads timestamps without a zone, sets the FIT local time and every displayed clock.
export let zone = "Europe/Prague";

export function setZone(value) {
  zone = value;
}

const locale = () => (state.language === "en" ? "en-GB" : "cs-CZ");

// Wall-clock time of day in the output time zone, e.g. 19:43:51.
export function clockTime(epochMs) {
  return new Intl.DateTimeFormat(locale(), { timeZone: zone, timeStyle: "medium" }).format(new Date(epochMs));
}

// "13. 3. 2026 · 19:43:51 – 20:04:12", with the end date only when it falls on another day.
export function timeRange(startMs, endMs) {
  const date = (ms) => new Intl.DateTimeFormat(locale(), { timeZone: zone, dateStyle: "medium" }).format(new Date(ms));
  const end = date(endMs) === date(startMs) ? clockTime(endMs) : `${date(endMs)} ${clockTime(endMs)}`;
  return `${date(startMs)} · ${clockTime(startMs)} – ${end}`;
}

export const t = (key, values = {}) => Object.entries(values).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, value),
  translations[state.language][key] ?? key,
);

export const sportLabel = (sport) => t(sport === "cycling" ? "cyclingIndoor" : sport === "running" ? "runningTreadmill" : "rowingIndoor");

const knownMessages = {
  "Čas v TCX nemá pásmo; vyložen v pásmu výstupu.": "timezoneTcx",
  "Čas v PWX nemá pásmo; vyložen v pásmu výstupu.": "timezonePwx",
  "Datum vypadá neplatně; zadejte místní začátek tréninku.": "invalidActivityDate",
  "TCX neobsahuje watty.": "noPower",
  "Po zarovnání a ořezu nezůstal společný časový úsek.": "estimateNoOverlap",
  "Ve společném úseku nejsou dostatečné záznamy.": "estimateTooFew",
  "Po ořezu nezůstal časový úsek.": "trimNoTime",
  "Po ořezu nezůstaly dostatečné záznamy.": "trimTooFew",
  "Soubor neobsahuje TCX aktivitu.": "tcxActivityMissing",
  "TCX neobsahuje žádné trackpointy.": "tcxPointsMissing",
  "Vybraný soubor není FIT.": "fitFileInvalid",
  "FIT soubor neprošel kontrolou integrity.": "fitIntegrity",
};

export function translateMessage(message) {
  if (knownMessages[message]) return t(knownMessages[message], { zone });
  if (message.startsWith("FIT nelze načíst: ")) return t("fitRead", { message: message.slice("FIT nelze načíst: ".length) });
  if (message.startsWith("TCX: ")) return t("needRecords", { label: "TCX" });
  if (message.startsWith("PWX: ")) return t("needRecords", { label: "PWX" });
  if (message.startsWith("FIT: ")) return t("needRecords", { label: "FIT" });
  return message;
}

export function applyStaticTranslations() {
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-aria]")) element.setAttribute("aria-label", t(element.dataset.i18nAria));
  for (const element of document.querySelectorAll("[data-i18n-title]")) element.title = t(element.dataset.i18nTitle);
}

export function setNotice(text = "", type = "") {
  elements.notice.textContent = translateMessage(text);
  elements.notice.hidden = !text;
  elements.notice.className = `notice${type ? ` is-${type}` : ""}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function displayNumber(value, digits = 0) {
  const locale = state.language === "en" ? "en-GB" : "cs-CZ";
  return Number.isFinite(value) ? new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value) : "—";
}
