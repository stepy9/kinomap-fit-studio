import "./styles.css";
import { buildWorkout, decodeGarminFit, defaultLapDistance, defaultMetricSources, estimateOffset, lapDistancePresets, parseKinomap } from "./core.js";
import { buildBatchWorkout, planBatch } from "./batch.js";
import { checkWorkout } from "./checks.js";
import { collectDirectoryFiles, fitFileName, titleFromKinomapFileName } from "./files.js";
import { renderBatchTabs } from "./ui/batch.js";
import { drawChart, setupChartTrim } from "./ui/chart.js";
import {
  applyStaticTranslations, byId, displayNumber, elements, formatDuration, setNotice, sportLabel, state, t, timeRange, translateMessage, setZone, zone,
} from "./ui/context.js";
import { exportFit, saveFit } from "./ui/export.js";
import { savedLanguage, savedTheme, setLanguageMenu, setTheme } from "./ui/preferences.js";
import { allZones, defaultZoneFor, offsetLabel, systemZone, zoneOffsetMinutes } from "./zones.js";

function lapLabel(meters) {
  if (Math.abs(meters - 1609.344) < 1) return "1 mi";
  return meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
}

function renderLapOptions(sport, selected = elements.lapPreset.value) {
  const fallback = defaultLapDistance(sport);
  const presets = lapDistancePresets[sport] ?? lapDistancePresets.rowing;
  const options = [
    ...presets.map((meters) => [String(meters), meters === fallback ? t("lapDefault", { label: lapLabel(meters) }) : lapLabel(meters)]),
    ["0", t("lapNone")],
    ["custom", t("lapCustomOption")],
  ];
  elements.lapPreset.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  elements.lapPreset.value = options.some(([value]) => value === selected) ? selected : String(fallback);
  elements.lapCustomField.hidden = elements.lapPreset.value !== "custom";
}

function lapDistanceValue() {
  return elements.lapPreset.value === "custom" ? elements.lapDistance.value : elements.lapPreset.value;
}

function setLanguage(language, persist = true) {
  const previousFallback = `Kinomap - ${t("fallbackActivity")}`;
  state.language = language === "en" ? "en" : "cs";
  document.documentElement.lang = state.language;
  elements.languageCode.textContent = state.language.toUpperCase();
  elements.languageFlag.src = state.language === "en" ? "./flags/gb.svg" : "./flags/cz.svg";
  for (const option of elements.languageMenu.querySelectorAll("[data-language]")) {
    option.setAttribute("aria-selected", String(option.dataset.language === state.language));
  }
  applyStaticTranslations();
  renderLapOptions(state.kinomap?.sport);
  if (!state.kinomapFile && (!elements.activityName.value || elements.activityName.value === previousFallback || elements.activityName.value === "Kinomap - Rowing Workout")) {
    elements.activityName.value = `Kinomap - ${t("fallbackActivity")}`;
  }
  if (state.estimate) updateEstimateNote();
  renderZone();
  if (persist) {
    try {
      localStorage.setItem("kinomap-fit-language", state.language);
    } catch {}
  }
  renderBatch();
  render();
}

function metricSources() {
  return Object.fromEntries(Object.entries(elements.sources).map(([field, select]) => [field, select.value]));
}

function setMetricSources(sources = defaultMetricSources) {
  for (const [field, select] of Object.entries(elements.sources)) select.value = sources[field] ?? defaultMetricSources[field];
}

// Each folder activity keeps its own editor settings while the user switches between preview tabs.
function currentSettings() {
  return {
    mode: state.mode,
    alignmentMode: elements.alignmentMode.value,
    offsetSeconds: Number(elements.offset.value) || 0,
    trimStartSeconds: elements.trimStart.value,
    trimEndSeconds: elements.trimEnd.value,
    lapPreset: elements.lapPreset.value,
    customLapDistance: elements.lapDistance.value,
    lapDistanceMeters: lapDistanceValue(),
    sources: metricSources(),
    zoneChoice: state.zoneChoice,
    activityName: elements.activityName.value,
    manualStart: elements.manualStart.value || undefined,
  };
}

