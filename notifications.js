/* ==========================================================================
   NOTIFICATIONS.JS — Free, real-time in-app notifications
   --------------------------------------------------------------------------
   Shared by the Admin, Teacher and Student dashboards. Zero extra cost: it
   reuses the Firestore project you already have (the same `notifications`
   collection Admin's Announcements page already writes to) plus the
   browser's built-in Notification API — no Cloud Functions, no Blaze plan,
   no third-party service, no device tokens to manage.

   How it works:
   - Subscribes live to the most recent notifications via onSnapshot and
     renders a bell icon with an unread badge + dropdown list in the header.
   - Anything published *after* this tab was opened triggers an in-app toast
     and, if the person has granted permission, a native OS-style popup —
     this works for as long as the site/installed PWA is open, including in
     a background tab. Being upfront about the one real limit of the free
     approach: it can't wake up a fully closed browser/app (that needs a
     server-side push sender, which is a paid-tier or third-party addition).
   - Note: the Notification API isn't available in plain Safari on iPhone —
     only inside an installed PWA on iOS 16.4+. Everywhere else (Chrome,
     Edge, Firefox, Android, installed PWAs) it works normally.
   ========================================================================== */
import { db, collection, query, orderBy, limit, onSnapshot } from "./firebase-config.js";
import { toast } from "./app-shell.js";

const SEEN_KEY_PREFIX = "cacgw_notif_last_seen_";

let unsub = null;
let sessionStart = 0;
let allDocs = [];
let currentUid = null;
let matchFn = () => false;

/**
 * @param {{role:"admin"|"teacher"|"student", uid:string, courseId?:string}} opts
 */
export function initNotifications({ role, uid, courseId }) {
  stopNotifications();
  currentUid = uid;
  sessionStart = Date.now();
  matchFn = (n) => {
    if (role === "admin") return true; // admin sees everything it publishes
    if (n.audience === "all") return true;
    if (n.audience === "teachers" && role === "teacher") return true;
    if (n.audience === "students" && role === "student") return true;
    if (courseId && n.audience === `course:${courseId}`) return true;
    return false;
  };

  injectBell();

  const q = query(collection(db, "notifications"), orderBy("createdAt", "desc"), limit(30));
  unsub = onSnapshot(q, (snap) => {
    allDocs = [];
    snap.forEach(d => allDocs.push({ id: d.id, ...d.data() }));
    allDocs = allDocs.filter(matchFn);
    renderBellPanel();

    snap.docChanges().forEach(change => {
      if (change.type !== "added") return;
      const n = { id: change.doc.id, ...change.doc.data() };
      if (!matchFn(n)) return;
      const ts = n.createdAt?.toMillis ? n.createdAt.toMillis() : 0;
      if (ts && ts > sessionStart) {
        toast(`${n.title || "Notification"}: ${n.body || ""}`, "success");
        showBrowserNotification(n);
      }
    });
  }, (err) => console.warn("Notifications listener error:", err));
}

/** Call when the person logs out / leaves the dashboard entirely. */
export function stopNotifications() {
  if (unsub) { unsub(); unsub = null; }
  allDocs = [];
  const panel = document.getElementById("notif-panel");
  if (panel) panel.style.display = "none";
}

/* ---------- internals ---------- */
function lastSeenKey() { return SEEN_KEY_PREFIX + currentUid; }
function getLastSeen() { return Number(localStorage.getItem(lastSeenKey()) || 0); }
function setLastSeen(ts) { localStorage.setItem(lastSeenKey(), String(ts)); }

function injectBell() {
  const host = document.getElementById("notif-bell-host");
  if (!host || host.dataset.ready) return;
  host.dataset.ready = "1";
  host.innerHTML = `
    <button class="icon-btn" id="notif-bell-btn" title="Notifications" type="button"><i class="fa-solid fa-bell"></i></button>
    <span id="notif-badge" class="notif-badge" style="display:none;">0</span>
    <div id="notif-panel" class="notif-panel" style="display:none;">
      <div class="notif-panel-head">
        <strong>Notifications</strong>
        <button class="notif-mark-read" id="notif-mark-read" type="button">Mark all read</button>
      </div>
      <div id="notif-permission-row" class="notif-permission-row" style="display:none;">
        <span>Get alert popups even when this tab isn't focused.</span>
        <button class="btn-gold" id="notif-enable-btn" type="button">Enable</button>
      </div>
      <div id="notif-panel-list" class="notif-panel-list"></div>
    </div>`;

  document.getElementById("notif-bell-btn").onclick = (e) => {
    e.stopPropagation();
    const panel = document.getElementById("notif-panel");
    const showing = panel.style.display !== "none";
    panel.style.display = showing ? "none" : "";
    if (!showing) { setLastSeen(Date.now()); updateBadge(); }
  };
  document.getElementById("notif-mark-read").onclick = () => { setLastSeen(Date.now()); updateBadge(); };
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("notif-panel");
    if (!panel || panel.style.display === "none") return;
    if (!host.contains(e.target)) panel.style.display = "none";
  });

  const permRow = document.getElementById("notif-permission-row");
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    permRow.style.display = "flex";
    document.getElementById("notif-enable-btn").onclick = async () => {
      const result = await requestNotificationPermission();
      if (result !== "default") permRow.style.display = "none";
    };
  }
}

function renderBellPanel() {
  const list = document.getElementById("notif-panel-list");
  if (!list) return;
  if (!allDocs.length) {
    list.innerHTML = `<p style="color:var(--muted);padding:14px;">No notifications yet.</p>`;
  } else {
    list.innerHTML = allDocs.map(n => {
      const when = n.createdAt?.toDate ? n.createdAt.toDate().toLocaleString() : "";
      return `<div class="notif-item">
        <strong>${escapeHtml(n.title || "")}</strong>
        <p>${escapeHtml(n.body || "")}</p>
        <small>${when}</small>
      </div>`;
    }).join("");
  }
  updateBadge();
}

function updateBadge() {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  const lastSeen = getLastSeen();
  const unread = allDocs.filter(n => {
    const ts = n.createdAt?.toMillis ? n.createdAt.toMillis() : 0;
    return ts > lastSeen;
  }).length;
  badge.style.display = unread > 0 ? "" : "none";
  badge.textContent = unread > 9 ? "9+" : String(unread);
}

function showBrowserNotification(n) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try { new Notification(n.title || "New notification", { body: n.body || "", icon: "./icon-192.png" }); }
  catch (e) { /* some browsers restrict this from a background tab context; toast already covered it */ }
}

function requestNotificationPermission() {
  if (typeof Notification === "undefined") return Promise.resolve("unsupported");
  if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
  return Notification.requestPermission();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
