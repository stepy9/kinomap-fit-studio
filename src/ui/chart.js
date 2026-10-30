import { byId, clockTime, elements, formatDuration, state, t } from "./context.js";

// The chart spans the whole untrimmed section; the trim is shaded and adjusted by dragging its two handles.
const handleHitPx = 10;
const minimumWindowMs = 10_000;
let layout = null;
// Series hidden from the legend; both recordings are shown by default.
const hiddenSeries = new Set();
// Moment under the mouse pointer, shown as a guide line with both recordings' values.
let hoverMs = null;
// The trim handles appear only while trimming; a trim already set stays shaded either way.
let trimMode = false;

export function setTrimMode(on) {
  trimMode = on;
  drawChart();
}

export const isTrimMode = () => trimMode;

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
  // Watch FIT stores running cadence per leg; the chart shows steps/min like the export.
  const cadenceScale = kinomap.sport === "running" ? 2 : 1;
  const watch = fit?.records.map((record) => ({
    ...record, chartTime: record.timeMs, cadence: record.cadence == null ? null : record.cadence * cadenceScale,
  })) ?? [];
  // Without trim the export covers the overlap of both recordings, or the whole Kinomap one when converting.
  let startMs = source[0]?.chartTime ?? 0;
  let endMs = source.at(-1)?.chartTime ?? 1;
  if (watch.length && Math.min(endMs, watch.at(-1).chartTime) > Math.max(startMs, watch[0].chartTime)) {
    startMs = Math.max(startMs, watch[0].chartTime);
    endMs = Math.min(endMs, watch.at(-1).chartTime);
  }
  return { kinomap: source, fit: watch, startMs, endMs: Math.max(startMs + 1, endMs) };
}

function trimWindow(startMs, endMs) {
  const trimStartMs = Math.max(0, Number(elements.trimStart.value) || 0) * 1000;
  const trimEndMs = Math.max(0, Number(elements.trimEnd.value) || 0) * 1000;
  return {
    windowStart: Math.min(endMs, startMs + trimStartMs),
    windowEnd: Math.max(startMs, endMs - trimEndMs),
    trimStartMs,
    trimEndMs,
  };
}

function drawTrim(context, { left, top, plotWidth, plotBottom, startMs, span }, trim, colors) {
  const xFor = (ms) => left + ((ms - startMs) / span) * plotWidth;
  const startX = xFor(trim.windowStart);
  const endX = xFor(trim.windowEnd);
  context.fillStyle = colors.shade;
  if (startX > left) context.fillRect(left, top, startX - left, plotBottom - top);
  if (endX < left + plotWidth) context.fillRect(endX, top, left + plotWidth - endX, plotBottom - top);
  if (!trimMode) return;
  for (const [x, trimmedMs, align] of [[startX, trim.trimStartMs, "left"], [endX, trim.trimEndMs, "right"]]) {
    context.strokeStyle = colors.handle;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, top);
    context.lineTo(x, plotBottom);
    context.stroke();
    // Grip in the middle of the handle.
    context.fillStyle = colors.handle;
    context.beginPath();
    context.roundRect(x - 5, (top + plotBottom) / 2 - 16, 10, 32, 4);
    context.fill();
    context.strokeStyle = colors.grip;
    context.lineWidth = 1;
    for (const offset of [-2, 2]) {
      context.beginPath();
      context.moveTo(x + offset, (top + plotBottom) / 2 - 8);
      context.lineTo(x + offset, (top + plotBottom) / 2 + 8);
      context.stroke();
    }
    if (trimmedMs > 0) {
      // Show where the export now starts or ends and how much was cut, keeping the label inside the plot.
      const boundaryMs = align === "left" ? trim.windowStart : trim.windowEnd;
      const label = `${clockTime(boundaryMs)} · −${formatDuration(trimmedMs / 1000)}`;
      context.font = "600 11px Inter, Segoe UI, system-ui, sans-serif";
      const labelWidth = context.measureText(label).width;
      const toRight = align === "left" ? x + 8 + labelWidth <= left + plotWidth : x - 8 - labelWidth < left;
      context.textAlign = toRight ? "left" : "right";
      context.fillStyle = colors.handle;
      context.fillText(label, x + (toRight ? 8 : -8), top + 12);
      context.textAlign = "left";
    }
  }
}

