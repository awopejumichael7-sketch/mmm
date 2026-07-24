/* ==========================================================================
   APP SHELL — shared across every dashboard page
   Toasts, dark/light theme, PWA install button, offline queue (IndexedDB
   via localForage-lite pattern using plain IndexedDB + localStorage fallback)
   ========================================================================== */

/* ---------- Toasts ---------- */
export function toast(msg, type = "info") {
  let box = document.getElementById("toast-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast-box";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

/* ---------- Theme ---------- */
export function initTheme() {
  const saved = localStorage.getItem("cacgw_theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  document.body.setAttribute("data-theme", saved);
}
export function toggleTheme() {
  const cur = document.body.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.body.setAttribute("data-theme", cur);
  document.documentElement.setAttribute("data-theme", cur);
  localStorage.setItem("cacgw_theme", cur);
}

/* ---------- Service worker + PWA install ---------- */
export function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(console.warn);
    });
  }
}

let deferredPrompt = null;
export function initInstallBanner() {
  const banner = document.getElementById("install-banner");
  if (!banner) return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    banner.style.display = "flex";
  });
  const installBtn = document.getElementById("install-btn");
  const dismissBtn = document.getElementById("install-dismiss");
  if (installBtn) installBtn.onclick = async () => {
    banner.style.display = "none";
    if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; }
  };
  if (dismissBtn) dismissBtn.onclick = () => banner.style.display = "none";
}

/* ---------- Online/offline sync queue (localStorage-backed, simple & robust) ---------- */
const QUEUE_KEY = "cacgw_sync_queue";

export function queueOfflineAction(action) {
  const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  q.push({ ...action, queuedAt: Date.now() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export async function flushOfflineQueue(handlers) {
  if (!navigator.onLine) return;
  const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  if (!q.length) return;
  const remaining = [];
  for (const item of q) {
    try {
      if (handlers[item.type]) await handlers[item.type](item.payload);
      else remaining.push(item);
    } catch (e) { remaining.push(item); }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  if (remaining.length < q.length) toast(`Synced ${q.length - remaining.length} offline item(s)`, "success");
}

export function initOfflineWatcher(handlers) {
  window.addEventListener("online", () => flushOfflineQueue(handlers));
  flushOfflineQueue(handlers);
  const dot = document.getElementById("net-status");
  const update = () => { if (dot) dot.title = navigator.onLine ? "Online" : "Offline — changes will sync later"; if (dot) dot.style.background = navigator.onLine ? "#1e8e5a" : "#c0392b"; };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

/* ---------- Guard against right-click / devtools on protected content ---------- */
export function protectElement(el) {
  if (!el) return;
  el.classList.add("protected");
  el.addEventListener("contextmenu", e => e.preventDefault());
  el.addEventListener("copy", e => e.preventDefault());
  el.addEventListener("dragstart", e => e.preventDefault());
}

/* ---------- Small helper: log out redirect ---------- */
export function goTo(path) { window.location.href = path; }
