import "./styles.css";
import { buildWorkout, decodeGarminFit, estimateOffset, parseKinomap } from "./core.js";
import { translations } from "./i18n.js";

const byId = (id) => document.getElementById(id);
const elements = {
  kinomapInput: byId("kinomapInput"), fitInput: byId("fitInput"), folderInput: byId("folderInput"),
  kinomapName: byId("kinomapName"), fitName: byId("fitName"), kinomapDetail: byId("kinomapDetail"), fitDetail: byId("fitDetail"),
  offset: byId("offsetInput"), alignmentMode: byId("alignmentMode"), trimStart: byId("trimStart"), trimEnd: byId("trimEnd"),
  manualPanel: byId("manualDatePanel"), manualStart: byId("manualStart"), alignmentPanel: byId("alignmentPanel"),
  alignmentHint: byId("alignmentHint"), estimateNote: byId("estimateNote"), notice: byId("notice"), liveState: byId("liveState"),
  chart: byId("comparisonChart"), export: byId("exportButton"), startStamp: byId("startStamp"), activityName: byId("activityName"),
  lightThemeButton: byId("lightThemeButton"), darkThemeButton: byId("darkThemeButton"), languageControl: byId("languageControl"),
  languageButton: byId("languageButton"), languageCode: byId("languageCode"), languageMenu: byId("languageMenu"), languageFlag: byId("languageFlag"),
};

const state = {
  kinomapFile: null,
  kinomapText: null,
  kinomap: null,
  fitFile: null,
  fit: null,
  mode: "convert",
  language: "cs",
  result: null,
  estimate: null,
  error: null,
};

const zone = "Europe/Prague";
const t = (key, values = {}) => Object.entries(values).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, value),
  translations[state.language][key] ?? key,
);

const sportLabel = (sport) => t(sport === "cycling" ? "cyclingIndoor" : sport === "running" ? "runningTreadmill" : "rowingIndoor");

const knownMessages = {
  "Čas v TCX nemá pásmo; vyložen jako Europe/Prague.": "timezoneTcx",
  "Čas v PWX nemá pásmo; vyložen jako Europe/Prague.": "timezonePwx",
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

function translateMessage(message) {
  if (knownMessages[message]) return t(knownMessages[message]);
  if (message.startsWith("FIT nelze načíst: ")) return t("fitRead", { message: message.slice("FIT nelze načíst: ".length) });
  if (message.startsWith("TCX: ")) return t("needRecords", { label: "TCX" });
  if (message.startsWith("PWX: ")) return t("needRecords", { label: "PWX" });
  if (message.startsWith("FIT: ")) return t("needRecords", { label: "FIT" });
  return message;
}

function applyStaticTranslations() {
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-aria]")) element.setAttribute("aria-label", t(element.dataset.i18nAria));
}

function setLanguage(language, persist = true) {
  const previousFallback = `Kinomap - ${t("fallbackActivity")}`;
  state.language = language === "en" ? "en" : "cs";
  document.documentElement.lang = state.language;
  elements.languageCode.textContent = state.language.toUpperCase();
  elements.languageFlag.src = state.language === "en" ? "/flags/gb.svg" : "/flags/cz.svg";
  for (const option of elements.languageMenu.querySelectorAll("[data-language]")) {
    option.setAttribute("aria-selected", String(option.dataset.language === state.language));
  }
  applyStaticTranslations();
  if (!state.kinomapFile && (!elements.activityName.value || elements.activityName.value === previousFallback || elements.activityName.value === "Kinomap - Rowing Workout")) {
    elements.activityName.value = `Kinomap - ${t("fallbackActivity")}`;
  }
  if (state.estimate) updateEstimateNote();
  if (persist) {
    try {
      localStorage.setItem("kinomap-fit-language", state.language);
    } catch {}
  }
  render();
}

