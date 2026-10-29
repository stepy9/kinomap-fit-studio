// Plans a folder of Kinomap recordings as separate activities, each paired with its own watch FIT when one overlaps it.
import { buildWorkout, decodeGarminFit, estimateOffset, parseKinomap } from "./core.js";
import { titleFromKinomapFileName } from "./files.js";

// A watch recording counts as the same activity when it overlaps the Kinomap one, allowing this much clock skew.
const pairingToleranceMs = 15 * 60 * 1000;

const folderOf = (file) => (file.webkitRelativePath || file.name).split("/").slice(0, -1).join("/");
const baseName = (file) => file.name.replace(/\.(tcx|pwx)$/i, "");
const overlapMs = (a, b) => Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);

async function decodedFits(files) {
  const decoded = await Promise.all(files.filter((file) => /\.fit$/i.test(file.name)).map(async (file) => {
    try {
      const fit = decodeGarminFit(await file.arrayBuffer());
      return { file, fit, folder: folderOf(file), exported: fit.fileId?.manufacturer === "development" };
    } catch {
      return null;
    }
  }));
  return decoded.filter(Boolean);
}

// One activity per Kinomap recording; a TCX wins over a PWX of the same name.
function kinomapSources(files) {
  const byKey = new Map();
  for (const file of files.filter((item) => /\.(tcx|pwx)$/i.test(item.name))) {
    const key = `${folderOf(file)}/${baseName(file)}`;
    if (!byKey.has(key) || /\.tcx$/i.test(file.name)) byKey.set(key, file);
  }
  return [...byKey.entries()];
}

export function parseBatchKinomap(item, manualStart) {
  return parseKinomap(item.kinomapText, { fallbackStartMs: item.kinomapFile.lastModified || Date.now(), timeZone: item.timeZone, manualStart });
}

export async function planBatch(files, { timeZone = "Europe/Prague", fallbackTitle = "Kinomap" } = {}) {
  const all = [...files];
  const fits = await decodedFits(all);
  const items = await Promise.all(kinomapSources(all).map(async ([id, kinomapFile]) => {
    const item = {
      id, kinomapFile, timeZone, fitFile: null, directoryHandle: kinomapFile.sourceDirectoryHandle ?? null,
      title: titleFromKinomapFileName(kinomapFile.name) || fallbackTitle, exported: false, error: null,
    };
    try {
      item.kinomapText = await kinomapFile.text();
      const kinomap = parseBatchKinomap(item);
      const range = { startMs: kinomap.records[0].timeMs, endMs: kinomap.records.at(-1).timeMs };
      const nearby = fits
        .filter((candidate) => candidate.folder === folderOf(kinomapFile))
        .map((candidate) => ({ ...candidate, overlap: overlapMs(range, candidate.fit) }))
        .filter((candidate) => candidate.overlap > -pairingToleranceMs);
      const watch = nearby.filter((candidate) => !candidate.exported).sort((a, b) => b.overlap - a.overlap)[0];
      Object.assign(item, {
        sport: kinomap.sport,
        startMs: kinomap.startMs,
        needsManualStart: Boolean(kinomap.needsManualStart),
        fitFile: watch?.file ?? null,
        fit: watch?.fit ?? null,
        exported: nearby.some((candidate) => candidate.exported),
      });
    } catch (error) {
      item.error = error.message;
    }
    item.selected = !item.error && !item.exported && !item.needsManualStart;
    return item;
  }));
  return items.sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
}

// Settings left untouched in the UI fall back to the defaults a single export would use.
export function buildBatchWorkout(item, settings = {}) {
  const kinomap = parseBatchKinomap(item, settings.manualStart || undefined);
  if (kinomap.needsManualStart && !settings.manualStart) throw new Error("Datum vypadá neplatně; zadejte místní začátek tréninku.");
  const fit = settings.mode === "convert" ? null : item.fit;
  const alignmentMode = settings.alignmentMode ?? "absolute";
  const offsetSeconds = settings.offsetSeconds ?? (fit ? estimateOffset(kinomap, fit, { alignmentMode }).offsetSeconds : 0);
  return buildWorkout(kinomap, fit, {
    timeZone: item.timeZone,
    alignmentMode,
    offsetSeconds,
    trimStartSeconds: settings.trimStartSeconds,
    trimEndSeconds: settings.trimEndSeconds,
    lapDistanceMeters: settings.lapDistanceMeters,
    activityName: settings.activityName ?? `Kinomap - ${item.title}`,
  });
}
