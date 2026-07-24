# CAC Good Works Assembly Believers Bible College — PWA

A complete, installable Progressive Web App with Admin / Teacher / Student
dashboards, built on 100% free technology (HTML5, CSS3, JS ES6, Bootstrap 5,
Font Awesome, Firebase free tier).

Every file lives flat in this one folder and links to the others directly by
relative filename — no subfolders.

## 1. Create your free Firebase project
1. Go to https://console.firebase.google.com → **Add project** (free Spark plan).
2. Project settings → **Add app → Web app** → copy the config object.
3. Paste that config into `firebase-config.js` (top of the file), replacing
   the `YOUR_...` placeholders.
4. In the console enable:
   - **Authentication → Sign-in method → Email/Password**
   - **Firestore Database** (start in production mode)
   - **Storage**
   - **Cloud Messaging** (optional, for push notifications)
5. Deploy `firestore.rules` and `storage.rules` from this folder (Firebase
   console → Firestore/Storage → Rules tab → paste and publish), or with the
   Firebase CLI: `firebase deploy --only firestore:rules,storage:rules`.

## 2. Create your first Administrator
Because the app lets Teachers/Students self-provision through the Admin
dashboard, you need to manually create the **first** admin once:
1. Firebase console → Authentication → **Add user** → enter an email + password.
2. Firestore console → **Start collection** `admins` → document ID = the new
   user's UID (copy it from the Authentication tab) → add field
   `fullName` (string) and `active` (boolean, true).
3. Log in on the site using the **Admin** tab with that email/password.

From then on the Admin dashboard can generate Teacher and Student IDs and
passcodes automatically — no manual Firestore edits needed for them.

## 3. Run it locally
Any static file server works, e.g.:
```
npx serve .
```
or the VS Code "Live Server" extension. It must be served over `http://localhost`
or `https://` for the service worker / camera / microphone APIs to work.

## 4. Deploy for free on Firebase Hosting
```
npm install -g firebase-tools
firebase login
firebase init hosting     # choose this folder as the public directory
firebase deploy
```

## 5. Installing the app
Visit the site on any device — an **"Install this app"** banner appears
(or use the browser's install icon in the address bar) so it behaves like a
native mobile/desktop app, including offline access to previously viewed pages.

## New free features (Whiteboard, Calculator, Dictionary, AI Assistant)
These were added on top of the original build without changing anything
that already existed — same Bootstrap/Font Awesome/Firebase stack, $0 extra
cost:
- **Whiteboard** (Teacher & Student sidebars): a live, collaborative canvas
  per course. Teacher and students draw together in real time using your
  existing Firestore project — no new service, no extra bill. Deploy the
  updated `firestore.rules` (see step 1 above) so the new `whiteboards`
  collection is readable/writable by signed-in users.
- **Scientific Calculator** (Student sidebar): 100% client-side, works
  offline, no network calls at all.
- **Dictionary** (Student sidebar): uses the free, keyless
  [dictionaryapi.dev](https://dictionaryapi.dev) public API — no signup,
  no API key, no billing risk.
- **AI Assistant** (Teacher sidebar): runs a small open-weight language
  model **entirely inside the teacher's browser tab** using
  [WebLLM](https://github.com/mlc-ai/web-llm) + WebGPU. There's no API key,
  no backend, and no per-message cost — the only "cost" is a one-time
  ~1 GB model download per device on first use (the browser caches it after
  that). Requires a WebGPU-capable browser (current Chrome/Edge on
  desktop, or a modern Android device); the UI explains this plainly if
  unsupported rather than failing silently. Nothing is sent to Anthropic,
  OpenAI, or any other paid service.

## What's real vs. simplified in this build
This whole system (live classrooms, exam anti-cheat, certificates, 10 full
courses, multi-language translation, offline sync) is normally a multi-week
team project. Everything above is wired up and functional against your own
Firebase project, with these practical simplifications you may want to extend:
- **Translation** uses the free MyMemory API and translates the current page
  in ~480-character chunks (its free-tier limit) rather than an entire book at once.
- **Live class / screen-share** uses the browser's camera+mic (`getUserMedia`)
  and `MediaRecorder` to record and auto-save lessons for on-demand streaming;
  true multi-user real-time video calling would additionally need a signaling
  server or a service like an external WebRTC SFU, which isn't free at scale.
- **PDF ebooks** are read by extracting text with pdf.js; scanned image-only
  PDFs won't have selectable/translatable text unless you add OCR.
- **Storage security rules** are intentionally permissive for any signed-in
  user; for stricter role checks, add Firebase custom claims for admin/teacher.
