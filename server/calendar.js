// Google Calendar + Outlook (Microsoft Graph) integration.
// Requires (per provider) env vars — the endpoints return helpful errors until set:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   MS_CLIENT_ID / MS_CLIENT_SECRET
//   APP_URL (e.g. https://aidedememoire.onrender.com)
import crypto from "crypto";
import { Calendars } from "./db.js";

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SECRET = process.env.APP_SECRET || "dev-secret";

export const providers = {
  google: {
    configured: () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && APP_URL),
    authUrl: (state) =>
      "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${APP_URL}/api/calendar/callback/google`,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar.readonly openid email",
        access_type: "offline",
        prompt: "consent",
        state,
      }),
    tokenUrl: "https://oauth2.googleapis.com/token",
    tokenBody: (code) => ({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${APP_URL}/api/calendar/callback/google`,
      grant_type: "authorization_code",
    }),
    refreshBody: (refreshToken) => ({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
    async events(accessToken, dayISO) {
      const timeMin = `${dayISO}T00:00:00Z`, timeMax = `${dayISO}T23:59:59Z`;
      const res = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
        new URLSearchParams({ timeMin, timeMax, singleEvents: "true", maxResults: "20" }),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) throw Object.assign(new Error("google events " + res.status), { status: res.status });
      const data = await res.json();
      return (data.items || [])
        .filter((e) => e.status !== "cancelled")
        .map((e) => ({ name: e.summary || "Busy", source: "Google Calendar" }));
    },
  },
  microsoft: {
    configured: () => !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && APP_URL),
    authUrl: (state) =>
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        redirect_uri: `${APP_URL}/api/calendar/callback/microsoft`,
        response_type: "code",
        scope: "offline_access Calendars.Read User.Read",
        state,
      }),
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    tokenBody: (code) => ({
      code,
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      redirect_uri: `${APP_URL}/api/calendar/callback/microsoft`,
      grant_type: "authorization_code",
    }),
    refreshBody: (refreshToken) => ({
      refresh_token: refreshToken,
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "refresh_token",
      scope: "offline_access Calendars.Read User.Read",
    }),
    async events(accessToken, dayISO) {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${dayISO}T00:00:00&endDateTime=${dayISO}T23:59:59&$top=20&$select=subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) throw Object.assign(new Error("graph events " + res.status), { status: res.status });
      const data = await res.json();
      return (data.value || []).map((e) => ({ name: e.subject || "Busy", source: "Outlook" }));
    },
  },
};

// signed state so the unauthenticated callback can't be forged
export const signState = (userId) => {
  const sig = crypto.createHmac("sha256", SECRET).update(userId).digest("hex").slice(0, 24);
  return `${userId}.${sig}`;
};
export const verifyState = (state) => {
  const [userId, sig] = String(state || "").split(".");
  if (!userId || signState(userId) !== `${userId}.${sig}`) return null;
  return userId;
};

export async function exchangeCode(provider, code) {
  const p = providers[provider];
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(p.tokenBody(code)),
  });
  if (!res.ok) { console.error(`[calendar] ${provider} token exchange failed:`, res.status, await res.text()); return null; }
  return res.json(); // { access_token, refresh_token?, expires_in }
}

async function freshToken(account) {
  if (Date.now() < account.expires_at - 60000) return account.access_token;
  if (!account.refresh_token) return account.access_token; // hope for the best
  const p = providers[account.provider];
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(p.refreshBody(account.refresh_token)),
  });
  if (!res.ok) { console.error(`[calendar] ${account.provider} refresh failed:`, res.status); return account.access_token; }
  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  Calendars.updateTokens(account.id, data.access_token, expiresAt);
  return data.access_token;
}

// External events on a given day, across every calendar the user connected.
// Fail-soft: a broken calendar never blocks saving an entry.
export async function externalEventsOn(userId, dayISO) {
  const out = [];
  for (const acct of Calendars.forUser(userId)) {
    try {
      const token = await freshToken(acct);
      const events = await providers[acct.provider].events(token, dayISO);
      out.push(...events);
    } catch (e) {
      console.error(`[calendar] ${acct.provider} fetch failed for ${dayISO}:`, e.message);
    }
  }
  return out.slice(0, 10);
}
