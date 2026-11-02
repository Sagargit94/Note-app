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
- **Clinic mode (optional)** – central sign-in by work email, administrator approval, a user directory (name, email, status) with disable/remove, and an activity log; sync through a free Supabase project. See *Clinic mode*.
- **Multiple clinicians, private accounts** – each colleague creates their own login. Every account has its **own encrypted database**; patients, notes, recordings and the Gemini key are AES-256-GCM encrypted with a key unlocked only by that person's password. Auto-lock after inactivity, manual Lock / Sign out, recovery key, change password, delete account.
- **Encrypted backup** – export/import everything (optionally with audio) as a passphrase-encrypted file; print a patient page.

## Run it

PhysioNotes is a static website. It must be *served* (opening `index.html` by double-click does not work because browsers block modules and the microphone on `file://`).

**Quick local try-out (Windows):** unzip the folder and double-click **`start.bat`** — opens http://localhost:8080 (uses Node or Python if installed, otherwise built-in PowerShell). Mac/Linux: `start.command`, or `node serve.mjs`.

**For real use on your phone *and* laptop, put it online over HTTPS** (needed for the microphone and Dropbox sign-in on a phone). The app contains no patient data or secrets, so any free static host works:

- **Netlify Drop (easiest):** run `npm run build` (or just use the files in `site/`), then drag the **`site`** folder onto <https://app.netlify.com/drop>. You get an `https://…netlify.app` address immediately.
- **Cloudflare Pages / GitHub Pages:** a Pages workflow is included (`.github/workflows/pages.yml`; repo *Settings → Pages → Source: GitHub Actions*, merge to `main`). GitHub Pages needs a public repo on free plans — fine, since the code holds no data.

Open that address on each device and use *Add to Home Screen* to install it.

`npm test` runs the unit tests (analysis engine, accounts, encryption) and — when a Postgres is reachable via `PGHOST/PGPORT/PGUSER` — the 22 database security tests for `supabase/schema.sql`. Browser tests in `tests/e2e/` (need Playwright): two-device Dropbox sync against a mock Dropbox, and the full clinic flow (sign-up, approval, disable, isolation, password reset) against a Supabase stand-in running on real Postgres.

## Sync between your phone and laptop (Dropbox, end-to-end encrypted)

Everything is encrypted on your device *before* it is uploaded to a private app folder in **your own Dropbox**; Dropbox only ever stores unreadable files. There is no PhysioNotes server. Each colleague uses their own Dropbox, so accounts stay separate.

**One-time setup (≈5 min), on the first device** — Settings → *Sync across devices* shows these steps with your exact redirect address:
1. <https://www.dropbox.com/developers/apps> → *Create app* → *Scoped access* → *App folder* → name it.
2. *Permissions* tab: tick `files.metadata.read/write` and `files.content.read/write` → Submit.
3. *Settings* tab: add your app's address (e.g. `https://yourname.netlify.app/`) under *Redirect URIs*; copy the **App key**.
4. In PhysioNotes: paste the App key → *Connect Dropbox* → approve → sign in. Existing notes upload automatically.

**On your second device:** open the same web address → *Set up from Dropbox* → same App key → pick your account → sign in with your usual password. Your patients, notes and recordings download and decrypt locally.

How it behaves: works fully offline and syncs in the background when online (header shows ☁ Synced / ⟳ Syncing / Offline). Signing out or auto-locking pushes your last edits first. If the **same visit is edited on two devices**, nothing is lost: the newer version stays and the other is kept as a **"Conflict copy"** for you to review. Deleting a patient/visit on one device removes it on the others. Voice recordings sync too (each recording up to ~13 MB).

## Clinic mode: central sign-in, approvals and an admin directory (free Supabase)

For a team: everyone signs in with their **work email**, new sign-ups must be **approved by an administrator**, the admin sees a **directory** (name, email, role, status, last active, storage used) and can **disable, re-enable, promote or remove** people. An activity log records every admin action. Encrypted notes sync between each person's devices through the clinic database (no Dropbox needed). Leave `js/config.js` empty to stay in solo mode.

**What admins can and can't see.** Names, emails, status and storage use — never patients. Patient data is still end-to-end encrypted with each clinician's own password, in their browser; the database only holds ciphertext. The server never receives the real password either: it gets a separate login secret derived from it.

