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

export function fitFileName(activityName, fallback) {
  const safeName = String(activityName ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/[. ]+$/g, "") || fallback;
  return `${safeName}.fit`;
}

