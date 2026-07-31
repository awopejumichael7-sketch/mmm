/* ==========================================================================
   EMAIL-NOTIFY.JS — Real email notifications via EmailJS (free tier)
   --------------------------------------------------------------------------
   EmailJS lets a static site send real emails straight from the browser —
   no backend server, no credit card, genuinely free up to 200 emails/month
   on their free plan. This module is intentionally "fail silent": if it
   isn't configured yet, or a send fails, it logs a console warning and
   does nothing else — it will NEVER throw an error that could break the
   feature that triggered it (account creation, grading, etc. all keep
   working normally even if email sending isn't set up or is unreachable).

   ==========================================================================
   SETUP REQUIRED (one-time, on emailjs.com — takes about 10 minutes):
   ==========================================================================
   1. Create a free account at https://www.emailjs.com (no credit card).
   2. Add an Email Service (e.g. connect your Gmail) — note the SERVICE ID.
   3. Create four Email Templates, one per notification type below, using
      the exact variable names listed for each — then note each TEMPLATE ID:

      accountCreated  → vars: to_email, to_name, role, login_id, passcode
      announcement    → vars: to_email, title, body
      graded          → vars: to_email, to_name, course_title, score, grade
      certificateReady→ vars: to_email, to_name, course_title

   4. Go to Account → General in EmailJS and copy your PUBLIC KEY.
   5. Paste all of these into the CONFIG block directly below. That's it —
      no other code in this file needs to change.
   ==========================================================================
*/

const CONFIG = {
  publicKey: "YOUR_EMAILJS_PUBLIC_KEY",
  serviceId: "YOUR_EMAILJS_SERVICE_ID",
  templates: {
    accountCreated: "YOUR_TEMPLATE_ID_ACCOUNT_CREATED",
    announcement: "YOUR_TEMPLATE_ID_ANNOUNCEMENT",
    graded: "YOUR_TEMPLATE_ID_GRADED",
    certificateReady: "YOUR_TEMPLATE_ID_CERTIFICATE_READY"
  }
};

function isConfigured() {
  return CONFIG.publicKey && !CONFIG.publicKey.startsWith("YOUR_");
}

let emailjsLib = null;
async function getClient() {
  if (emailjsLib) return emailjsLib;
  const mod = await import("https://cdn.jsdelivr.net/npm/@emailjs/browser@4/+esm");
  emailjsLib = mod.default || mod;
  emailjsLib.init({ publicKey: CONFIG.publicKey });
  return emailjsLib;
}

async function send(templateId, params) {
  if (!isConfigured()) {
    console.warn("[email-notify] Skipped — EmailJS isn't configured yet (see setup instructions at the top of email-notify.js).");
    return false;
  }
  if (!params.to_email) { console.warn("[email-notify] Skipped — no recipient email address."); return false; }
  try {
    const client = await getClient();
    await client.send(CONFIG.serviceId, templateId, params);
    return true;
  } catch (e) {
    console.warn("[email-notify] Send failed:", e);
    return false;
  }
}

/** New teacher or student account — includes their login ID and passcode. */
export function sendAccountCreatedEmail({ toEmail, toName, role, loginId, passcode }) {
  return send(CONFIG.templates.accountCreated, {
    to_email: toEmail, to_name: toName || "", role: role || "", login_id: loginId || "", passcode: passcode || ""
  });
}

/** A published announcement — call once per recipient. Caller controls batch size (see admin.js). */
export function sendAnnouncementEmail({ toEmail, title, body }) {
  return send(CONFIG.templates.announcement, { to_email: toEmail, title: title || "", body: body || "" });
}

/** A theory answer has just been graded. */
export function sendGradedEmail({ toEmail, toName, courseTitle, score, grade }) {
  return send(CONFIG.templates.graded, {
    to_email: toEmail, to_name: toName || "", course_title: courseTitle || "", score: score || "", grade: grade || ""
  });
}

/** A student's result just crossed the passing threshold — their certificate is now available. */
export function sendCertificateReadyEmail({ toEmail, toName, courseTitle }) {
  return send(CONFIG.templates.certificateReady, { to_email: toEmail, to_name: toName || "", course_title: courseTitle || "" });
}
