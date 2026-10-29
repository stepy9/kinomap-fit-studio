import { byId, clockTime, elements, formatDuration, state, t } from "./context.js";

// The chart spans the whole untrimmed section; the trim is shaded and adjusted by dragging its two handles.
const handleHitPx = 10;
const minimumWindowMs = 10_000;
let layout = null;

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
  const running = state.kinomap?.sport === "running";
  const cadenceMax = state.kinomap?.sport === "cycling" ? 140 : running ? 220 : 60;
  const lanes = [
    { key: "heartRate", title: t("heartRateLane"), unit: "bpm", min: 40, max: 200 },
    running
      ? { key: "speed", title: t("speedLane"), unit: "km/h", min: 0, max: 18, scale: 3.6 }
      : { key: "power", title: t("powerLane"), unit: "W", min: 0, max: 400 },
    { key: "cadence", title: t("cadenceLane"), unit: state.kinomap?.sport === "cycling" ? "rpm" : "spm", min: 0, max: cadenceMax },
  ];
  const left = 56;
  const right = 10;
  const top = 7;
  const bottom = 5;
  const laneGap = 9;
  const laneHeight = (height - top - bottom - laneGap * 2) / 3;
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

  layout = state.kinomap
    ? { left, top, plotWidth, plotBottom: height - bottom, startMs: sources.startMs, endMs: sources.endMs, span }
    : null;
  byId("chartAxisStart").textContent = layout ? clockTime(layout.startMs) : "—";
  byId("chartAxisEnd").textContent = layout ? clockTime(layout.endMs) : "—";
  if (layout) {
    drawTrim(context, layout, trimWindow(layout.startMs, layout.endMs), {
      shade: color("--chart-trim"), handle: color("--accent"), grip: color("--surface"),
    });
  }
}

function handleAt(clientX) {
  if (!layout) return null;
  const rect = elements.chart.getBoundingClientRect();
  const x = clientX - rect.left;
  const trim = trimWindow(layout.startMs, layout.endMs);
  const xFor = (ms) => layout.left + ((ms - layout.startMs) / layout.span) * layout.plotWidth;
  const distances = [["start", Math.abs(x - xFor(trim.windowStart))], ["end", Math.abs(x - xFor(trim.windowEnd))]]
    .sort((a, b) => a[1] - b[1]);
  return distances[0][1] <= handleHitPx ? distances[0][0] : null;
}

// Dragging a handle writes whole seconds into the trim inputs, which stay the source of truth for the export.
export function setupChartTrim(onChange) {
  const canvas = elements.chart;
  let dragging = null;
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) {
      canvas.style.cursor = handleAt(event.clientX) ? "ew-resize" : "";
      return;
    }
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
}
