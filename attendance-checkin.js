/* ==========================================================================
   ATTENDANCE-CHECKIN.JS — Free QR-code attendance check-in
   --------------------------------------------------------------------------
   Teacher projects/shows a QR code for the current class session; students
   scan it with their phone camera, which opens the Student Portal already
   signed in and instantly logs their attendance for that specific session —
   distinct from the existing "attendance is logged when you open the app"
   behavior, this ties a record to a deliberate, in-the-room check-in.

   Zero extra cost: the QR code is generated entirely in the browser with
   the free, open-source `qrcode` library (no server, no external API call
   per code), and session data lives in the Firestore project you already
   have. Attendance records are written to the SAME `attendance` collection
   your existing Attendance page already reads — so they show up there
   automatically with no changes needed to that page.
   ========================================================================== */
import {
  db, collection, doc, setDoc, getDoc, addDoc, query, where, onSnapshot, serverTimestamp
} from "./firebase-config.js";
import { toast } from "./app-shell.js";

const SESSION_LENGTH_MS = 15 * 60 * 1000; // a check-in QR code is valid for 15 minutes
let unsubCheckins = null;

/* ============================== TEACHER ============================== */
export function stopQrCheckin() {
  if (unsubCheckins) { unsubCheckins(); unsubCheckins = null; }
}

export function renderQrCheckinPanel(container, courseId, teacherUid) {
  stopQrCheckin();
  container.innerHTML = `
    <div class="glass-card" style="margin-top:16px;">
      <h4><i class="fa-solid fa-qrcode"></i> QR Attendance Check-In</h4>
      <p style="color:var(--muted);font-size:.88rem;">Show this on a screen or projector — students scan it with their phone to check in to this specific class session, valid for 15 minutes.</p>
      <button class="btn-gold" id="qr-start-btn" type="button"><i class="fa-solid fa-play"></i> Start Check-In Session</button>
      <div id="qr-active-panel" style="display:none;margin-top:14px;">
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;">
          <canvas id="qr-canvas"></canvas>
          <div style="flex:1;min-width:200px;">
            <p id="qr-expiry" style="color:var(--muted);font-size:.85rem;"></p>
            <p><strong id="qr-checkin-count">0</strong> checked in so far</p>
            <div id="qr-checkin-list" style="max-height:200px;overflow-y:auto;font-size:.85rem;"></div>
            <button class="btn-danger" id="qr-stop-btn" type="button" style="margin-top:10px;">End Session</button>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById("qr-start-btn").onclick = async () => {
    const btn = document.getElementById("qr-start-btn");
    btn.disabled = true;
    try {
      await startSession(courseId, teacherUid);
    } catch (e) {
      toast("Couldn't start the check-in session.", "error");
    }
    btn.disabled = false;
  };
}

async function startSession(courseId, teacherUid) {
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_LENGTH_MS;
  await setDoc(doc(db, "attendanceSessions", sessionId), {
    courseId, teacherId: teacherUid, createdAt: serverTimestamp(), expiresAt, active: true
  });

  const checkinUrl = new URL(`student.html?checkin=${sessionId}`, window.location.href).href;

  document.getElementById("qr-start-btn").style.display = "none";
  const activePanel = document.getElementById("qr-active-panel");
  activePanel.style.display = "block";

  const QRCode = (await import("https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm")).default;
  const canvas = document.getElementById("qr-canvas");
  await QRCode.toCanvas(canvas, checkinUrl, { width: 220, margin: 1 });

  const expiryEl = document.getElementById("qr-expiry");
  const tick = () => {
    const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    expiryEl.textContent = remaining > 0 ? `Expires in ${Math.floor(remaining / 60)}m ${remaining % 60}s` : "Expired";
    if (remaining <= 0) clearInterval(interval);
  };
  tick();
  const interval = setInterval(tick, 1000);

  const q = query(collection(db, "attendance"), where("sessionId", "==", sessionId));
  unsubCheckins = onSnapshot(q, (snap) => {
    document.getElementById("qr-checkin-count").textContent = String(snap.size);
    const rows = [];
    snap.forEach(d => { const a = d.data(); rows.push(`<div>${a.studentId || "Student"} — ${a.time || ""}</div>`); });
    const list = document.getElementById("qr-checkin-list");
    if (list) list.innerHTML = rows.join("") || "<span style='color:var(--muted);'>No check-ins yet.</span>";
  });

  document.getElementById("qr-stop-btn").onclick = async () => {
    clearInterval(interval);
    await setDoc(doc(db, "attendanceSessions", sessionId), { active: false }, { merge: true });
    stopQrCheckin();
    document.getElementById("qr-start-btn").style.display = "";
    document.getElementById("qr-start-btn").disabled = false;
    activePanel.style.display = "none";
    toast("Check-in session ended.", "success");
  };
}

/* ============================== STUDENT ============================== */
/**
 * Call once after login. Looks for a `?checkin=<sessionId>` URL parameter,
 * validates it, and — if valid — logs an attendance record for that
 * specific session. Silently does nothing if there's no such parameter.
 */
export async function handleCheckinFromUrl({ uid, studentId, myCourseIds }) {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("checkin");
  if (!sessionId) return;

  // Clean the URL immediately so a page refresh can't double-submit.
  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, document.title, cleanUrl);

  try {
    const sessSnap = await getDoc(doc(db, "attendanceSessions", sessionId));
    if (!sessSnap.exists()) { toast("This check-in code is invalid.", "error"); return; }
    const sess = sessSnap.data();
    if (sess.active === false || (sess.expiresAt && Date.now() > sess.expiresAt)) {
      toast("This check-in code has expired.", "error");
      return;
    }
    if (!myCourseIds.includes(sess.courseId)) {
      toast("This check-in is for a course you're not enrolled in.", "error");
      return;
    }
    const now = new Date();
    await addDoc(collection(db, "attendance"), {
      studentId, courseId: sess.courseId, sessionId,
      date: now.toISOString().slice(0, 10), time: now.toLocaleTimeString(),
      method: "qr", createdAt: now.toISOString()
    });
    toast("You're checked in for class today!", "success");
  } catch (e) {
    console.warn("QR check-in failed:", e);
    toast("Couldn't complete check-in — try again.", "error");
  }
}
