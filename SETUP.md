# Kensara Sales — setup

Everything runs on free tiers: **Netlify** (hosting), **Google Apps Script + Drive + Sheets** (backend and storage), **Gemini** (AI, free key), **Groq** (optional AI fallback). There is no paid database.

Allow about 20 minutes.

## 1. Backend (Google Apps Script)

1. Go to [sheets.new](https://sheets.new) with the Google account that should own the data. Name the sheet `Kensara Sales CRM`.
2. **Extensions → Apps Script**. Delete the sample code and paste all of [`apps-script/Code.gs`](apps-script/Code.gs). Save.
3. **Project Settings (gear) → Script properties → Add**:
   | Property | Value |
   |---|---|
   | `ADMIN_KEY` | A private passphrase, 12+ characters, e.g. `four-random-words-2026`. Only you know it. |
   | `GEMINI_API_KEY` | Free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
   | `GROQ_API_KEY` | *(optional)* free fallback key from [console.groq.com/keys](https://console.groq.com/keys) |

   Optional overrides: `GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_SEARCH_MODEL` (default `gemini-2.5-flash`; its free tier includes Google Search, which the number finder uses), `GROQ_MODEL`.
4. Back in the editor, choose the `setup` function and click **Run**. Approve the permissions (Drive, Sheets, external requests). The log shows the Drive folder it created.
5. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the `/exec` URL.

> "Anyone" only means the URL is reachable. Every request is checked against a signed-in session, and settings actions are checked against your elevated session.

## 2. Frontend (Netlify)

1. The code lives at [github.com/kensaraworks/KensaraAI-Sales-CRM](https://github.com/kensaraworks/KensaraAI-Sales-CRM).
2. Netlify → **Add new site → Import from Git** → pick `kensaraworks/KensaraAI-Sales-CRM`. Leave the build settings as they are (they come from `netlify.toml`).
3. In [`netlify.toml`](netlify.toml) replace `VITE_ENDPOINT = "mock"` with your `/exec` URL, then commit and push. (Set it in this file, not in the Netlify dashboard: the file wins. While it says `mock`, the site is a demo with sample data.)
4. Deploy. Every team member then uses the same site URL. On phones, choose *Add to Home Screen* and it behaves like an app.

## 3. First sign-in (you)

Open the site and sign in with **your name** and your **`ADMIN_KEY`** in the PIN box. This creates your account, and the **Settings** item appears in the menu. Nobody else ever sees it.

In **Settings**:
- **Team**: add each person. A 6-digit PIN is created and shown once; share it with them. Tick the stages each person works (e.g. Asha: New + Intro; Ravi: Shared + Warm; Neha: Discovery). Leads route automatically.
- **Targets**: switch each target on or off and set values; per-person overrides are under Team.
- **Workflow**: pacing limit, reminder delay, follow-up cadence, working hours, lunch and holidays.
- **Messaging & AI**: what you sell (the AI uses it), deck, website and booking links, signature.
- **Security → Lock to this device**: after that, Settings opens only on this device, even with the passphrase. If you lose the device, delete the `ADMIN_DEVICE` script property.

Team members sign in once per device with their name and PIN and stay signed in (180 days).

## 4. Day to day

- **Ctrl+S** (you only, anywhere in the app) saves a checkpoint quietly. It is a full copy of the data, and it also locks in everything so far, so nobody can undo past it. A checkpoint is also taken every night at 11 PM. Restore from Settings → Checkpoints.
- **Delete forever**: the ⋯ menu on a lead, the trash icon on a timeline entry, or Settings → Removed. This also erases the record's edit history. Team members can only *remove* (hide) things, which you can restore.
- **Sign-ins**: Settings → Sign-ins shows who signed in or opened the app, when, and on which device.
- **The spreadsheet** holds `Audit` (every change: who, when, before and after), `Sign-ins`, and a read-only `Leads` view refreshed nightly.

## Updating the backend

Paste the new `Code.gs`, then go to **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same.

## Free-tier limits (comfortable for a team of up to about 10)

| Service | Limit | What it means here |
|---|---|---|
| Apps Script | 20,000 URL fetches/day, 6 min per request | Each person syncs every 20 seconds while the app is open, which is fine |
| Gemini free | Per-minute and daily caps per model | The app caps each person at 20 AI calls/minute and 800/day; the number finder runs one company every ~5 seconds |
| Google Search grounding | ~500 searches/day free (2.5 Flash) | About 500 "find number" lookups per day |
| Drive | 15 GB | Years of activity |

If AI is unavailable, everything still works: voice notes are parsed by built-in English and Hinglish rules, and messages come from templates.