**One-time setup (~10 min, done by the administrator; all free):**
1. Create a free project at <https://supabase.com> (choose a region near you — e.g. *Canada (Central)* for Canadian clinics).
2. *SQL Editor → New query*: paste all of [`supabase/schema.sql`](supabase/schema.sql), **replace `EDIT-ME@example.com` with the administrator's email** (the one marked line), and *Run*. It is safe to run again later.
3. *Authentication → Sign In / Providers → Email*: switch **off** "Confirm email" (otherwise every colleague needs an email code; Supabase's built-in mailer only sends a few emails per hour). Leave "Enable sign ups" on — newcomers can't do anything until you approve them.
4. *Authentication → URL Configuration*: set **Site URL** to your app's web address and add it under **Redirect URLs** (needed for password-reset links).
5. *Project Settings → API*: copy the **Project URL** and the **anon public** key (never the `service_role`/secret key — the build refuses it).
6. Build and publish: `npm run build -- --url https://xxxx.supabase.co --key <anon key> --name "My Clinic"`, then upload the `site` folder to your HTTPS host (see *Run it*). Or edit `js/config.js` directly.
7. **Sign up first, with the administrator email** — you become admin automatically. Then share the link: colleagues sign up, see "Waiting for approval", and appear in *Clinic* for you to approve.

**Good to know**
- *Disabling someone* blocks their sign-in and all cloud access immediately, and their open app locks within about a minute. Copies already on their own devices stay on those devices (the clinic can't reach into them).
- *No admin recovery of patient notes.* Because only each clinician's password/recovery key can decrypt their data, **if someone leaves, the clinic cannot read their patients' notes** — ask them to export an encrypted backup (Settings) first. A deliberate "clinic recovery key" escrow could be added if your policies need it; it's a decision about who may read patient records, so it's off by default.
- *Lost password* → emailed reset link **plus** the recovery key saved at sign-up. Lose both and that person's data is unrecoverable by design.
- *Free-tier limits:* 500 MB database (voice recordings count toward it), the project pauses after ~1 week of no activity (one click to resume; nothing is lost), and no automatic backups — keep encrypted exports.
- *Register the administrator account before sharing the link:* anyone who signs up with the admin email first would become admin.

## Accounts & security model

- **How isolation works.** Passwords never leave the device and are never stored. A random 256-bit data key encrypts every record; that key is itself wrapped by a key derived from your password (PBKDF2-SHA-256, 600 000 iterations) and, separately, by your one-time **recovery key**. Each account uses a separate IndexedDB database, and each record's ciphertext is bound to its own ID so it can't be swapped between records. Without the password or recovery key, the stored bytes are unreadable — even to another user of the same browser or someone copying the browser profile. The unlocked key is held in memory only (non-extractable) and dropped on lock.
- **No password reset by anyone else.** There is no server or admin. If a user loses both password and recovery key, their data cannot be recovered (by design).
- **Same device vs. different devices.** Colleagues can share one computer, each with their own login, with no visibility into each other's patients. To use one account on several devices, turn on Dropbox sync (above): every device has the same data key, unlocked by the same password. Sync is **per person** — there is no shared patient list between colleagues. A central clinic server (shared caseloads, audit logs, admin) would be a different architecture.
- **What Dropbox (or anyone with your Dropbox) can see.** Only ciphertext, random record IDs, file sizes and timing — no names, notes or audio. They also hold your account file (username, display name and your data key *wrapped by your password*), so a **strong password matters**: someone with your Dropbox could try to guess it offline (PBKDF2 slows this down). Don't share the Dropbox folder, and disconnect + delete the cloud copy from Settings when leaving the clinic. Token for Dropbox is kept encrypted on each device.
- **Hardening.** Strict Content-Security-Policy (no inline scripts; network access only to Google's Google Gemini, Dropbox, and localhost for Ollama), no third-party scripts, no analytics, `no-referrer`.
- **What encryption does *not* cover.** Text sent to Gemini and audio sent to the browser's speech service leave the device by design (de-identification is on by default). Malware or a hostile browser extension on an unlocked device can read what's on screen. Usernames and display names are visible on the sign-in screen. Use a device passcode/disk encryption too.

## Privacy & compliance — please read

- All patient data is stored **in your browser on this device only** (encrypted IndexedDB). Clearing site data or losing the device loses it: **export backups regularly** and keep them safe.
- Browser speech recognition (Chrome/Edge) streams audio to the vendor's speech service. The Gemini free tier sends text/audio to Google and its terms permit product-improvement use of free-tier inputs. Neither is a health-information-custodian arrangement. Get patient consent, keep de-identification on, and check your regulator's and privacy-law requirements (PHIPA / PIPEDA / provincial rules) — or use the offline and Ollama options with typed/recorded-only notes.
- The red-flag scan and rule-based suggestions are simple heuristics (MCID ≈ 2 points for NPRS/PSFS). They never replace clinical judgment.

## Layout

```
index.html, sw.js, manifest.webmanifest
js/analysis.js  pure trend/plateau/red-flag/suggestion logic (unit tested)
js/ai.js        providers (offline, Gemini, Ollama), de-identification, prompts
js/voice.js     recorder + live speech recognition + WAV conversion
js/crypto.js    Web Crypto helpers (key wrap, AES-GCM, recovery key, backups)
js/auth.js      accounts: sign-up, login, recovery, password change
js/central.js   clinic backend client (Supabase auth + checked functions)   js/config.js  clinic settings
supabase/schema.sql  clinic database: tables locked down, access only via checked functions
js/dropbox.js   Dropbox OAuth (PKCE) + file API     js/sync.js  encrypted sync engine & conflict handling
js/db.js        per-user encrypted IndexedDB     js/charts.js  SVG charts     js/app.js  UI/router
```
