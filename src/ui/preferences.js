import { drawChart } from "./chart.js";
import { elements } from "./context.js";

export function setTheme(theme, persist = true) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  elements.lightThemeButton.setAttribute("aria-pressed", String(!isDark));
  elements.darkThemeButton.setAttribute("aria-pressed", String(isDark));
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#060a12" : "#0b1220";
  if (persist) {
    try {
      localStorage.setItem("kinomap-fit-theme", isDark ? "dark" : "light");
    } catch {}
  }
  drawChart();
}

export function savedTheme() {
  try {
    return localStorage.getItem("kinomap-fit-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function systemZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Prague";
}

export function savedZone() {
  try {
    const saved = localStorage.getItem("kinomap-fit-zone");
    // An unknown zone would make Intl throw; fall back to the system one.
    if (saved) new Intl.DateTimeFormat("en", { timeZone: saved });
    return saved || systemZone();
  } catch {
    return systemZone();
  }
}

export function persistZone(value) {
  try {
    localStorage.setItem("kinomap-fit-zone", value);
  } catch {}
}

export function savedLanguage() {
  try {
    return localStorage.getItem("kinomap-fit-language") === "en" ? "en" : "cs";
  } catch {
    return "cs";
  }
}

export function setLanguageMenu(open) {
  elements.languageMenu.hidden = !open;
  elements.languageButton.setAttribute("aria-expanded", String(open));
}
