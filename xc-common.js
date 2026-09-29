/* ==========================================================================
   XC-COMMON.JS — helpers shared by the Exam Centre pages
   (route guard, stylesheet loader, in-progress exam sessions, safe result saving)
   ========================================================================== */
import {
  auth, db, COL, onAuthStateChanged, doc, getDoc, setDoc, serverTimestamp
} from "./xc-firebase.js";
import { XC } from "./exam-catalog.js";
import { flushOfflineQueue, queueOfflineAction } from "./app-shell.js";

/* ---------- Stylesheet (injected so the existing HTML pages need no edits) ---------- */
export function ensureStyles() {
  if (document.querySelector("link[data-xc-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = new URL("./exam-center.css", import.meta.url).href;
  l.dataset.xcCss = "1";
  document.head.appendChild(l);
}

/* ---------- Route guard for pages that several roles may open ----------
   Mirrors auth.js guardRoute (same localStorage role convention) but accepts a
   list of roles, and additionally confirms the profile document really exists
   so a stale localStorage value can't grant access on its own. */
const ROLE_COLLECTION = { admin: COL.admins, teacher: COL.teachers, student: COL.students };

export function guardRoles(allowed) {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      const role = localStorage.getItem("cacgw_role");
      if (!user || !allowed.includes(role)) { window.location.href = "index.html"; return; }
      try {
        const snap = await getDoc(doc(db, ROLE_COLLECTION[role], user.uid));
        if (!snap.exists() || snap.data().active === false) { window.location.href = "index.html"; return; }
        resolve({ user, role, profile: snap.data() });
      } catch (e) {
        console.error("Profile check failed", e);
        window.location.href = "index.html";
      }
    });
  });
}

/* ---------- In-progress exam session (survives refresh / accidental close) ---------- */
const sessKey = (uid, examId) => `xc_sess_${uid}_${examId}`;
export const sessionKeyFor = sessKey;
export function loadSession(uid, examId) {
  try { return JSON.parse(localStorage.getItem(sessKey(uid, examId)) || "null"); } catch (e) { return null; }
}
export function saveSession(uid, examId, s) {
  try { localStorage.setItem(sessKey(uid, examId), JSON.stringify(s)); } catch (e) { /* storage full/blocked: exam still works, just can't resume */ }
}
export function clearSession(uid, examId) { localStorage.removeItem(sessKey(uid, examId)); }

/* ---------- Saving results: idempotent + offline-safe ----------
   The document ID is generated on the client, so a retry (after a dropped
   connection) can never create a duplicate result — the second attempt sees the
   document already exists and does nothing. */
export function newResultId(uid, examId) { return `${uid}_${examId}_${Date.now().toString(36)}`; }

async function writeResultOnce(payload) {
  const ref = doc(db, XC.results, payload.resultId);
  const existing = await getDoc(ref);
  if (existing.exists()) return;
  await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/** Returns "saved" or "queued". Never throws for a network problem — the result is kept for retry. */
export async function saveResult(payload) {
  try {
    if (!navigator.onLine) throw new Error("offline");
    await withTimeout(writeResultOnce(payload), 12000);
    return "saved";
  } catch (e) {
    queueOfflineAction({ type: "xcResult", payload }); // same localStorage queue the rest of the app uses
    return "queued";
  }
}

/** Retry any results that couldn't be saved earlier. Safe to call on every page load. */
export function flushPendingResults() {
  return flushOfflineQueue({ xcResult: (payload) => writeResultOnce(payload) });
}
