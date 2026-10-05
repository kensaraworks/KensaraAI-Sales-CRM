# Kensara Sales — CRM

A lightweight, free-to-run sales CRM for KensaraAI's enterprise B2B outreach: cold intro calls, referrals across the org chart, sharing details, reminder calls, follow-up cadences, discovery calls, and gap assessments.

```bash
npm install
npm run dev     # demo mode with sample data, in the browser only
```

Open http://localhost:5173 and sign in as **Asha** (caller), **Ravi** (shares details) or **Neha** (discovery), PIN `1234`. The demo admin passphrase is `kensara-admin`. Demo data stays in your browser; run `localStorage.clear()` in the console to reset it.

Going live takes about 20 minutes, all on free tiers. See **[SETUP.md](SETUP.md)**.

## What it does

| | |
|---|---|
| **Today** | A prioritised queue per person: promised callbacks first, then "details requested", reminder calls, overdue follow-ups, then fresh leads. Each item says *why* it's there. Target rings, points, levels and streaks. |
| **Focus mode** (`F`) | One lead at a time in the best order. Call, log the outcome in one tap or by voice, and the next lead slides in. |
| **Log by voice** | "Reception said call Mr. Rao, CFO, 98201 23456, kal 11 baje" becomes *Referred*, a new contact, and a call tomorrow at 11 AM. English, Hindi and Hinglish; works offline with rules, better with AI. |
| **Smart scheduling** | Learns when people pick up (by weekday and hour) from every call the team makes, avoids lunch, evenings, Sundays and holidays, and spreads follow-ups so nobody's day is stacked. |
| **Cadence** | After details are shared: follow-ups at widening gaps (2, 3, 3, 4, 7, 7, 14, 21 days), alternating call, WhatsApp and email, each with a fresh angle, ending with a polite "shall I close your file?", then monthly until a clear yes or no. |
| **Pacing** | Fresh-lead outreach slows as overdue follow-ups build up and pauses at a limit you set, so warm leads never go cold. |
| **Hand-offs** | Stages are allocated to people. When a caller logs "pitched, send details", the lead moves to whoever shares details; after sending, a reminder call is scheduled for them automatically. |
| **People and referrals** | Every company keeps its chain of who referred whom, decision makers, gatekeepers and wrong numbers, so nobody asks the same receptionist twice. |
| **Messages** | WhatsApp and email drafts for every stage, personalised from the lead's history, in a warm, formal or crisp tone and in English, Hinglish or Hindi. One tap opens WhatsApp or your mail app; no mailbox connection needed. |
| **Import** | Any Excel or CSV layout. Columns are recognised from headers and values (or by AI), multiple contacts per company are grouped, duplicates are merged, and missing phone numbers can be found through AI web search (you approve each) or a Google link. |
| **Trail and undo** | Every change records who and when (Edit trail on each lead, plus the `Audit` sheet). Everyone can undo (`Ctrl+Z`). Two people opening the same lead see "Asha is on it". |
| **Insights** | Daily, weekly and all-time figures: calls, conversations, connect rate, decision makers, shares, discovery calls, wins, the funnel, best time to call, leaderboard, follow-up discipline and why deals closed. |
| **Admin (hidden)** | Visible only in your elevated session: team and PINs, stage allocation, targets on/off, cadence, hours, holidays, sign-in log, device lock, checkpoints (`Ctrl+S`), restore, permanent delete. The admin screens are a separate code chunk that loads only for you. |

## Layout

| Path | What |
|---|---|
| `src/lib/workflow.ts` | What each outcome does: stage, warmth, next step and when |
| `src/lib/outcomes.ts` | The outcome catalogue (no answer, referred, pitched, and so on) |
| `src/lib/schedule.ts` | Working hours, pick-up model, best-slot finder, daily queue, pacing |
| `src/lib/timeparse.ts` | "kal saade 4", "after Diwali", "Thu after lunch" |
| `src/lib/ai.ts` | Voice-note parsing, messages, briefs, column mapping, number finding (each with a fallback) |
| `src/lib/importer.ts` | Schema-free spreadsheet import and duplicate detection |
| `src/lib/store.ts` | Offline-first sync, outbox, undo |
| `src/lib/mock.ts` | In-browser backend for demo mode (mirrors `apps-script/Code.gs`) |
| `src/ui/` | Screens |
| `src/ops/` | Admin screens (lazy-loaded) |
| `apps-script/Code.gs` | The backend |

## Keyboard

`1`–`5` switch screens · `F` focus mode · `N` new lead · `/` or `Ctrl+K` search · `L` log and `M` message (on an open lead) · `1`–`9` pick an outcome · `Ctrl+Enter` save · `Ctrl+Z` undo
