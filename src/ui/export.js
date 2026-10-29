import { elements, setNotice, state, t } from "./context.js";

function downloadFit(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export async function exportFit() {
  if (!state.result) return;
  const safeName = (elements.activityName.value || state.result.activityName || t("fallbackActivity"))
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/[. ]+$/g, "") || t("fallbackActivity");
  const filename = `${safeName}.fit`;
  const blob = new Blob([state.result.fitBytes], { type: "application/octet-stream" });
  let saveFallbackMessage = "";
  if (state.outputDirectoryHandle) {
    setNotice(t("savingBesideFiles"));
    try {
      let permission = await state.outputDirectoryHandle.queryPermission?.({ mode: "readwrite" });
      if (permission !== "granted") permission = await state.outputDirectoryHandle.requestPermission({ mode: "readwrite" });
      if (permission === "granted") {
        const fileHandle = await state.outputDirectoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        setNotice(t("savedBesideFiles"), "success");
        return;
      }
      saveFallbackMessage = t("savePermissionDenied");
    } catch (error) {
      saveFallbackMessage = error.message;
    }
  }
  try {
    downloadFit(blob, filename);
    setNotice(saveFallbackMessage
      ? t("saveFallbackStarted", { message: saveFallbackMessage })
      : t("downloadStarted", { filename }), saveFallbackMessage ? "" : "success");
  } catch (error) {
    setNotice(t("exportFailed", { message: error.message }), "error");
  }
}
