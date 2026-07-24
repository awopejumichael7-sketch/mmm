/* ==========================================================================
   DRIVE-CONFIG.JS — Google Drive integration (Admin/Teacher "save to Drive"
   option, alongside the existing Firebase Storage option).
   --------------------------------------------------------------------------
   ONE-TIME SETUP (see README.md "Google Drive setup" section for full steps):
   1. Create/open a project at https://console.cloud.google.com
   2. Enable the "Google Drive API"
   3. Create an OAuth 2.0 Client ID (type: Web application) — add your site's
      URL under "Authorized JavaScript origins"
   4. Create an API key
   5. Paste both below.
   ========================================================================== */

// ---- REPLACE WITH YOUR OWN GOOGLE CLOUD CREDENTIALS ------------------------
export const GOOGLE_CLIENT_ID = "99226911453-ooejt6q5l1fv17ft6bbuhnt257cft1go.apps.googleusercontent.com";
export const GOOGLE_API_KEY = "AIzaSyDkjStmCKk5S63cn3RuOR5AJr_2AeT0s_E";
// -----------------------------------------------------------------------

// NOTE ON SCOPE: this used to request the narrower "drive.file" permission,
// which only grants access to files explicitly picked via the Picker. In
// practice that combination has a well-known rough edge — the per-file
// access grant sometimes fails to register even with setOrigin() set
// correctly, causing an immediate "File not found" error on the very file
// that was just picked. Using the broader "drive" scope below trades a
// wider permission (full read/write access to the signed-in teacher/admin's
// own Drive, not their whole Google account) for eliminating that entire
// class of bug. Since this app is running in Google's "Testing" mode with
// only approved test users, this broader scope doesn't require Google's
// full verification review — it would only matter if this app were opened
// up to the general public beyond your approved test users.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

let tokenClient = null;
let accessToken = null;
let scriptsLoaded = false;
let pickerLoaded = false;

/* ---------- Lazily load Google's scripts only when Drive is actually used ---------- */
export function loadGoogleScripts() {
  if (scriptsLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let count = 0;
    const done = () => { if (++count === 2) { scriptsLoaded = true; resolve(); } };

    const gapiScript = document.createElement("script");
    gapiScript.src = "https://apis.google.com/js/api.js";
    gapiScript.onload = () => {
      gapi.load("client:picker", async () => {
        try {
          await gapi.client.init({
            apiKey: GOOGLE_API_KEY,
            discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"]
          });
          pickerLoaded = true;
          done();
        } catch (e) { reject(e); }
      });
    };
    gapiScript.onerror = reject;
    document.head.appendChild(gapiScript);

    const gisScript = document.createElement("script");
    gisScript.src = "https://accounts.google.com/gsi/client";
    gisScript.onload = () => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: () => {} // overridden per-request below
      });
      done();
    };
    gisScript.onerror = reject;
    document.head.appendChild(gisScript);
  });
}

export function isDriveConnected() { return !!accessToken; }

/* ---------- Ask the signed-in teacher/admin to authorize Drive access (once per session) ---------- */
export function requestAccessToken() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) { reject(new Error("Google Drive isn't loaded yet — try again in a moment.")); return; }
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(resp); return; }
      accessToken = resp.access_token;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
}

/* ---------- Let the admin/teacher pick an existing file from their Drive ---------- */
export async function openDrivePicker() {
  await loadGoogleScripts();
  if (!accessToken) await requestAccessToken();
  return new Promise((resolve) => {
    const view = new google.picker.View(google.picker.ViewId.DOCS);
    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(GOOGLE_API_KEY)
      .setOrigin(window.location.protocol + "//" + window.location.host)
      .addView(view)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const file = data.docs[0];
          resolve({ id: file.id, name: file.name, mimeType: file.mimeType });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

/* ---------- Upload a new file (e.g. a teacher's recorded lesson) straight to Drive ---------- */
export async function uploadFileToDrive(blob, filename, mimeType, onProgress) {
  await loadGoogleScripts();
  if (!accessToken) await requestAccessToken();
  const metadata = { name: filename, mimeType };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form
  });
  if (!res.ok) throw new Error("Google Drive upload failed.");
  const data = await res.json();
  await makeFilePublic(data.id);
  await verifyPublicAccess(data.id);
  return data.id;
}

/* ---------- Make a picked/uploaded file viewable by link so students don't need
   their own Google sign-in to read/stream it ---------- */
export async function makeFilePublic(fileId) {
  if (!accessToken) await requestAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" })
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch (e) { /* ignore */ }
    throw new Error(
      "Could not make this file link-shareable on Google Drive" + (detail ? `: ${detail}` : ".") +
      " If this account is a school/work Google Workspace account, its admin may be blocking " +
      "\"anyone with the link\" sharing — try a personal Gmail account instead, or ask your Workspace admin to allow it."
    );
  }
}

/* ---------- Confirm a file is actually reachable with just the public API key —
   call this right after makeFilePublic so problems surface immediately, not
   only later when a student tries to open it ---------- */
export async function verifyPublicAccess(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id&key=${GOOGLE_API_KEY}`);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch (e) { /* ignore */ }
    throw new Error("This file was linked, but isn't publicly reachable yet" + (detail ? `: ${detail}` : ".") + " Double-check your GOOGLE_API_KEY in drive-config.js and that the Google Drive API is enabled.");
  }
}

/* ---------- Fetch a publicly-shared Drive file's raw bytes — students use this,
   and it needs only the public API key, NOT a student Google sign-in ---------- */
export async function fetchPublicDriveFile(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}`);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch (e) { /* ignore */ }
    throw new Error("Could not load this file from Google Drive" + (detail ? `: ${detail}` : ". It may not be shared publicly."));
  }
  return await res.blob();
}

export function driveFileViewUrl(fileId) {
  return `https://drive.google.com/uc?id=${fileId}`;
}
