import { elements, state, t } from "./context.js";

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
  const colorKinomap = theme.getPropertyValue("--series-source").trim();
  const colorFit = theme.getPropertyValue("--series-watch").trim();
  const gridColor = theme.getPropertyValue("--chart-grid").trim();
  const labelColor = theme.getPropertyValue("--chart-label").trim();
  const subtleColor = theme.getPropertyValue("--chart-subtle").trim();

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

    const drawSeries = (records, color) => {
      context.strokeStyle = color;
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
}
