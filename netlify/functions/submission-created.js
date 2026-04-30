/**
 * submission-created.js
 * Netlify event-triggered function — fires on every verified form submission.
 * Forwards "consult" form leads to Follow Up Boss via /v1/events.
 *
 * Required env vars (set in Netlify UI → Site → Environment variables):
 *   FUB_API_KEY      — your Follow Up Boss API key
 *   FUB_X_SYSTEM     — your system name registered with FUB
 *   FUB_X_SYSTEM_KEY — your system key registered with FUB
 */

const FUB_EVENTS_URL = "https://api.followupboss.com/v1/events";

// Tags applied to every consult submission regardless of source
const UNIVERSAL_TAGS = [
  "Seller",
  "Seller Inquiry",
  "16 Day Prep Campaign",
];

// Add new mailers here as you create them — one line per mailer
const MAILER_TAGS = {
  "/prep-plan":   "16 Day Prep Mailer 02",
  "/gbp":         "GBP",
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
  return match ? match[1] : "";
}

function buildFubPayload(formData, mailerTag) {
  const { name = "", email = "", phone = "", address = "" } = formData;
  const { firstName, lastName } = splitName(name);

  const message = address
    ? `Seller form submitted from website. Property address: ${address}`
    : "Seller form submitted from website.";

  const tags = [...UNIVERSAL_TAGS];
  if (mailerTag) {
    tags.push(mailerTag);
  }

  const person = { firstName, lastName, tags };

  if (email)   person.emails         = [{ value: email }];
  if (phone)   person.phones         = [{ value: phone }];
  if (address) person.propertyStreet = address;

  return {
    source:  "LarryChou.com",
    system:  "Netlify",
    type:    "Seller Inquiry",
    message,
    person,
  };
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

  if (formName !== "consult") {
    console.log(`[${timestamp}] Ignoring submission from unrelated form: "${formName}"`);
    return { statusCode: 200, body: "Ignored — not the consult form" };
  }

  // ── 3. Extract form fields ───────────────────────────────────────────────
  const formData = netlifyPayload?.payload?.data ?? netlifyPayload?.data ?? {};
  const { name, email, phone, address } = formData;

  // ── 4. Detect which page the submission came from ────────────────────────
  const pageUrl   = netlifyPayload?.payload?.data?.referrer || netlifyPayload?.data?.referrer || "";
  const mailerTag = getMailerTag(pageUrl);

  console.log(`[${timestamp}] Submission received:`, {
    name:    name    || "(missing)",
    email:   email   || "(missing)",
    phone:   phone   ? `****${normalizePhone(phone).slice(-4)}` : "(missing)",
    address: address || "(missing)",
    mailer:  mailerTag || "(none — root page)",
  });

  // ── 5. Basic validation ──────────────────────────────────────────────────
  if (!name && !email && !phone) {
    console.warn(`[${timestamp}] Submission appears empty — skipping FUB call`);
    return { statusCode: 200, body: "Skipped — no usable contact data" };
  }

  // ── 6. Build and send FUB payload ───────────────────────────────────────
  let fubPayload;
  try {
    fubPayload = buildFubPayload(formData, mailerTag);
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
