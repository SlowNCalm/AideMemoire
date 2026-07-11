# Aide-Mémoire

A private remembrancer. Speak a date once — a birthday, an anniversary, a board dinner — and it's kept on the server and **emailed to you before it arrives, even when the site is closed.**

## What's inside

- **Voice capture** — tap the gold orb and say *"My mother's birthday is March 12th — remind me two weeks before to order white orchids."* The app parses the name, occasion, date, lead time, and the to-do, then shows a confirmation card before saving. A hands-free toggle keeps the mic open continuously.
- **Real reminders** — a daily server-side sweep (default 8:00 AM) emails you a digest of everything inside its reminder window, via [Resend](https://resend.com). Each occurrence is emailed exactly once.
- **Private access** — the whole site sits behind an access code you choose, so it can be on the public internet without your dates being public.
- **Manual entry, editing, yearly recurrence, per-date lead times** (day-of up to a month before), and a "Send test email" button.

## Architecture

```
client/   React (Vite) — dark, understated UI; Web Speech API for voice; chrono-node for date parsing
server/   Express + SQLite — entries API, HMAC session auth, node-cron daily sweep, Resend email
```

One Render web service runs both: Express serves the built frontend and the API.

## v6: The product

- **Accounts**: email + password signup; each user's ledger is private and reminders go to their own email. Optional `INVITE_CODE` env var gates signups during beta. The first account created adopts any dates saved under the old single-user version.
- **Calendar view**: month grid with every commitment placed on its day; ⚠ marks days carrying multiple commitments; navigable by button or by voice ("show me November", "back to the ledger").
- **Conversational assistant**: with `ANTHROPIC_API_KEY` set, every utterance is understood in context of your ledger — add dates, ask questions ("what's coming up this month?", "when is my mother's birthday?"), delete by voice ("remove James's dinner"), or switch views.
- **Conflict detection**: adding or editing a date that lands on (or adjacent to) an existing commitment triggers a spoken warning and a flag, like a real EA would.

## Deploy to Render (~10 minutes)

1. **Push this folder to a GitHub repo** (private is fine).
2. **Get a Resend API key** — sign up at resend.com (free tier: 100 emails/day, far more than you'll need). While testing, the default `onboarding@resend.dev` sender can email **only the address you signed up with**. To send from your own domain later, verify the domain in Resend and change `REMINDER_EMAIL_FROM`.
3. **Create the service** — in Render, choose **New → Blueprint** and point it at your repo; `render.yaml` configures everything. When prompted, fill in:
   - `ACCESS_CODE` — the login code for the site
   - `RESEND_API_KEY` — from step 2
   - `REMINDER_EMAIL_TO` — where reminders should go
   - `TIMEZONE` — e.g. `America/Toronto` (controls what "8 AM" and "today" mean)
4. Deploy. Open the URL, enter your access code, tap the orb, and speak.
5. **Verify email works**: add a date within its reminder window, press **Send test email**, check your inbox.

### Cost — the honest part

Reliable reminders require the server to be **awake** at reminder time. Render's free tier spins idle services down, so the internal cron would sleep through your 8 AM sweep, and the free tier has no persistent disk — your data would vanish on every redeploy. The blueprint therefore uses the **Starter instance (~$7/mo) + a 1 GB disk (~$0.25/mo)**. That's the real price of "reminds me even when the site is closed."

*Free-tier workaround (not recommended as primary):* the server also exposes `POST /api/reminders/run?key=<CRON_SECRET>`, so an external free scheduler like cron-job.org can wake the service daily and trigger the sweep. That solves the sleeping-cron problem but **not** the data-loss-on-redeploy problem, so only use it alongside a persistent disk or an external database.

## Local development

```bash
npm install          # server deps (also installs client deps via postinstall)
npm run build        # builds the frontend into client/dist
ACCESS_CODE=test REMINDER_EMAIL_TO=you@example.com RESEND_API_KEY=re_xxx npm start
# → http://localhost:3000
```

For live-reload frontend work: `npm start` in one terminal, `cd client && npm run dev` in another (Vite proxies `/api` to :3000).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ACCESS_CODE` | yes | Login code for the site. If unset, the site is open to anyone — don't do that in production. |
| `RESEND_API_KEY` | yes | Resend API key for sending email. |
| `ANTHROPIC_API_KEY` | strongly recommended | Enables AI understanding of spoken requests (from console.anthropic.com). Without it, voice falls back to basic pattern matching. |
| `PARSE_MODEL` | no | Anthropic model for parsing. Default `claude-haiku-4-5-20251001`. |
| `REMINDER_EMAIL_TO` | yes | Where reminder emails go. |
| `REMINDER_EMAIL_FROM` | no | Sender. Default `Aide-Mémoire <onboarding@resend.dev>` (works only to your own Resend account email until you verify a domain). |
| `TIMEZONE` | no | IANA timezone for "today" and the cron hour. Default `America/Toronto`. |
| `CRON_EXPR` | no | Sweep schedule. Default `0 8 * * *` (8:00 AM daily). |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | no | Set all three (from twilio.com) to also send reminders by SMS to users who add a phone number in Settings. |
| `CRON_SECRET` | no | Key for the external `/api/reminders/run` trigger. |
| `APP_SECRET` | no | Signs session tokens. Set it so logins survive server restarts. |
| `DATA_DIR` | no | Where the SQLite file lives. `/var/data` on Render. |

## Known limits (by design, worth knowing)

- **Voice recognition** uses the browser's built-in Web Speech API — excellent in Chrome/Edge/Safari, unavailable in Firefox (manual entry still works). It needs mic permission, which the browser will request on first tap.
- **Voice parsing is heuristic.** It's good at the pattern *who + occasion + date + "remind me X before" + "to do Y"*, and everything lands in a confirmation card you can correct before saving — nothing is stored blind.
- **Single account.** One access code, one reminder inbox. Multi-user support would need real accounts — say the word if you want that next.
- **Email, not SMS.** Adding Twilio SMS is a ~30-line change in `server/reminders.js` if you want texts too.
