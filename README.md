# PhysioNotes

A private, local-first notes app for physiotherapists. Installable as a PWA (phone, tablet, desktop), works offline, no account and no build step.

## Features

- **Patient profiles** – demographics, condition, onset, history, medications, precautions, goals, consent, discharge/reopen.
- **Visit notes** – initial assessment, follow-up, re-assessment and discharge visits with Subjective / Objective / Assessment / Plan, treatment given, home exercise programme, pain (0–10), function (0–10) and any number of custom outcome measures (ROM, strength, TUG, …). Notes **autosave** as you type.
- **Voice notes** – record audio during the session; audio is stored with the visit and the **transcript is stored and editable**. Live transcription uses the browser's speech recognition (Chrome, Edge, Safari). Where that isn't available (e.g. Firefox) use *Transcribe with AI* (Gemini) or type.
- **Follow-ups** – "+ Follow-up visit" opens a new visit with the previous visit's assessment / plan / HEP / goals shown for reference, and carries your outcome measures forward so they are comparable.
- **Progress tracking** – pain & function chart, measure trends, status (on track / improving / plateau / worsening), alerts (pain spikes, no visit in 3+ weeks) and a red-flag keyword scan (negations like "denies night pain" are ignored).
- **Free AI assistant** – reviews all notes, tracks progress and recommends a course of treatment:
  | Option | Cost | Privacy |
  |---|---|---|
  | **Built-in offline reviewer** (default) | free | nothing leaves the device |
  | **Google Gemini free tier** (your own API key from <https://aistudio.google.com/apikey>) | free | data sent to Google; names/DOB/contacts are stripped first by default |
  | **Ollama** (local open-source model) | free | fully local |

  Gemini/Ollama also give: free-text questions about a patient, and *dictation → SOAP* structuring. AI output is decision support only.
- **Backup** – export/import everything (optionally with audio) as JSON; print a patient page.

## Run it

PhysioNotes is a static website. It must be *served* (opening `index.html` by double-click does not work because browsers block modules and the microphone on `file://`).

**Windows:** unzip the folder and double-click **`start.bat`** — it opens http://localhost:8080 (uses Node or Python if installed, otherwise built-in PowerShell; nothing to install).
**Mac/Linux:** double-click/run `start.command`, or `node serve.mjs` / `python3 -m http.server 8080`.
**On your phone / anywhere (recommended):** host it over HTTPS — a GitHub Pages workflow is included (`.github/workflows/pages.yml`). In the repo: *Settings → Pages → Source: GitHub Actions*, merge to `main`, and open the published link. Then use *Add to Home Screen* to install it. (Note: each device/browser keeps its own separate data.)

`npm test` runs the unit tests for the analysis engine.

## Set up the free Gemini AI

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. *Create API key* (free tier, no payment details) and copy it.
3. In PhysioNotes → **Settings**, paste it and press **Save & test**.

## Privacy & compliance — please read

- All patient data is stored **in your browser on this device only** (IndexedDB). There is no server. Clearing site data or losing the device loses it: **export backups regularly** and keep them encrypted. Use device encryption/screen lock.
- Browser speech recognition (Chrome/Edge) streams audio to the vendor's speech service. The Gemini free tier sends text/audio to Google and its terms permit product-improvement use of free-tier inputs. Neither is a health-information-custodian arrangement. Get patient consent, keep de-identification on, and check your regulator's and privacy-law requirements (PHIPA / PIPEDA / provincial rules) — or use the offline and Ollama options with typed/recorded-only notes.
- The red-flag scan and rule-based suggestions are simple heuristics (MCID ≈ 2 points for NPRS/PSFS). They never replace clinical judgment.

## Layout

```
index.html, sw.js, manifest.webmanifest
js/analysis.js  pure trend/plateau/red-flag/suggestion logic (unit tested)
js/ai.js        providers (offline, Gemini, Ollama), de-identification, prompts
js/voice.js     recorder + live speech recognition + WAV conversion
js/db.js        IndexedDB       js/charts.js  SVG charts     js/app.js  UI/router
```
