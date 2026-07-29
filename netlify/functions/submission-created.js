/**
 * submission-created.js
 * Netlify event-triggered function — fires on every verified form submission.
 * Forwards tracked form leads (consult, consult-relief, home-valuation) to
 * Follow Up Boss via /v1/events. Tag set is determined by form name.
 *
 * Also reports the conversion to Meta's Conversions API, server-side. That is
 * now the primary ad signal: it does not depend on a consent click, an ad
 * blocker, or Safari's tracking prevention, and every one of these submissions
 * is a real person who just handed over their name, phone and email to be
 * contacted. The browser pixel still fires where consent allows, carrying the
 * same event_id, so Meta collapses the pair into one conversion.
 *
 * Required env vars (set in Netlify UI → Site → Environment variables):
 *   FUB_API_KEY      — your Follow Up Boss API key
 *   FUB_X_SYSTEM     — your system name registered with FUB
 *   FUB_X_SYSTEM_KEY — your system key registered with FUB
 *   META_CAPI_TOKEN  — Meta system-user access token (Events Manager →
 *                      Settings → Conversions API → Generate access token).
 *                      Absent, the CAPI call is skipped and FUB is unaffected.
 *   META_TEST_CODE   — optional. Set while validating in Events Manager →
 *                      Test Events, then remove so real traffic is not tagged.
 */

import crypto from "node:crypto";

const FUB_EVENTS_URL = "https://api.followupboss.com/v1/events";

const META_PIXEL_ID = "1533514048115355";
const META_API_VER  = "v21.0";

// Base tags per form. Forms not listed here are ignored by this handler.
// Consult forms get UNIVERSAL_TAGS + MAILER_TAGS based on referrer URL.
// Valuation forms get a fixed tag set (no mailer overlay).
const UNIVERSAL_TAGS = [
  "Seller",
  "Seller Inquiry",
  "16 Day Prep Campaign",
];

// NOTE: a form missing from this map is silently ignored by the handler, so its
// leads reach Netlify but never Follow Up Boss. "consult-v2" was missing while
// all-done2.html was live and submitting under that name.
const FORM_TAGS = {
  "consult":         UNIVERSAL_TAGS,
  "consult-relief":  UNIVERSAL_TAGS,
  "consult-v2":      UNIVERSAL_TAGS,
  "home-valuation":  [...UNIVERSAL_TAGS, "all-done", "valuation", "no_outreach"],
};

// Forms that should additionally apply MAILER_TAGS based on referrer URL.
const FORMS_WITH_MAILER_TAGS = new Set(["consult", "consult-relief", "consult-v2"]);