function applySettings(settings) {
  state.mode = settings.mode;
  elements.alignmentMode.value = settings.alignmentMode;
  elements.offset.value = String(settings.offsetSeconds);
  elements.trimStart.value = settings.trimStartSeconds;
  elements.trimEnd.value = settings.trimEndSeconds;
  renderLapOptions(state.kinomap?.sport, settings.lapPreset);
  elements.lapDistance.value = settings.customLapDistance;
  elements.activityName.value = settings.activityName;
  setMetricSources(settings.sources);
  state.zoneChoice = settings.zoneChoice ?? null;
  if (settings.manualStart) {
    elements.manualStart.value = settings.manualStart;
    parseCurrentKinomap(true);
  }
}

const zoneOption = (value) => `${value.replaceAll("_", " ")} (${offsetLabel(zoneOffsetMinutes(value))})`;

function renderZone() {
  const select = elements.timeZone;
  if (!select.options.length) {
    for (const value of new Set([systemZone(), ...allZones()])) select.add(new Option(zoneOption(value), value));
  }
  select.options[0].textContent = `${zoneOption(systemZone())} · ${t("systemZone")}`;
  select.value = zone;
  // The offset in force right now, e.g. UTC+2 in Prague summer time.
  elements.zoneBadge.textContent = offsetLabel(zoneOffsetMinutes(zone));
  // The footer always shows the computer's own zone, whatever the export uses.
  elements.footerZone.textContent = systemZone();
  elements.manualStartLabel.textContent = t("manualStart", { zone });
}

// The export zone follows the watch recording unless one was picked for this activity.
function syncZone() {
  const next = state.zoneChoice ?? defaultZoneFor(state.fit);
  if (next !== zone) {
    setZone(next);
    // Times without a zone are read again in the new one.
    parseCurrentKinomap();
  }
  const active = activeBatchItem();
  if (active) active.timeZone = zone;
  renderZone();
}

function changeZone(value) {
  state.zoneChoice = value === defaultZoneFor(state.fit) ? null : value;
  render();
  renderBatch();
}

function activeBatchItem() {
  return state.batch?.items.find((item) => item.id === state.batch.activeId) ?? null;
}

function renderBatch() {
  renderBatchTabs({
    onSelect: selectBatchItem,
    onToggle: (item, selected) => {
      item.selected = selected;
      renderBatch();
    },
  });
}

async function selectBatchItem(item) {
  const active = activeBatchItem();
  if (active === item) return;
  if (active && state.kinomap) active.settings = currentSettings();
  state.batch.activeId = item.id;
  state.zoneChoice = null;
  state.fit = null;
  state.fitFile = null;
  state.estimate = null;
  state.mode = "convert";
  elements.offset.value = "0";
  elements.estimateNote.textContent = t("estimatePending");
  renderBatch();
  await loadKinomap(item.kinomapFile, item.directoryHandle, { keepBatch: true });
  if (item.fitFile) await loadFit(item.fitFile);
  if (item.settings) {
    applySettings(item.settings);
    render();
  }
}

async function exportBatch() {
  const batch = state.batch;
  const active = activeBatchItem();
  if (active && state.kinomap) active.settings = currentSettings();
  const selected = batch.items.filter((item) => item.selected);
  const counts = { saved: 0, downloaded: 0, failed: 0 };
  batch.busy = true;
  for (const item of selected) {
    item.status = "saving";
    renderBatch();
    try {
      const workout = buildBatchWorkout(item, item.settings);
      const { saved } = await saveFit(workout.fitBytes, fitFileName(workout.activityName, t("fallbackActivity")), item.directoryHandle);
      counts[saved ? "saved" : "downloaded"] += 1;
      Object.assign(item, { status: null, failure: null, exported: true, selected: false });
    } catch (error) {
      counts.failed += 1;
      Object.assign(item, { status: "failed", failure: translateMessage(error.message) });
    }
  }
  batch.busy = false;
  renderBatch();
  setNotice(t("batchDone", counts), counts.failed ? "error" : "success");
}

