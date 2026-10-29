import { decodeGarminFit } from "./fit.js";

export function folderCandidates(files) {
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

// FIT files written by this tool carry manufacturer "development"; skip them so a previous export is never picked as the watch file.
export async function isExportedFit(file) {
  try {
    return decodeGarminFit(await file.arrayBuffer()).fileId?.manufacturer === "development";
  } catch {
    return false;
  }
}

export async function collectDirectoryFiles(directoryHandle, relativePath = "", files = []) {
  for await (const [name, entry] of directoryHandle.entries()) {
    const entryPath = relativePath ? `${relativePath}/${name}` : name;
    if (entry.kind === "directory") {
      await collectDirectoryFiles(entry, entryPath, files);
    } else if (/\.(tcx|pwx|fit)$/i.test(name)) {
      const file = await entry.getFile();
      files.push({
        name: file.name,
        lastModified: file.lastModified,
        webkitRelativePath: entryPath,
        sourceDirectoryHandle: directoryHandle,
        text: () => file.text(),
        arrayBuffer: () => file.arrayBuffer(),
      });
    }
  }
  return files;
}

export function titleFromKinomapFileName(name) {
  return name.replace(/\.(tcx|pwx)$/i, "").replace(/--\d+$/, "")
    // Kinomap titles often carry emoji and full-width punctuation; keep letters, digits and plain punctuation.
    .normalize("NFKC")
    .replace(/[\p{Extended_Pictographic}\p{So}\p{Cf}\u{FE0E}\u{FE0F}\u{20E3}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function withoutExportedFits(files) {
  const all = [...files];
  const exported = await Promise.all(all.map((file) => /\.fit$/i.test(file.name) && isExportedFit(file)));
  return all.filter((_, index) => !exported[index]);
}