// Add new mailers here as you create them — one line per mailer
// IMPORTANT: More-specific paths must be listed BEFORE less-specific ones
// because getMailerTag() does first-substring-match. e.g. "/all-done2" must
// come before "/all-done" or "/all-done2" submissions would match "/all-done".
const MAILER_TAGS = {
  "/prep-plan":        "16 Day Prep Mailer 02",
  "/gbp":              "GBP",
  "/campbell":         "CampbellPrepCTA",
  "/listingprep":      "Case Study",
  "/prettylistings-b": ["Pretty Listings B", "Meta Ad"],
  "/prettylistings":   ["Pretty Listings", "Meta Ad"],
  "/all-done2":        ["16 Day Prep System", "Relief", "All-Done v2", "Meta Ad"],
  "/all-done":         ["16 Day Prep System", "Relief", "All-Done", "Meta Ad"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
    return { firstName: "", lastName: "" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function normalizePhone(phone = "") {
  return phone.replace(/\D/g, "");
}

function getMailerTag(pageUrl) {
  const match = Object.entries(MAILER_TAGS).find(([path]) => pageUrl.includes(path));
  if (!match) return [];
  return Array.isArray(match[1]) ? match[1] : [match[1]];
}

function buildFubPayload(formData, formName, tags) {
  const { name = "", email = "", phone = "", address = "", preferred_date = "", timeline = "", situation = "", notes = "", contact_method = "" } = formData;
  const { firstName, lastName } = splitName(name);

  let message;
  if (formName === "home-valuation") {
    const parts = ["Home valuation walkthrough requested from website."];
    if (address)        parts.push(`Property address: ${address}.`);
    if (preferred_date) parts.push(`Preferred date: ${preferred_date}.`);
    if (notes)          parts.push(`Notes: ${notes}`);
    message = parts.join(" ");
  } else {
    const parts = ["Seller form submitted from website."];
    if (address)        parts.push(`Property address: ${address}.`);
    if (contact_method) parts.push(`Preferred contact: ${contact_method}.`);
    if (timeline)       parts.push(`Timeline: ${timeline}.`);
    if (situation)      parts.push(`Home condition: ${situation}.`);
    if (notes)          parts.push(`Notes: ${notes}`);
    message = parts.join(" ");
  }

  const person = { firstName, lastName, tags };

  if (email)   person.emails    = [{ value: email }];
  if (phone)   person.phones    = [{ value: phone }];
  // Contact-level address (shows in the person's Addresses field).
  if (address) person.addresses = [{ type: "home", street: address }];

  const payload = {
    source:  "LarryChou.com",
    system:  "Netlify",
    type:    "Seller Inquiry",
    message,
    person,
  };

  // Inquiry property (the home this seller lead is about). Populates the
  // structured property fields in FUB instead of leaving the address in the note.
  if (address) payload.property = { street: address };

  return payload;
}

async function sendToFub(payload) {
  const apiKey      = process.env.FUB_API_KEY;
  const xSystem     = process.env.FUB_X_SYSTEM;
  const xSystemKey  = process.env.FUB_X_SYSTEM_KEY;

  if (!apiKey)     throw new Error("FUB_API_KEY environment variable is not set.");
  if (!xSystem)    throw new Error("FUB_X_SYSTEM environment variable is not set.");
  if (!xSystemKey) throw new Error("FUB_X_SYSTEM_KEY environment variable is not set.");

  const credentials = Buffer.from(`${apiKey}:`).toString("base64");

  const response = await fetch(FUB_EVENTS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type":  "application/json",
      "X-System":      xSystem,
      "X-System-Key":  xSystemKey,
    },
    body: JSON.stringify(payload),
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => "(empty response)");
  }

  return { ok: response.ok, status: response.status, body };
}

// ---------------------------------------------------------------------------
// Meta Conversions API
// ---------------------------------------------------------------------------

/* Meta requires the identifying fields be SHA-256 of a normalised value:
   trimmed, lowercased, punctuation stripped from phone numbers. Hashing an
   un-normalised string produces a valid-looking hash that never matches, which
   fails silently as "poor match quality" rather than an error. */
function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function hashed(value) {
  if (!value) return undefined;
  const v = String(value).trim().toLowerCase();
  return v ? sha256(v) : undefined;
}
function hashedPhone(phone) {
  if (!phone) return undefined;
  // E.164 without the plus. Bare 10-digit US numbers get a country code, or
  // they will not match a US audience.
  let d = String(phone).replace(/\D/g, "");
  if (!d) return undefined;
  if (d.length === 10) d = "1" + d;
  return sha256(d);
}

function buildCapiPayload(formData, pageUrl) {
  const { name = "", email = "", phone = "", event_id = "" } = formData;
  const parts = String(name).trim().split(/\s+/).filter(Boolean);

  const user_data = {
    em: hashed(email),
    ph: hashedPhone(phone),
    fn: hashed(parts[0]),
    ln: hashed(parts.length > 1 ? parts.slice(1).join(" ") : ""),
    country: sha256("us"),
    // Netlify puts the submitter's ip and user agent in the submission data.
    // They are sent unhashed; Meta expects these two in the clear.
    client_ip_address: formData.ip || undefined,
    client_user_agent: formData.user_agent || undefined,
  };
  Object.keys(user_data).forEach((k) => user_data[k] === undefined && delete user_data[k]);

  return {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        // Shared with the browser pixel so the two deduplicate. Absent, Meta
        // treats the server copy as its own conversion, which double-counts
        // anyone who also had the pixel running.
        event_id: event_id || undefined,
        action_source: "website",
        event_source_url: pageUrl || undefined,
        user_data,
      },
    ],
  };
}