function dateInputValue(epochMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function resetSummary() {
  for (const id of ["summaryDuration", "summaryDistance", "summaryCalories", "summaryHeartRate", "summaryPower", "summaryCadence", "summarySpeed"]) {
    byId(id).textContent = "—";
  }
  elements.startStamp.textContent = "—";
  byId("summaryElevation").hidden = true;
}

function updateFileRows() {
  elements.kinomapName.textContent = state.kinomapFile?.name ?? t("dropKinomap");
  elements.kinomapName.classList.toggle("has-file", Boolean(state.kinomapFile));
  elements.fitName.textContent = state.fitFile?.name ?? t("dropFit");
  elements.fitName.classList.toggle("has-file", Boolean(state.fitFile));
  elements.kinomapDetail.textContent = state.kinomap
    ? `${state.kinomap.records.length.toLocaleString(state.language === "en" ? "en-GB" : "cs-CZ")} ${t("records")} · ${sportLabel(state.kinomap.sport)} · ${state.kinomap.calories == null ? t("noPowerEstimate") : `${state.kinomap.calories} kcal`}`
    : "";
  elements.fitDetail.textContent = state.fit
    ? [`${state.fit.records.length.toLocaleString(state.language === "en" ? "en-GB" : "cs-CZ")} ${t("records")}`, state.fit.sessions[0]?.sportProfileName]
      .filter(Boolean).join(" · ")
    : "";
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

async function loadKinomap(file, sourceDirectoryHandle = null, { keepBatch = false } = {}) {
  if (!file) return;
  if (!keepBatch && state.batch) {
    // Leaving the folder also drops the watch FIT paired with its open activity.
    Object.assign(state, { batch: null, fit: null, fitFile: null, estimate: null, mode: "convert", zoneChoice: null });
    renderBatch();
  }
  if (!keepBatch) state.zoneChoice = null;
  state.error = null;
  state.outputDirectoryHandle = sourceDirectoryHandle;
  try {
    state.kinomapFile = file;
    elements.activityName.value = `Kinomap - ${titleFromKinomapFileName(file.name) || t("fallbackActivity")}`;
    state.kinomapText = await file.text();
    elements.manualStart.value = "";
    parseCurrentKinomap();
    renderLapOptions(state.kinomap.sport, "");
    elements.lapDistance.value = defaultLapDistance(state.kinomap.sport);
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
  elements.sourcesPanel.hidden = state.mode !== "merge";
}

function renderSummary(summary, startMs, endMs, sport) {
  byId("summaryDuration").textContent = formatDuration(summary.timerSeconds);
  byId("summaryDistance").textContent = `${displayNumber(summary.distance / 1000, 2)} km`;
  byId("summaryCalories").textContent = `${displayNumber(summary.calories)} kcal`;
  const elevation = byId("summaryElevation");
  elevation.hidden = summary.ascent == null;
  elevation.textContent = t("elevation", { ascent: displayNumber(summary.ascent), descent: displayNumber(summary.descent) });
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
  elements.startStamp.textContent = timeRange(startMs, endMs);
}

// Step 1 shows only the inputs; once a recording is open the workspace replaces it until "Change files".
function showView(view) {
  const setup = view === "setup";
  byId("setupView").hidden = !setup;
  byId("workspaceView").hidden = setup;
  byId(setup ? "setupNoticeSlot" : "workspaceNoticeSlot").append(elements.notice);
  window.scrollTo({ top: 0 });
  drawChart();
}

function updateContext() {
  byId("continueButton").disabled = !state.kinomap;
  const files = [state.kinomapFile?.name, state.fitFile?.name].filter(Boolean).join(" + ");
  byId("contextSummary").textContent = state.batch
    ? `${t("contextFolder", { count: state.batch.items.length })} · ${files}`
    : files;
}

function renderChecks() {
  // The offset estimate only speaks for the alignment while the offset still holds its value.
  const estimate = state.estimate && Number(elements.offset.value) === state.estimate.offsetSeconds ? state.estimate : null;
  const trimmed = Number(elements.trimStart.value) > 0 || Number(elements.trimEnd.value) > 0;
  const issues = checkWorkout(state.result, { kinomap: state.kinomap, estimate, trimmed });
  const list = byId("checksList");
  list.replaceChildren(...issues.map((issue) => {
    const item = document.createElement("li");
    item.className = `check is-${issue.severity}`;
    item.textContent = t(issue.code, issue.values);
    return item;
  }));
  list.hidden = !issues.length;
  const active = activeBatchItem();
  if (active && JSON.stringify(active.issues) !== JSON.stringify(issues)) {
    active.issues = issues;
    renderBatch();
  }
}

function render() {
  syncZone();
  updateModeButtons();
  updateFileRows();
  updateContext();
  state.result = null;
  elements.export.disabled = true;
  elements.liveState.classList.remove("is-ready");
  elements.liveState.lastChild.textContent = t("waiting");
  resetSummary();
  byId("checksList").hidden = true;

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
          lapDistanceMeters: lapDistanceValue(),
          sources: metricSources(),
          activityName: elements.activityName.value,
        },
      );
      elements.lapNote.textContent = state.result.lapDistance > 0 ? t("lapCount", { count: state.result.laps.length }) : "";
      renderSummary(state.result.summary, state.result.startMs, state.result.endMs, state.result.sport);
      renderChecks();
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

async function loadFolder(files) {
  const items = await planBatch(files, { timeZone: systemZone(), fallbackTitle: t("fallbackActivity") });
  const first = items.find((item) => !item.error);
  if (!first) {
    setNotice(t("noFolderKinomap"), "error");
    return;
  }
  // A single activity opens straight in the editor; several become preview tabs, opening the newest one.
  state.batch = items.length > 1 ? { items, activeId: null, busy: false } : null;
  if (state.batch) {
    await selectBatchItem(first);
  } else {
    state.fit = null;
    state.fitFile = null;
    await loadKinomap(first.kinomapFile, first.directoryHandle);
    if (first.fitFile) await loadFit(first.fitFile);
  }
  if (state.kinomap) showView("workspace");
}

async function chooseFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    elements.folderInput.click();
    return;
  }
  try {
    const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await loadFolder(await collectDirectoryFiles(directoryHandle));
  } catch (error) {
    if (error.name !== "AbortError") setNotice(error.message, "error");
  }
}

