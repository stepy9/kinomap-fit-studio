# Kinomap FIT Studio

Local browser tool for converting Kinomap TCX/PWX data to FIT or merging it with a Garmin watch FIT. Supports indoor rowing, indoor cycling, and treadmill running, without GPS; speed, cadence, power, and heart rate are included when present in the sources. Source files are processed in the browser and are not uploaded.

## Run

Requires Node.js 20.19 or newer.

```powershell
npm install
npm run dev
```

Open the localhost URL printed by Vite. Choose TCX/PWX and, for a merge, the matching watch FIT. Selecting a folder (for example a whole week) lists every Kinomap recording as its own activity in preview tabs, each paired with the watch FIT from the same folder whose time overlaps it; nothing is joined together. Each tab keeps its own settings, activities with an earlier export are marked and left unselected, and "Export selected" writes one FIT per checked activity, using the automatic offset and sport lap distance for tabs that were never opened. In Chromium browsers, folder selection uses the File System Access API so the exported FIT can be written next to the source TCX; individual-file selection and unsupported browsers use a normal download. Positive offset values move Kinomap timestamps later; automatic estimation compares the heart-rate streams and falls back to start times when the signal is weak.

The activity is split into automatic laps by distance: 500 m for rowing, 1 km for treadmill running and 5 km for indoor cycling by default. The lap distance can be changed in the tool; 0 disables splitting, and a remainder shorter than 10 % of the lap distance is folded into the previous lap. Each lap and the session carry cycle counts integrated from cadence (strokes, crank revolutions or running strides) and, for rowing, the average distance per stroke.

The output uses the watch timestamps when merging, rebases distance to zero after trimming, and writes the local timestamp of the output time zone without GPS or per-record elevation. The zone defaults to the one recorded by the watch FIT, otherwise the computer's zone; a zone picked by hand applies to the current export only. When a running or cycling Kinomap route carries altitude, its total ascent and descent are written to the session and each lap, ignoring changes below 1 m. TCX without a timezone is interpreted in the output time zone. A suspicious TCX date prompts for a manual local start time. The Kinomap title is stored in FIT `session.sportProfileName`, but Garmin Connect may ignore it and generate its own activity title. The Connect event category and activity notes/URL are not represented by the FIT activity profile; edit these fields in Connect after import when needed. The supplied TCX/PWX samples contain no activity URL.

## Install and GitHub Pages

The built app is a progressive web app: Chrome or Edge offer to install it from the address bar, and it then starts from the desktop or Start menu and works offline. Try the build locally with `npm run build` and `npm run preview`.

To publish it for free on GitHub Pages, push the repository to GitHub and, under Settings → Pages, set Source to "GitHub Actions". The workflow in `.github/workflows/pages.yml` then tests, builds and deploys every push to `main` to `https://<user>.github.io/<repository>/`. The `samples` folder is ignored by Git, so private recordings stay local. Workout files are still processed only in the browser.

## Checks

```powershell
npm test
npm run build
```

Tests run against synthetic fixtures in `test/fixtures/{rowing,cycling,running}`: a Kinomap TCX and PWX plus a Garmin watch FIT whose heart rate lags Kinomap by 7 s. Regenerate them with `npm run fixtures` (`scripts/generate-fixtures.mjs`). Private recordings in the git-ignored `samples` folder are tested too when present.

Running cadence is kept in steps per minute inside the tool; Kinomap files with per-leg cadence (median below 120) are doubled on import, and the FIT export writes strides per minute with `fractional_cadence`, as Garmin watches do.