export function drawChart() {
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
  const sport = state.kinomap?.sport;
  const cadenceMax = sport === "cycling" ? 140 : sport === "running" ? 220 : 60;
  // Pace lanes are drawn in seconds per 500 m or per km with faster pace at the top, as Garmin does.
  const paceLane = (meters, unit, fastest, slowest) => ({
    key: "speed", title: t("paceLane"), unit, min: fastest, max: slowest, invert: true,
    value: (speed) => (speed > 0 ? meters / speed : null), format: formatDuration,
  });
  const whole = (value) => String(Math.round(value));
  const lanes = [
    { key: "heartRate", title: t("heartRateLane"), unit: "bpm", min: 40, max: 200, format: whole },
    sport === "cycling"
      ? { key: "speed", title: t("speedLane"), unit: "km/h", min: 0, max: 50, scale: 3.6, grow: true, format: (value) => value.toFixed(1) }
      : sport === "running" ? paceLane(1000, "min/km", 180, 480) : paceLane(500, "min/500 m", 90, 210),
    // Treadmill runs show power only when a recording carries it.
    sport === "running" && ![...sources.kinomap, ...sources.fit].some((record) => record.power != null)
      ? null
      : { key: "power", title: t("powerLane"), unit: "W", min: 0, max: 400, grow: true, format: whole },
    { key: "cadence", title: t("cadenceLane"), unit: sport === "running" ? "spm" : "rpm", min: 0, max: cadenceMax, format: whole },
  ].filter(Boolean);
  for (const lane of lanes) lane.laneValue = (raw) => (lane.value ? lane.value(raw) : raw * (lane.scale ?? 1));
  const left = 56;
  const right = 10;
  const top = 7;
  const bottom = 5;
  const laneGap = 9;
  const laneHeight = (height - top - bottom - laneGap * (lanes.length - 1)) / lanes.length;
  const plotWidth = width - left - right;
  const span = Math.max(1, sources.endMs - sources.startMs);
  const theme = getComputedStyle(document.documentElement);
  const color = (name) => theme.getPropertyValue(name).trim();
  const colorKinomap = color("--series-source");
  const colorFit = color("--series-watch");
  const gridColor = color("--chart-grid");
  const labelColor = color("--chart-label");
  const subtleColor = color("--chart-subtle");

  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
    const lane = lanes[laneIndex];
    const laneTop = top + laneIndex * (laneHeight + laneGap);
    const laneBottom = laneTop + laneHeight;
    const { laneValue } = lane;
    const sourceValues = [
      ...sources.kinomap.map((record) => record[lane.key]),
      ...sources.fit.map((record) => record[lane.key]),
    ].filter(Number.isFinite).map(laneValue).filter(Number.isFinite);
    const maximum = lane.grow && sourceValues.length
      ? Math.max(lane.max, Math.max(...sourceValues) * 1.08)
      : lane.max;
    Object.assign(lane, { top: laneTop, bottom: laneBottom, maximum });

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
    context.font = "600 11px Inter, Segoe UI, system-ui, sans-serif";
    context.fillText(lane.title, 0, laneTop + 12);
    context.fillStyle = subtleColor;
    context.font = "10px Inter, Segoe UI, system-ui, sans-serif";
    context.fillText(lane.unit, 0, laneTop + 26);

    const drawSeries = (records, seriesColor) => {
      context.strokeStyle = seriesColor;
      context.lineWidth = 2;
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
        const value = laneValue(rawValue);
        if (!Number.isFinite(value)) {
          active = false;
          continue;
        }
        const x = left + ((record.chartTime - sources.startMs) / span) * plotWidth;
        const share = Math.min(1, Math.max(0, (value - lane.min) / (maximum - lane.min)));
        const y = laneBottom - (lane.invert ? 1 - share : share) * laneHeight;
        if (!active || (previousTime != null && record.chartTime - previousTime > 10_000)) context.moveTo(x, y);
        else context.lineTo(x, y);
        active = true;
        previousTime = record.chartTime;
      }
      context.stroke();
    };
    if (!hiddenSeries.has("watch")) drawSeries(sources.fit, colorFit);
    if (!hiddenSeries.has("kinomap")) drawSeries(sources.kinomap, colorKinomap);
  }

  layout = state.kinomap
    ? { left, top, plotWidth, plotBottom: height - bottom, startMs: sources.startMs, endMs: sources.endMs, span, lanes, sources }
    : null;
  byId("chartAxisStart").textContent = layout ? clockTime(layout.startMs) : "—";
  byId("chartAxisEnd").textContent = layout ? clockTime(layout.endMs) : "—";
  if (layout) {
    drawTrim(context, layout, trimWindow(layout.startMs, layout.endMs), {
      shade: color("--chart-trim"), handle: color("--accent"), grip: color("--surface"),
    });
  }
  drawSegments(context);
  drawHover(context, labelColor);
}

