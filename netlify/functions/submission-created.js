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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a single full-name string into { firstName, lastName }.
 * Handles: "Jane", "Jane Smith", "Mary Jo Watson"
 */
function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
    return { firstName: "", lastName: "" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  const firstName = parts[0];
  const lastName = parts.slice(1).join(" "); // preserve middle names in last
  return { firstName, lastName };
}

/**
 * Normalize a phone string to a plain digit string for dedup logging.
 * Does NOT modify the value sent to FUB — we send exactly what came in.
 */
function normalizePhone(phone = "") {
  return phone.replace(/\D/g, "");
}

/**
 * Build the Follow Up Boss event payload from a Netlify form payload.
 */
function buildFubPayload(formData) {
  const { name = "", email = "", phone = "", address = "" } = formData;
  const { firstName, lastName } = splitName(name);

  const message = address
    ? `Seller form submitted from website. Property address: ${address}`
    : "Seller form submitted from website.";

  const person = {
    firstName,
    lastName,
  };

  if (email) {
    person.emails = [{ value: email }];
  }

  if (phone) {
    person.phones = [{ value: phone }];
  }

  if (address) {
    person.propertyStreet = address;
  }

  return {
    source: "larrychou.com",
    system: "Netlify",
    type: "Seller Inquiry",
    message,
    person,
  };
}

/**
 * Send the event to Follow Up Boss.
 * Returns { ok, status, body }.
 */
async function sendToFub(payload) {
  const apiKey = process.env.FUB_API_KEY;
  const xSystem = process.env.FUB_X_SYSTEM;
  const xSystemKey = process.env.FUB_X_SYSTEM_KEY;

  if (!apiKey) throw new Error("FUB_API_KEY environment variable is not set.");
  if (!xSystem) throw new Error("FUB_X_SYSTEM environment variable is not set.");
  if (!xSystemKey) throw new Error("FUB_X_SYSTEM_KEY environment variable is not set.");

  // Basic auth: username = API key, password = empty string
  const credentials = Buffer.from(`${apiKey}:`).toString("base64");

  const response = await fetch(FUB_EVENTS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/json",
      "X-System": xSystem,
      "X-System-Key": xSystemKey,
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

const formName = netlifyPayload?.data?.["form-name"] || netlifyPayload?.form_name || netlifyPayload?.payload?.data?.["form-name"] || netlifyPayload?.payload?.form_name || "consult";  console.log(`[${timestamp}] Form name: "${formName}"`);

  // ── 2. Only process our "consult" form ──────────────────────────────────
  if (formName !== "consult") {
    console.log(`[${timestamp}] Ignoring submission from unrelated form: "${formName}"`);
    return { statusCode: 200, body: "Ignored — not the consult form" };
  }

  // ── 3. Extract form fields ───────────────────────────────────────────────
  // Netlify puts fields in payload.data for background functions
const formData = netlifyPayload?.payload?.data ?? netlifyPayload?.data ?? {};
  const { name, email, phone, address } = formData;

  console.log(`[${timestamp}] Submission received:`, {
    name: name || "(missing)",
    email: email || "(missing)",
    phone: phone ? `****${normalizePhone(phone).slice(-4)}` : "(missing)", // mask for logs
    address: address || "(missing)",
  });

  // ── 4. Basic field validation ────────────────────────────────────────────
  if (!name && !email && !phone) {
    console.warn(`[${timestamp}] Submission appears empty — skipping FUB call`);
    return { statusCode: 200, body: "Skipped — no usable contact data" };
  }

  // ── 5. Build and send FUB payload ───────────────────────────────────────
  let fubPayload;
  try {
    fubPayload = buildFubPayload(formData);
    console.log(`[${timestamp}] Sending to Follow Up Boss:`, {
      ...fubPayload,
      // redact emails/phones in logs for privacy
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
    // Network or credential config error
    console.error(`[${timestamp}] FUB request threw an exception:`, err.message);
    // Return 200 so Netlify doesn't retry indefinitely — log is the record
    return { statusCode: 200, body: "FUB send failed (logged)" };
  }

  // ── 6. Log FUB response ──────────────────────────────────────────────────
  if (result.ok) {
    // FUB /v1/events returns 200 even for duplicates — it deduplicates internally
    const fubId = result.body?.id || result.body?.eventId || "(no id returned)";
    console.log(`[${timestamp}] ✅ FUB accepted submission. status=${result.status} id=${fubId}`);
  } else {
    // 4xx usually means bad credentials or malformed payload; log full body
    console.error(
      `[${timestamp}] ❌ FUB rejected submission. status=${result.status} body=`,
      JSON.stringify(result.body)
    );
    // Still return 200 to Netlify — retrying won't fix a 4xx
  }

  return { statusCode: 200, body: "OK" };
};
