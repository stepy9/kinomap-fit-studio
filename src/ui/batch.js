import { byId, sportLabel, state, t } from "./context.js";

const panel = byId("batchPanel");
const tabs = byId("batchTabs");
const note = byId("batchNote");
const exportButton = byId("batchExportButton");

function shortDate(epochMs) {
  if (!Number.isFinite(epochMs)) return "—";
  return new Intl.DateTimeFormat(state.language === "en" ? "en-GB" : "cs-CZ", {
    timeZone: "Europe/Prague", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(epochMs));
}

function statusFor(item) {
  if (item.status === "saving") return ["is-busy", t("batchSaving")];
  if (item.status === "failed") return ["is-error", t("batchFailed")];
  if (item.error) return ["is-error", t("batchError")];
  if (item.needsManualStart && !item.settings?.manualStart) return ["is-warning", t("batchNeedsDate")];
  if (item.exported) return ["is-done", t("batchExported")];
  return ["", item.fitFile ? t("batchMerge") : t("batchConvert")];
}

export function renderBatchTabs({ onSelect, onToggle }) {
  const batch = state.batch;
  panel.hidden = !batch;
  if (!batch) return;
  tabs.replaceChildren(...batch.items.map((item) => {
    const tab = document.createElement("div");
    tab.className = `batch-tab${item.id === batch.activeId ? " is-active" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.selected;
    checkbox.disabled = Boolean(item.error) || batch.busy;
    checkbox.setAttribute("aria-label", t("batchSelectAria", { title: item.title }));
    checkbox.addEventListener("change", () => onToggle(item, checkbox.checked));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "batch-tab-button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(item.id === batch.activeId));
    button.disabled = Boolean(item.error) || batch.busy;
    button.title = item.failure ?? item.error ?? item.title;
    const [statusClass, statusText] = statusFor(item);
    button.innerHTML = `<span class="batch-tab-meta"></span><span class="batch-tab-title"></span><span class="batch-tab-status ${statusClass}"></span>`;
    button.querySelector(".batch-tab-meta").textContent = `${shortDate(item.startMs)}${item.sport ? ` · ${sportLabel(item.sport)}` : ""}`;
    button.querySelector(".batch-tab-title").textContent = item.title;
    button.querySelector(".batch-tab-status").textContent = statusText;
    button.addEventListener("click", () => onSelect(item));

    tab.append(checkbox, button);
    return tab;
  }));
  const selected = batch.items.filter((item) => item.selected).length;
  note.textContent = t("batchSelected", { count: selected, total: batch.items.length });
  exportButton.disabled = !selected || batch.busy;
  exportButton.firstElementChild.textContent = t("batchExport", { count: selected });
}
