# Kinomap FIT Studio

Local browser tool for converting Kinomap TCX/PWX data to FIT or merging it with a Garmin watch FIT. Supports indoor rowing, indoor cycling, and treadmill running, without GPS; speed, cadence, power, and heart rate are included when present in the sources. Source files are processed in the browser and are not uploaded.

## Run

Requires Node.js 20.19 or newer.

```powershell
npm install
npm run dev
```

Open the localhost URL printed by Vite. Choose TCX/PWX and, for a merge, the matching watch FIT. Selecting a folder chooses the newest date with both source types when available. Positive offset values move Kinomap timestamps later; automatic estimation compares the heart-rate streams and falls back to start times when the signal is weak.

The output uses the watch timestamps when merging, rebases distance to zero after trimming, and writes the Europe/Prague local timestamp without GPS or elevation. TCX without a timezone is interpreted in Europe/Prague. A suspicious TCX date prompts for a manual local start time. The Kinomap title is stored in FIT `session.sportProfileName`, but Garmin Connect may ignore it and generate its own activity title. The Connect event category and activity notes/URL are not represented by the FIT activity profile; edit these fields in Connect after import when needed. The supplied TCX/PWX samples contain no activity URL.

## Checks

```powershell
npm test
npm run build
```