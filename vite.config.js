import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

// Every build gives the service worker a new version, so installed apps notice the update.
const stampServiceWorker = {
  name: "stamp-service-worker",
  apply: "build",
  writeBundle({ dir }) {
    const file = join(dir, "sw.js");
    writeFileSync(file, readFileSync(file, "utf8").replace("__BUILD__", Date.now().toString(36)));
  },
};

// Relative paths let the build run from any folder, such as a GitHub Pages project site.
export default defineConfig({
  base: "./",
  plugins: [stampServiceWorker],
});
