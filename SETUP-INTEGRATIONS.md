# Integration Setup Guide (the parts only you can do)

Everything below is optional and independent — the app runs fine while any of it is unconfigured. Each section ends with the exact Render environment variables to add.

## 0. First, one variable everything shares
- `APP_URL` = your site's full URL, e.g. `https://aidedememoire.onrender.com` (no trailing slash). Required by calendars and billing for redirects.

## 1. Stripe billing (~20 min)
1. Create an account at stripe.com. Stay in **Test mode** (toggle, top right) until everything works.
2. **Product catalog → Add product**: name "Aide-Mémoire Individual", recurring price $19/month. Copy the **price ID** (`price_...`).
3. **Developers → API keys**: copy the **Secret key** (`sk_test_...` in test mode).
4. **Developers → Webhooks → Add endpoint**: URL = `{APP_URL}/api/stripe/webhook`. Select events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.created`. Copy the **Signing secret** (`whsec_...`).
5. Render env vars: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`.
6. Test: sign up with a fresh account → Upgrade button → pay with card `4242 4242 4242 4242`, any future date/CVC → you should land back on the app with "subscription active" and the trial banner gone.
7. When ready for real money: flip Stripe to Live mode, repeat steps 2–4 there (live keys are different), replace the three env vars.

Notes: signups get a 14-day trial; when it lapses, adding is paused (data stays). The FIRST account ever created is permanently free (that's you).

## 2. Google Calendar (~20 min)
1. console.cloud.google.com → create a project ("Aide-Memoire").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: External, fill app name + your email, add scope `.../auth/calendar.readonly`, add yourself as a test user. (In "Testing" mode only listed test users can connect — fine for beta. "Publish" later for the public.)
4. **Credentials → Create credentials → OAuth client ID**: type Web application. Authorized redirect URI = `{APP_URL}/api/calendar/callback/google` (exact).
5. Render env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
6. Test: Settings → "+ Google Calendar" → Google consent → back with "Calendar connected". Add an entry on a day you have a meeting; Jarvis should name the collision.

## 3. Outlook / Microsoft (~20 min)
1. portal.azure.com → **Microsoft Entra ID → App registrations → New registration**. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts". Redirect URI (Web) = `{APP_URL}/api/calendar/callback/microsoft`.
2. **API permissions → Add** → Microsoft Graph → Delegated → `Calendars.Read`, `User.Read`, `offline_access`.
3. **Certificates & secrets → New client secret** → copy the **Value** immediately (shown once).
4. Render env vars: `MS_CLIENT_ID` (= Application/client ID from Overview), `MS_CLIENT_SECRET` (= the secret Value).

## 4. Nothing to set up
- **PWA**: already live — on a phone, the browser will offer "Add to Home Screen"; it installs like an app with the gold icon.
- **CSV import**: Settings → Import. Columns: name, date, occasion, relationship, notes.
- **Relationship-health nudges**: automatic in the morning briefing.
