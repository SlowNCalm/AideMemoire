// Stripe subscription billing via the REST API (no SDK needed).
// Env: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, APP_URL.
// Until configured, billing endpoints explain what's missing instead of failing.
import crypto from "crypto";
import { Users } from "./db.js";

const KEY = () => process.env.STRIPE_SECRET_KEY;
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
export const billingConfigured = () => !!(KEY() && process.env.STRIPE_PRICE_ID && APP_URL);

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
export const trialEndISO = () => new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString().slice(0, 10);

export function planStatus(user) {
  if (user.plan === "active") return { plan: "active" };
  const ends = user.trial_ends || "2099-01-01";
  const daysLeft = Math.ceil((new Date(ends + "T00:00:00Z") - Date.now()) / 86400000);
  return { plan: daysLeft > 0 ? "trial" : "expired", trial_days_left: Math.max(0, daysLeft), billing_available: billingConfigured() };
}

async function stripe(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `stripe ${path} ${res.status}`);
  return data;
}

async function ensureCustomer(user) {
  if (user.stripe_customer) return user.stripe_customer;
  const c = await stripe("customers", { email: user.email, "metadata[user_id]": user.id });
  Users.setStripeCustomer(user.id, c.id);
  return c.id;
}

export async function createCheckout(user) {
  const customer = await ensureCustomer(user);
  const session = await stripe("checkout/sessions", {
    mode: "subscription",
    customer,
    "line_items[0][price]": process.env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${APP_URL}/?billing=success`,
    cancel_url: `${APP_URL}/?billing=cancelled`,
    allow_promotion_codes: "true",
  });
  return session.url;
}

export async function createPortal(user) {
  const customer = await ensureCustomer(user);
  const session = await stripe("billing_portal/sessions", { customer, return_url: `${APP_URL}/` });
  return session.url;
}

// Stripe webhook signature: header "stripe-signature: t=...,v1=..."
// v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
export function verifyWebhook(rawBody, sigHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return null;
  const parts = Object.fromEntries(String(sigHeader || "").split(",").map((p) => p.split("=")));
  if (!parts.t || !parts.v1) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) return null;
  } catch { return null; }
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return null; // 10-min tolerance
  try { return JSON.parse(rawBody); } catch { return null; }
}

export function handleWebhookEvent(event) {
  const type = event.type || "";
  const obj = event.data?.object || {};
  const customer = obj.customer;
  if (!customer) return;
  const user = Users.byStripeCustomer(customer);
  if (!user) { console.warn("[billing] webhook for unknown customer", customer); return; }

  if (type === "checkout.session.completed" ||
      (type === "customer.subscription.updated" && ["active", "trialing"].includes(obj.status)) ||
      (type === "customer.subscription.created" && ["active", "trialing"].includes(obj.status))) {
    Users.setPlan(user.id, "active");
    console.log(`[billing] ${user.email} → active`);
  }
  if (type === "customer.subscription.deleted" ||
      (type === "customer.subscription.updated" && ["canceled", "unpaid", "incomplete_expired"].includes(obj.status))) {
    Users.setPlan(user.id, "canceled");
    console.log(`[billing] ${user.email} → canceled`);
  }
}
