import { fitFileName } from "../files.js";
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

// Writes the FIT next to the source files when a writable folder handle is available, otherwise downloads it.
export async function saveFit(fitBytes, filename, directoryHandle) {
  const blob = new Blob([fitBytes], { type: "application/octet-stream" });
  let fallbackMessage = "";
  if (directoryHandle) {
    try {
      let permission = await directoryHandle.queryPermission?.({ mode: "readwrite" });
      if (permission !== "granted") permission = await directoryHandle.requestPermission({ mode: "readwrite" });
      if (permission === "granted") {
        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { saved: true, fallbackMessage };
      }
      fallbackMessage = t("savePermissionDenied");
    } catch (error) {
      fallbackMessage = error.message;
    }
  }
  downloadFit(blob, filename);
  return { saved: false, fallbackMessage };
}

export async function exportFit() {
  if (!state.result) return;
  const filename = fitFileName(elements.activityName.value || state.result.activityName, t("fallbackActivity"));
  if (state.outputDirectoryHandle) setNotice(t("savingBesideFiles"));
  try {
    const { saved, fallbackMessage } = await saveFit(state.result.fitBytes, filename, state.outputDirectoryHandle);
    if (saved) setNotice(t("savedBesideFiles"), "success");
    else if (fallbackMessage) setNotice(t("saveFallbackStarted", { message: fallbackMessage }));
    else setNotice(t("downloadStarted", { filename }), "success");
  } catch (error) {
    setNotice(t("exportFailed", { message: error.message }), "error");
  }
}
