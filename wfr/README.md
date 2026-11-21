# WFR Field Log

An offline-first mobile app for wilderness first responders to log patient assessments and vitals in the field.
It is a Progressive Web App: open it once with signal, choose **Add to Home Screen**, and from then on it runs with no connection at all.

**Live (after GitHub Pages deploys):** `https://<user>.github.io/skills-github-pages/wfr/`

> Documentation aid only. It does not replace your training, protocols or medical direction.

## What's in this prototype

| Area | Status |
|---|---|
| Standardized patient record: basics, scene, ABCDE primary survey, chief complaint + OPQRST, head-to-toe exam, SAMPLE, problem list + plan, evacuation mode + urgency | ✅ |
| One-tap **New patient** (time found + GPS captured automatically) | ✅ |
| Auto-save on every change, encrypted (AES-256-GCM) in IndexedDB with `durability: strict` writes | ✅ |
| Vitals sets (LOR A+O×4…U, HR, RR, BP or radial pulse, skin, pupils, temp, SpO₂, glucose), auto time-stamped | ✅ |
| Glove-friendly number pad with **Next →** chaining, quick-select buttons, quick-text chips | ✅ |
| Trend table + line charts, worsening flags (falling LOR, rising HR/RR, falling BP/SpO₂, lost radial pulse, skin/pupil changes) | ✅ |
| Recheck reminder timer (default 15 min, sound + vibration + notification) | ✅ |
| Map: GPS pin per patient, drag to correct, manual lat/long or UTM entry, location note when GPS fails | ✅ |
| Lat/long, DMS and UTM display (incl. Norway/Svalbard zones) | ✅ |
| All-patient map with B&W-readable urgency pins (solid / striped / outlined / dashed + text) | ✅ |
| Offline map tiles: download the on-screen area before a trip; coordinate grid when no tiles | ✅ |
| Multiple patients: list sorted by urgency, quick-switch strip | ✅ |
| Day / night (dark) high-contrast themes, Large / XL text, battery saver | ✅ |
| PIN lock (PIN-derived key wraps the data key; auto-lock when hidden) | ✅ |
| Handoff: ISBAR (radio), 160-char satellite message, SOAP, full record; copy / share / .txt / PDF via print | ✅ (early phase 2) |
| Push-to-talk voice entry with parse → confirm/edit → save | ✅ (early phase 2, see limits) |
| Optional cloud sync (HTTP PUT to your endpoint) with "Saved on device / Synced" status | ✅ basic |

## Known limits / next phase

- **Voice offline:** uses the browser's speech recognition and asks for on-device processing where supported (Chrome 139+ with the language pack). Elsewhere it may need signal; the mic then opens a text box where the phone keyboard's own dictation (offline on most phones) works with the same parser. Guaranteed offline recognition on every phone needs a native wrapper (e.g. Capacitor + platform speech or Vosk/Whisper).
- **Biometric unlock** is not implemented. A 4-digit PIN can be brute-forced by someone holding a copy of the device's data; use 6+ digits. Hardware-backed keys need a native wrapper.
- **Map tiles:** public OpenStreetMap/OpenTopoMap servers only allow light use. Downloads are capped at 4,000 tiles; for teams, set a custom tile provider in Settings.
- **Reminders** fire while the app is open or recently backgrounded; phones may delay timers when the screen is off.
- **Sync** sends plain JSON to the URL you configure. Use HTTPS and a server you control.
- Browsers can clear site data. Install to the home screen and tap *Protect data from browser clean-up* in Settings.

## Code

Plain ES modules, no build step. Leaflet 1.9.4 is vendored in `vendor/` so maps work offline.

```
index.html, sw.js, manifest.webmanifest
js/app.js      routing, views, form binding, timers, voice UI, lock
js/model.js    standardized record schema, option lists, trend/worsening analysis
js/store.js    IndexedDB + WebCrypto encryption, PIN key wrapping, coalescing saver
js/utm.js      WGS84 ↔ UTM, coordinate formatting/parsing
js/voice.js    speech → fields parser, recognizer wrapper
js/export.js   SOAP / ISBAR / satellite / full-record text
js/chart.js    monochrome SVG trend charts
js/map.js      Leaflet helpers, pins, offline tile download
```

Run locally: `cd wfr && python3 -m http.server 8000`, then open http://localhost:8000.
Tests (pure logic; UTM checked against PROJ): `node --test wfr/tests/*.test.mjs`