// Interval laps: a band along the top coloured by segment type and a dashed line where each segment starts.
const segmentColors = { warmup: "#f2c230", active: "--accent", recovery: "#43b649", rest: "#9aa4b2", cooldown: "#1e88e5" };

function drawSegments(context) {
  const segments = state.result?.segments;
  if (!layout || !segments?.length) return;
  const theme = getComputedStyle(document.documentElement);
  const xFor = (ms) => layout.left + ((Math.min(layout.endMs, Math.max(layout.startMs, ms)) - layout.startMs) / layout.span) * layout.plotWidth;
  const endMs = state.result.endMs;
  context.save();
  segments.forEach((segment, index) => {
    const color = segmentColors[segment.intensity]?.startsWith("--") ? theme.getPropertyValue(segmentColors[segment.intensity]).trim() : segmentColors[segment.intensity] ?? "#9aa4b2";
    const fromX = xFor(segment.startMs);
    const toX = xFor(segments[index + 1]?.startMs ?? endMs);
    context.fillStyle = color;
    context.fillRect(fromX, layout.top - 6, Math.max(1, toX - fromX - 1), 4);
    // A cadence or power target shows as a level line across its segment in the matching lane.
    const lane = segment.target > 0 && layout.lanes.find((candidate) => candidate.key === segment.targetType);
    if (lane) {
      const share = Math.min(1, Math.max(0, (lane.laneValue(segment.target) - lane.min) / (lane.maximum - lane.min)));
      const y = lane.bottom - share * (lane.bottom - lane.top);
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.setLineDash([6, 3]);
      context.beginPath();
      context.moveTo(fromX, y);
      context.lineTo(toX, y);
      context.stroke();
      context.setLineDash([]);
      context.lineWidth = 1;
    }
    if (index === 0) return;
    context.strokeStyle = color;
    context.globalAlpha = 0.6;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(fromX, layout.top);
    context.lineTo(fromX, layout.plotBottom);
    context.stroke();
    context.globalAlpha = 1;
    context.setLineDash([]);
  });
  context.restore();
}

// The record nearest to a moment, if one lies within a few seconds of it.
function nearest(records, ms) {
  let low = 0;
  let high = records.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (records[middle].chartTime < ms) low = middle + 1;
    else high = middle;
  }
  const candidates = [records[low - 1], records[low]].filter(Boolean);
  const best = candidates.sort((a, b) => Math.abs(a.chartTime - ms) - Math.abs(b.chartTime - ms))[0];
  return best && Math.abs(best.chartTime - ms) <= 5000 ? best : null;
}