byId("kinomapButton").addEventListener("click", () => elements.kinomapInput.click());
byId("continueButton").addEventListener("click", () => showView("workspace"));
byId("changeFilesButton").addEventListener("click", () => showView("setup"));
byId("fitButton").addEventListener("click", () => elements.fitInput.click());
byId("folderButton").addEventListener("click", chooseFolder);
elements.kinomapInput.addEventListener("change", (event) => loadKinomap(event.target.files[0]));
elements.fitInput.addEventListener("change", async (event) => {
  await loadFit(event.target.files[0]);
  // A watch FIT picked by hand replaces the paired one of the open folder activity.
  const active = activeBatchItem();
  if (active && state.fit) Object.assign(active, { fitFile: state.fitFile, fit: state.fit });
  renderBatch();
});
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
elements.lapDistance.addEventListener("input", render);
elements.lapPreset.addEventListener("change", () => {
  elements.lapCustomField.hidden = elements.lapPreset.value !== "custom";
  render();
});
elements.activityName.addEventListener("input", render);
elements.timeZone.addEventListener("change", () => changeZone(elements.timeZone.value));
for (const select of Object.values(elements.sources)) select.addEventListener("change", render);
byId("autoOffsetButton").addEventListener("click", offsetEstimate);
elements.export.addEventListener("click", exportFit);
byId("batchExportButton").addEventListener("click", exportBatch);
elements.lightThemeButton.addEventListener("click", () => setTheme("light"));
elements.darkThemeButton.addEventListener("click", () => setTheme("dark"));
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

setupChartTrim(render);
const observer = new ResizeObserver(drawChart);
observer.observe(elements.chart);
setTheme(savedTheme(), false);
setZone(systemZone());
setLanguage(savedLanguage(), false);
render();

// Installable and offline in the built app; the dev server stays uncached.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}