function savedLanguage() {
  try {
    return localStorage.getItem("kinomap-fit-language") === "en" ? "en" : "cs";
  } catch {
    return "cs";
  }
}

function dateInputValue(epochMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function nameFromKinomapFile(file) {
  const title = file.name.replace(/\.(tcx|pwx)$/i, "").replace(/--\d+$/, "").trim();
  return `Kinomap - ${title || t("fallbackActivity")}`;
}

function setNotice(text = "", type = "") {
  elements.notice.textContent = translateMessage(text);
  elements.notice.hidden = !text;
  elements.notice.className = `notice${type ? ` is-${type}` : ""}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function displayNumber(value, digits = 0) {
  const locale = state.language === "en" ? "en-GB" : "cs-CZ";
  return Number.isFinite(value) ? new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value) : "—";
}

function setTheme(theme, persist = true) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  elements.lightThemeButton.setAttribute("aria-pressed", String(!isDark));
  elements.darkThemeButton.setAttribute("aria-pressed", String(isDark));
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#111a16" : "#f2f4ee";
  if (persist) {
    try {
      localStorage.setItem("kinomap-fit-theme", isDark ? "dark" : "light");
    } catch {}
  }
  drawChart();
}

function savedTheme() {
  try {
    return localStorage.getItem("kinomap-fit-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function resetSummary() {
  for (const id of ["summaryDuration", "summaryDistance", "summaryCalories", "summaryHeartRate", "summaryPower", "summaryCadence", "summarySpeed"]) {
    byId(id).textContent = "—";
  }
  elements.startStamp.textContent = "—";
}

function updateFileRows() {
  elements.kinomapName.textContent = state.kinomapFile?.name ?? t("dropKinomap");
  elements.kinomapName.classList.toggle("has-file", Boolean(state.kinomapFile));
  elements.fitName.textContent = state.fitFile?.name ?? t("dropFit");
  elements.fitName.classList.toggle("has-file", Boolean(state.fitFile));
  elements.kinomapDetail.textContent = state.kinomap
    ? `${state.kinomap.records.length.toLocaleString(state.language === "en" ? "en-GB" : "cs-CZ")} ${t("records")} · ${sportLabel(state.kinomap.sport)} · ${state.kinomap.calories == null ? t("noPowerEstimate") : `${state.kinomap.calories} kcal`}`
    : t("sourceDetail");
  elements.fitDetail.textContent = state.fit
    ? `${state.fit.records.length.toLocaleString(state.language === "en" ? "en-GB" : "cs-CZ")} ${t("records")} · ${state.fit.sessions[0]?.sportProfileName ?? t("watchDetail")}`
    : t("watchDetail");
}

function updateEstimateNote() {
  if (!state.estimate) return;
  const method = state.estimate.method === "heart-rate" ? t("estimateHr")
    : state.estimate.method === "heart-rate-power" ? t("estimatePower") : t("estimateStarts");
  const confidence = state.estimate.confidence === "low"
    ? t("confidenceLow") : `r ${displayNumber(state.estimate.correlation, 2)}`;
  elements.estimateNote.textContent = `${method} · ${state.estimate.offsetSeconds > 0 ? "+" : ""}${state.estimate.offsetSeconds} s · ${confidence}`;
}

function offsetEstimate() {
  if (!state.kinomap || !state.fit) return;
  try {
    state.estimate = estimateOffset(state.kinomap, state.fit, { alignmentMode: elements.alignmentMode.value });
    elements.offset.value = String(state.estimate.offsetSeconds);
    updateEstimateNote();
    render();
  } catch (error) {
    elements.estimateNote.textContent = translateMessage(error.message);
  }
}

function parseCurrentKinomap(manual = false) {
  if (!state.kinomapText) return;
  const fileDate = state.kinomapFile?.lastModified || Date.now();
  const initial = parseKinomap(state.kinomapText, { fallbackStartMs: fileDate, timeZone: zone });
  if (initial.needsManualStart) {
    elements.manualPanel.hidden = false;
    if (!elements.manualStart.value) elements.manualStart.value = dateInputValue(fileDate);
    state.kinomap = parseKinomap(state.kinomapText, {
      fallbackStartMs: fileDate,
      manualStart: manual || elements.manualStart.value ? elements.manualStart.value : undefined,
      timeZone: zone,
    });
  } else {
    elements.manualPanel.hidden = true;
    elements.manualStart.value = "";
    state.kinomap = initial;
  }
}

async function loadKinomap(file) {
  if (!file) return;
  state.error = null;
  try {
    state.kinomapFile = file;
    elements.activityName.value = nameFromKinomapFile(file);
    state.kinomapText = await file.text();
    elements.manualStart.value = "";
    parseCurrentKinomap();
    updateFileRows();
    if (state.fit) offsetEstimate();
    else render();
  } catch (error) {
    state.kinomap = null;
    state.error = { key: "fileReadKinomap", message: error.message };
    render();
  }
}

async function loadFit(file) {
  if (!file) return;
  state.error = null;
  try {
    state.fitFile = file;
    state.fit = decodeGarminFit(await file.arrayBuffer());
    state.mode = "merge";
    updateFileRows();
    updateModeButtons();
    if (state.kinomap) offsetEstimate();
    else render();
  } catch (error) {
    state.fit = null;
    state.error = { key: "fileReadFit", message: error.message };
    render();
  }
}

function updateModeButtons() {
  for (const button of document.querySelectorAll(".mode-button")) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  elements.alignmentPanel.hidden = state.mode !== "merge";
}

function renderSummary(summary, startMs, sport) {
  byId("summaryDuration").textContent = formatDuration(summary.durationSeconds);
  byId("summaryDistance").textContent = `${displayNumber(summary.distance / 1000, 2)} km`;
  byId("summaryCalories").textContent = `${displayNumber(summary.calories)} kcal`;
  byId("summaryHeartRate").textContent = summary.avgHeartRate == null
    ? "—" : `${displayNumber(summary.avgHeartRate)} / ${displayNumber(summary.maxHeartRate)} bpm`;
  byId("summaryPower").textContent = summary.avgPower == null
    ? "—" : `${displayNumber(summary.avgPower)} / ${displayNumber(summary.maxPower)} W`;
  byId("summaryCadenceLabel").textContent = t("cadence");
  byId("summaryCadence").textContent = summary.avgCadence == null
    ? "—" : `${displayNumber(summary.avgCadence)} / ${displayNumber(summary.maxCadence)} ${sport === "cycling" ? "rpm" : "spm"}`;
  const speedLabel = byId("summarySpeedLabel");
  const speedValue = byId("summarySpeed");
  if (summary.avgSpeed == null || summary.avgSpeed <= 0) {
    speedLabel.textContent = t("genericSpeed");
    speedValue.textContent = "—";
  } else if (sport === "cycling") {
    speedLabel.textContent = t("averageSpeed");
    speedValue.textContent = `${displayNumber(summary.avgSpeed * 3.6, 1)} km/h`;
  } else {
    const secondsPerUnit = 1000 / summary.avgSpeed / (sport === "rowing" ? 2 : 1);
    speedLabel.textContent = t("averagePace");
    speedValue.textContent = `${formatDuration(secondsPerUnit)} ${sport === "rowing" ? "/500 m" : "min/km"}`;
  }
  const dateLocale = state.language === "en" ? "en-GB" : "cs-CZ";
  elements.startStamp.textContent = new Intl.DateTimeFormat(dateLocale, {
    timeZone: zone, dateStyle: "medium", timeStyle: "medium",
  }).format(new Date(startMs));
}

function render() {
  updateModeButtons();
  updateFileRows();
  state.result = null;
  elements.export.disabled = true;
  elements.liveState.classList.remove("is-ready");
  elements.liveState.lastChild.textContent = t("waiting");
  resetSummary();

  if (state.error) {
    setNotice(t(state.error.key, { message: translateMessage(state.error.message) }), "error");
  } else if (!state.kinomap) {
    setNotice(t("waitingForKinomap"));
  } else if (state.mode === "merge" && !state.fit) {
    setNotice(t("missingFit"));
  } else if (state.kinomap.needsManualStart && !elements.manualStart.value) {
    setNotice(t("confirmStart"), "error");
  } else {
    try {
      state.result = buildWorkout(
        state.kinomap,
        state.mode === "merge" ? state.fit : null,
        {
          timeZone: zone,
          alignmentMode: elements.alignmentMode.value,
          offsetSeconds: elements.offset.value,
          trimStartSeconds: elements.trimStart.value,
          trimEndSeconds: elements.trimEnd.value,
          activityName: elements.activityName.value,
        },
      );
      renderSummary(state.result.summary, state.result.startMs, state.result.sport);
      elements.export.disabled = false;
      elements.liveState.classList.add("is-ready");
      elements.liveState.lastChild.textContent = t("ready");
      const warnings = state.result.warnings.map(translateMessage);
      if (state.kinomap.needsManualStart) warnings.push(t("manualTimeNote"));
      setNotice(warnings.join(" "), warnings.length ? "" : "success");
    } catch (error) {
      setNotice(error.message, "error");
    }
  }
  drawChart();
}

function chartSources() {
  const kinomap = state.kinomap;
  const fit = state.mode === "merge" ? state.fit : null;
  if (!kinomap) return { kinomap: [], fit: [], startMs: 0, endMs: 1 };
  const offsetMs = (Number(elements.offset.value) || 0) * 1000;
  const isElapsed = elements.alignmentMode.value === "elapsed";
  const shift = fit && isElapsed ? fit.startMs - kinomap.startMs : 0;
  const source = kinomap.records.map((record) => ({
    ...record, chartTime: record.timeMs + shift + offsetMs,
  }));
  const watch = fit?.records.map((record) => ({ ...record, chartTime: record.timeMs })) ?? [];
  const startMs = state.result?.startMs ?? Math.min(source[0]?.chartTime ?? 0, watch[0]?.chartTime ?? Infinity);
  const endMs = state.result?.endMs ?? Math.max(source.at(-1)?.chartTime ?? 1, watch.at(-1)?.chartTime ?? 0);
  return { kinomap: source, fit: watch, startMs, endMs: Math.max(startMs + 1, endMs) };
}

function drawChart() {
  const canvas = elements.chart;
  if (!canvas || canvas.clientWidth === 0) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);

  const sources = chartSources();
  const running = state.kinomap?.sport === "running";
  const cadenceMax = state.kinomap?.sport === "cycling" ? 140 : running ? 220 : 60;
  const lanes = [
    { key: "heartRate", title: t("heartRateLane"), unit: "bpm", min: 40, max: 200 },
    running
      ? { key: "speed", title: t("speedLane"), unit: "km/h", min: 0, max: 18, scale: 3.6 }
      : { key: "power", title: t("powerLane"), unit: "W", min: 0, max: 400 },
    { key: "cadence", title: t("cadenceLane"), unit: state.kinomap?.sport === "cycling" ? "rpm" : "spm", min: 0, max: cadenceMax },
  ];
  const left = 43;
  const right = 10;
  const top = 7;
  const bottom = 5;
  const laneGap = 9;
  const laneHeight = (height - top - bottom - laneGap * 2) / 3;
  const plotWidth = width - left - right;
  const span = Math.max(1, sources.endMs - sources.startMs);
  const colorKinomap = "#e87943";
  const colorFit = "#36a77d";
  const theme = getComputedStyle(document.documentElement);
  const gridColor = theme.getPropertyValue("--chart-grid").trim();
  const labelColor = theme.getPropertyValue("--chart-label").trim();
  const subtleColor = theme.getPropertyValue("--chart-subtle").trim();

  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
    const lane = lanes[laneIndex];
    const laneTop = top + laneIndex * (laneHeight + laneGap);
    const laneBottom = laneTop + laneHeight;
    const scaleValue = (record) => record[lane.key] * (lane.scale ?? 1);
    const sourceValues = [
      ...sources.kinomap.map((record) => record[lane.key]),
      ...sources.fit.map((record) => record[lane.key]),
    ].filter(Number.isFinite).map((value) => value * (lane.scale ?? 1));
    const maximum = (lane.key === "power" || lane.key === "speed") && sourceValues.length
      ? Math.max(lane.max, Math.max(...sourceValues) * 1.08)
      : lane.max;

    context.strokeStyle = gridColor;
    context.lineWidth = 1;
    for (let grid = 0; grid < 3; grid += 1) {
      const y = laneTop + grid * laneHeight / 2;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(width - right, y);
      context.stroke();
    }
    context.fillStyle = labelColor;
    context.font = "9px Cascadia Code, Consolas, monospace";
    context.fillText(lane.title, 1, laneTop + 11);
    context.fillStyle = subtleColor;
    context.font = "8px Cascadia Code, Consolas, monospace";
    context.fillText(lane.unit, 2, laneTop + 23);

    const drawSeries = (records, color) => {
      context.strokeStyle = color;
      context.lineWidth = 1.7;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.beginPath();
      let active = false;
      let previousTime = null;
      for (const record of records) {
        const rawValue = record[lane.key];
        if (!Number.isFinite(rawValue) || record.chartTime < sources.startMs || record.chartTime > sources.endMs) {
          active = false;
          continue;
        }
        const value = rawValue * (lane.scale ?? 1);
        const x = left + ((record.chartTime - sources.startMs) / span) * plotWidth;
        const y = laneBottom - Math.min(1, Math.max(0, (value - lane.min) / (maximum - lane.min))) * laneHeight;
        if (!active || (previousTime != null && record.chartTime - previousTime > 10_000)) context.moveTo(x, y);
        else context.lineTo(x, y);
        active = true;
        previousTime = record.chartTime;
      }
      context.stroke();
    };
    drawSeries(sources.fit, colorFit);
    drawSeries(sources.kinomap, colorKinomap);
  }
}

function folderCandidates(files) {
  const all = [...files];
  const kinomapFiles = all.filter((file) => /\.(tcx|pwx)$/i.test(file.name));
  const fitFiles = all.filter((file) => /\.fit$/i.test(file.name));
  const dateFor = (file) => file.webkitRelativePath?.match(/20\d{2}-\d{2}-\d{2}/)?.[0]
    ?? file.name.match(/20\d{2}-\d{2}-\d{2}/)?.[0]
    ?? new Date(file.lastModified).toISOString().slice(0, 10);
  const pairs = new Map();
  for (const file of kinomapFiles) pairs.set(dateFor(file), { ...(pairs.get(dateFor(file)) ?? {}), kinomap: file });
  for (const file of fitFiles) pairs.set(dateFor(file), { ...(pairs.get(dateFor(file)) ?? {}), fit: file });
  const complete = [...pairs.entries()].filter(([, pair]) => pair.kinomap && pair.fit).sort(([a], [b]) => b.localeCompare(a));
  if (complete.length) return complete[0][1];
  return {
    kinomap: kinomapFiles.sort((a, b) => b.lastModified - a.lastModified)[0],
    fit: fitFiles.sort((a, b) => b.lastModified - a.lastModified)[0],
  };
}

async function loadFolder(files) {
  const chosen = folderCandidates(files);
  if (!chosen.kinomap) {
    setNotice(t("noFolderKinomap"), "error");
    return;
  }
  await loadKinomap(chosen.kinomap);
  if (chosen.fit) await loadFit(chosen.fit);
  if (chosen.fit && chosen.kinomap) {
    state.mode = "merge";
    updateModeButtons();
    offsetEstimate();
  }
}

function exportFit() {
  if (!state.result) return;
  const safeName = (state.kinomapFile?.name ?? "rowing-activity")
    .replace(/\.(tcx|pwx)$/i, "")
    .replace(/[<>:"/\\|?*]+/g, "-");
  const url = URL.createObjectURL(new Blob([state.result.fitBytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName}.fit`;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

byId("kinomapButton").addEventListener("click", () => elements.kinomapInput.click());
byId("fitButton").addEventListener("click", () => elements.fitInput.click());
byId("folderButton").addEventListener("click", () => elements.folderInput.click());
elements.kinomapInput.addEventListener("change", (event) => loadKinomap(event.target.files[0]));
elements.fitInput.addEventListener("change", (event) => loadFit(event.target.files[0]));
elements.folderInput.addEventListener("change", (event) => loadFolder(event.target.files));
elements.manualStart.addEventListener("input", () => {
  parseCurrentKinomap(true);
  updateFileRows();
  render();
});
elements.offset.addEventListener("input", render);
elements.alignmentMode.addEventListener("change", () => {
  elements.alignmentHint.textContent = elements.alignmentMode.value === "absolute" ? t("timeUTC") : t("elapsedAlignment");
  render();
});
elements.trimStart.addEventListener("input", render);
elements.trimEnd.addEventListener("input", render);
elements.activityName.addEventListener("input", render);
byId("autoOffsetButton").addEventListener("click", offsetEstimate);
elements.export.addEventListener("click", exportFit);
elements.lightThemeButton.addEventListener("click", () => setTheme("light"));
elements.darkThemeButton.addEventListener("click", () => setTheme("dark"));
function setLanguageMenu(open) {
  elements.languageMenu.hidden = !open;
  elements.languageButton.setAttribute("aria-expanded", String(open));
}

elements.languageButton.addEventListener("click", () => setLanguageMenu(elements.languageMenu.hidden));
elements.languageButton.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setLanguageMenu(true);
    elements.languageMenu.querySelector(`[data-language="${state.language}"]`).focus();
  }
});
for (const option of elements.languageMenu.querySelectorAll("[data-language]")) {
  option.addEventListener("click", () => {
    setLanguage(option.dataset.language);
    setLanguageMenu(false);
    elements.languageButton.focus();
  });
  option.addEventListener("keydown", (event) => {
    const options = [...elements.languageMenu.querySelectorAll("[data-language]")];
    const index = options.indexOf(option);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setLanguageMenu(false);
      elements.languageButton.focus();
    }
  });
}
document.addEventListener("pointerdown", (event) => {
  if (!elements.languageControl.contains(event.target)) setLanguageMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.languageMenu.hidden) {
    setLanguageMenu(false);
    elements.languageButton.focus();
  }
});

for (const [tileId, input, accepts] of [
  ["kinomapDrop", elements.kinomapInput, /\.(tcx|pwx)$/i],
  ["fitDrop", elements.fitInput, /\.fit$/i],
]) {
  const tile = byId(tileId);
  tile.addEventListener("dragover", (event) => { event.preventDefault(); tile.classList.add("is-dragging"); });
  tile.addEventListener("dragleave", () => tile.classList.remove("is-dragging"));
  tile.addEventListener("drop", (event) => {
    event.preventDefault();
    tile.classList.remove("is-dragging");
    const file = [...event.dataTransfer.files].find((item) => accepts.test(item.name));
    if (input === elements.kinomapInput) loadKinomap(file);
    else loadFit(file);
  });
}

for (const button of document.querySelectorAll(".mode-button")) {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    render();
  });
}

const observer = new ResizeObserver(drawChart);
observer.observe(elements.chart);
setTheme(savedTheme(), false);
setLanguage(savedLanguage(), false);
render();