// Hovering shows a guide line and both recordings' values at that moment.
function drawHover(context, lineColor) {
  const tip = byId("chartTip");
  if (!layout || hoverMs == null || hoverMs < layout.startMs || hoverMs > layout.endMs) {
    tip.hidden = true;
    return;
  }
  const x = layout.left + ((hoverMs - layout.startMs) / layout.span) * layout.plotWidth;
  context.save();
  context.strokeStyle = lineColor;
  context.globalAlpha = 0.5;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(x, layout.top);
  context.lineTo(x, layout.plotBottom);
  context.stroke();
  context.restore();

  const watch = hiddenSeries.has("watch") ? null : nearest(layout.sources.fit, hoverMs);
  const kinomap = hiddenSeries.has("kinomap") ? null : nearest(layout.sources.kinomap, hoverMs);
  const cell = (record, lane, series) => {
    const value = record?.[lane.key] == null ? null : lane.laneValue(record[lane.key]);
    return `<span class="tip-value is-${series}">${Number.isFinite(value) ? lane.format(value) : "—"}</span>`;
  };
  const showWatch = layout.sources.fit.length && !hiddenSeries.has("watch");
  const showKinomap = !hiddenSeries.has("kinomap");
  // The interval under the cursor adds its target below the lane it applies to.
  const segment = state.result?.segments?.findLast((candidate) => candidate.startMs <= hoverMs);
  const targetRow = (lane) => (segment?.target > 0 && segment.targetType === lane.key
    ? `<div class="tip-row is-target"><span>${t("segmentTarget").toLowerCase()}</span>${showWatch && showKinomap ? `<span class="tip-value"></span>` : ""}<span class="tip-value">${lane.format(lane.laneValue(segment.target))}</span><span class="tip-unit">${lane.unit}</span></div>`
    : "");
  tip.innerHTML = `<div class="tip-time">${clockTime(hoverMs)}</div>${layout.lanes.map((lane) => `<div class="tip-row"><span>${lane.title.toLowerCase()}</span>${showWatch ? cell(watch, lane, "watch") : ""}${showKinomap ? cell(kinomap, lane, "kinomap") : ""}<span class="tip-unit">${lane.unit}</span></div>${targetRow(lane)}`).join("")}`;
  tip.hidden = false;
  const width = tip.offsetWidth;
  const toLeft = x + 12 + width > layout.left + layout.plotWidth;
  tip.style.left = `${toLeft ? x - 12 - width : x + 12}px`;
}

function handleAt(clientX) {
  if (!layout || !trimMode) return null;
  const rect = elements.chart.getBoundingClientRect();
  const x = clientX - rect.left;
  const trim = trimWindow(layout.startMs, layout.endMs);
  const xFor = (ms) => layout.left + ((ms - layout.startMs) / layout.span) * layout.plotWidth;
  const distances = [["start", Math.abs(x - xFor(trim.windowStart))], ["end", Math.abs(x - xFor(trim.windowEnd))]]
    .sort((a, b) => a[1] - b[1]);
  return distances[0][1] <= handleHitPx ? distances[0][0] : null;
}

export function setupChartLegend() {
  for (const button of document.querySelectorAll(".chart-legend [data-series]")) {
    button.addEventListener("click", () => {
      const series = button.dataset.series;
      if (hiddenSeries.has(series)) hiddenSeries.delete(series);
      else hiddenSeries.add(series);
      button.setAttribute("aria-pressed", String(!hiddenSeries.has(series)));
      drawChart();
    });
  }
}

// Dragging a handle writes whole seconds into the trim inputs, which stay the source of truth for the export.
export function setupChartTrim(onChange) {
  const canvas = elements.chart;
  let dragging = null;
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) {
      const onHandle = handleAt(event.clientX);
      canvas.style.cursor = onHandle ? "ew-resize" : "";
      if (layout && event.pointerType === "mouse") {
        const x = event.clientX - canvas.getBoundingClientRect().left;
        hoverMs = onHandle || x < layout.left ? null : layout.startMs + ((x - layout.left) / layout.plotWidth) * layout.span;
        drawChart();
      }
      return;
    }
    hoverMs = null;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - layout.left) / layout.plotWidth));
    const ms = layout.startMs + ratio * layout.span;
    const trim = trimWindow(layout.startMs, layout.endMs);
    if (dragging === "start") {
      const limit = trim.windowEnd - minimumWindowMs;
      elements.trimStart.value = String(Math.max(0, Math.round((Math.min(ms, limit) - layout.startMs) / 1000)));
    } else {
      const limit = trim.windowStart + minimumWindowMs;
      elements.trimEnd.value = String(Math.max(0, Math.round((layout.endMs - Math.max(ms, limit)) / 1000)));
    }
    onChange();
  });
  canvas.addEventListener("pointerdown", (event) => {
    dragging = handleAt(event.clientX);
    if (!dragging) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", () => {
    if (dragging || hoverMs == null) return;
    hoverMs = null;
    drawChart();
  });
}