async function sendToMeta(payload) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { skipped: "META_CAPI_TOKEN not set" };

  const body = { ...payload, access_token: token };
  if (process.env.META_TEST_CODE) body.test_event_code = process.env.META_TEST_CODE;

  const res = await fetch(
    `https://graph.facebook.com/${META_API_VER}/${META_PIXEL_ID}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  let out;
  try { out = await res.json(); } catch { out = await res.text().catch(() => "(empty)"); }
  return { ok: res.ok, status: res.status, body: out };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] submission-created triggered`);

  // ── 1. Parse the Netlify event payload ──────────────────────────────────
  let netlifyPayload;
  try {
    netlifyPayload = JSON.parse(event.body);
  } catch (err) {
    console.error(`[${timestamp}] Failed to parse event body:`, err.message);
    return { statusCode: 400, body: "Bad event payload" };
  }

  // ── 2. Check form name ───────────────────────────────────────────────────
  const formName =
    netlifyPayload?.payload?.data?.["form-name"] ||
    netlifyPayload?.data?.["form-name"] ||
    netlifyPayload?.payload?.form_name ||
    netlifyPayload?.form_name ||
    "";

  console.log(`[${timestamp}] Form name: "${formName}"`);

  if (!Object.prototype.hasOwnProperty.call(FORM_TAGS, formName)) {
    console.log(`[${timestamp}] Ignoring submission from unrelated form: "${formName}"`);
    return { statusCode: 200, body: "Ignored — not a tracked form" };
  }

  // ── 3. Extract form fields ───────────────────────────────────────────────
  const formData = netlifyPayload?.payload?.data ?? netlifyPayload?.data ?? {};
  const { name, email, phone, address } = formData;

  // ── 4. Build tag list: base tags per form + mailer tags + behavior flags ─
  const pageUrl    = netlifyPayload?.payload?.data?.referrer || netlifyPayload?.data?.referrer || "";
  const mailerTags = FORMS_WITH_MAILER_TAGS.has(formName) ? getMailerTag(pageUrl) : [];
  const behaviorTags = [];
  if (formData.custom_timeline === "yes") behaviorTags.push("custom_timeline");
  const tags = [...FORM_TAGS[formName], ...mailerTags, ...behaviorTags];

  console.log(`[${timestamp}] Submission received:`, {
    form:    formName,
    name:    name    || "(missing)",
    email:   email   || "(missing)",
    phone:   phone   ? `****${normalizePhone(phone).slice(-4)}` : "(missing)",
    address: address || "(missing)",
    tags:    tags.join(", "),
  });

  // ── 5. Basic validation ──────────────────────────────────────────────────
  if (!name && !email && !phone) {
    console.warn(`[${timestamp}] Submission appears empty — skipping FUB call`);
    return { statusCode: 200, body: "Skipped — no usable contact data" };
  }

  // ── 5b. Meta Conversions API ────────────────────────────────────────────
  // Before FUB and in its own try, because the two are independent: a Meta
  // outage or a bad token must never cost the lead its CRM record.
  try {
    const capi = await sendToMeta(buildCapiPayload(formData, pageUrl));
    if (capi.skipped) {
      console.warn(`[${timestamp}] Meta CAPI skipped — ${capi.skipped}`);
    } else if (capi.ok) {
      console.log(`[${timestamp}] Meta CAPI accepted Lead. event_id=${formData.event_id || "(none)"} received=${capi.body?.events_received}`);
    } else {
      console.error(`[${timestamp}] Meta CAPI rejected. status=${capi.status} body=`, JSON.stringify(capi.body));
    }
  } catch (err) {
    console.error(`[${timestamp}] Meta CAPI threw:`, err.message);
  }

  // ── 6. Build and send FUB payload ───────────────────────────────────────
  let fubPayload;
  try {
    fubPayload = buildFubPayload(formData, formName, tags);
    console.log(`[${timestamp}] Sending to Follow Up Boss:`, {
      ...fubPayload,
      person: {
        ...fubPayload.person,
        emails: fubPayload.person.emails ? ["[redacted]"] : undefined,
        phones: fubPayload.person.phones ? ["[redacted]"] : undefined,
      },
    });
  } catch (err) {
    console.error(`[${timestamp}] Failed to build FUB payload:`, err.message);
    return { statusCode: 500, body: "Internal error building payload" };
  }

  let result;
  try {
    result = await sendToFub(fubPayload);
  } catch (err) {
    console.error(`[${timestamp}] FUB request threw an exception:`, err.message);
    return { statusCode: 200, body: "FUB send failed (logged)" };
  }

  // ── 7. Log result ────────────────────────────────────────────────────────
  if (result.ok) {
    const fubId = result.body?.id || result.body?.eventId || "(no id returned)";
    console.log(`[${timestamp}] ✅ FUB accepted submission. status=${result.status} id=${fubId} tags=${fubPayload.person.tags.join(", ")}`);
  } else {
    console.error(`[${timestamp}] ❌ FUB rejected submission. status=${result.status} body=`, JSON.stringify(result.body));
  }

  return { statusCode: 200, body: "OK" };
};
