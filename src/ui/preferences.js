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

// Last-used lap distance per sport and feel/effort, offered as defaults for the next activity.
const defaultsKey = "kinomap-fit-defaults";

export function savedDefaults() {
  try {
    return JSON.parse(localStorage.getItem(defaultsKey)) ?? {};
  } catch {
    return {};
  }
}

export function saveDefaults(patch) {
  try {
    localStorage.setItem(defaultsKey, JSON.stringify({ ...savedDefaults(), ...patch }));
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
