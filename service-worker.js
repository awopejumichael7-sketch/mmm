/* ==========================================================================
   SERVICE WORKER — offline-first caching for the app shell.
   Firestore/Storage requests are left to Firebase's own offline persistence;
   this worker only caches the static shell (HTML/CSS/JS/icons) so the app
   opens and navigates even with zero connectivity.
   ========================================================================== */
const CACHE_NAME = "cacgw-bible-college-v17";
const APP_SHELL = [
  "./index.html",
  "./admin.html",
  "./teacher.html",
  "./student.html",
  "./ebook-reader.html",
  "./exam.html",
  "./style.css",
  "./app-shell.js",
  "./firebase-config.js",
  "./drive-config.js",
  "./courses-data.js",
  "./auth.js",
  "./admin.js",
  "./teacher.js",
  "./student.js",
  "./ebook-reader.js",
  "./pdf.min.js",
  "./pdf.worker.min.js",
  "./exam.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // Never intercept Firebase/Google API or CDN calls — let the network/Firebase SDK handle those
  if (request.url.includes("firebaseapp.com") ||
      request.url.includes("googleapis.com") ||
      request.url.includes("gstatic.com") ||
      request.url.includes("accounts.google.com") ||
      request.url.includes("drive.google.com") ||
      request.url.includes("cdn.jsdelivr.net") ||
      request.url.includes("unpkg.com")) {
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});

/* ---------- Push notifications (Firebase Cloud Messaging) ---------- */
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "CAC Good Works Bible College";
  const options = {
    body: data.body || "You have a new update.",
    icon: "./icon-192.png",
    badge: "./icon-96.png",
    data: data.url || "./index.html"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || "./index.html"));
});
