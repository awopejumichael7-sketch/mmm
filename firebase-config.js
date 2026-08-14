/* ==========================================================================
   FIREBASE CONFIG & INITIALIZATION
   CAC Good Works Assembly Believers Bible College PWA
   --------------------------------------------------------------------------
   1. Go to https://console.firebase.google.com -> Create Project (FREE plan)
   2. Add a Web App, copy the config object Firebase gives you and paste it
      below, replacing the placeholder values.
   3. In the console enable: Authentication (Email/Password), Firestore
      Database, Storage, Cloud Messaging.
   4. Deploy security rules from firestore.rules / storage.rules (below file).
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, enableIndexedDbPersistence, collection, doc, setDoc, getDoc,
  getDocs, addDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot,
  serverTimestamp, increment, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  getMessaging, getToken, onMessage
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

// ---- REPLACE WITH YOUR OWN FIREBASE PROJECT CONFIG ------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDmBnHfiTsDA78DXYxWb9-pF4Rmm7ScoVM",
    authDomain: "scholar-7938a.firebaseapp.com",
    projectId: "scholar-7938a",
    storageBucket: "scholar-7938a.firebasestorage.app",
    messagingSenderId: "599869942046",
    appId: "1:599869942046:web:1679eade47e4a7e06e810f"
};
// -----------------------------------------------------------------------

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Offline persistence so students/teachers can keep working without signal
try {
  enableIndexedDbPersistence(db).catch((err) => {
    console.warn("Offline persistence not enabled:", err.code);
  });
} catch (e) { console.warn(e); }

// Messaging only works on https/localhost with a registered service worker
export let messaging = null;
try { messaging = getMessaging(app); } catch (e) { /* not supported */ }

// Re-export everything pages need so they only ever import from this file
export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword,
  collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, increment, limit,
  ref, uploadBytes, uploadBytesResumable, getDownloadURL, deleteObject,
  getToken, onMessage
};

/* ==========================================================================
   COLLECTION NAMES (single source of truth)
   ========================================================================== */
export const COL = {
  admins: "admins",
  teachers: "teachers",
  students: "students",
  courses: "courses",
  ebooks: "ebooks",
  handbooks: "handbooks",
  syllabus: "syllabus",
  attendance: "attendance",
  audio: "audio",
  videos: "videos",
  feedback: "feedback",
  questions: "questions",
  examQuestions: "examQuestions",
  results: "results",
  notifications: "notifications",
  settings: "settings",
  analytics: "analytics",
  activityLogs: "activityLogs",
  liveSessions: "liveSessions"
};

/* ICE servers used by the Live Class WebRTC feature (teacher.js / student.js).
   --------------------------------------------------------------------------
   STUN alone (the original single Google STUN server here) only helps two
   people connect directly when their networks allow it — which is exactly
   why it worked fine when teacher and student were on the same network,
   but showed blank video/no audio the moment they were on different
   networks: many real-world networks (mobile data, school/office
   firewalls, some home routers) block direct peer-to-peer connections
   entirely. The only fix for that is a TURN server, which relays the
   audio/video between them instead of connecting them directly.

   Below adds the free, keyless TURN servers from Metered.ca's Open Relay
   Project (https://www.metered.ca/tools/openrelay/) — the standard, widely
   used free option for small projects like this one. No signup, no card,
   $0. One honest limitation: these are shared public demo credentials used
   by many projects worldwide, so they're best-effort rather than
   guaranteed-available. If Live Class usage grows and this ever becomes
   unreliable, Metered.ca also offers a free personal account (50GB/month
   TURN relay, still $0, just requires their own quick signup) for a
   dedicated, more reliable quota — a one-line swap of these credentials
   when/if that's ever needed. */
export const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:openrelay.metered.ca:80" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
  ]
};

/* ==========================================================================
   ACTIVITY LOGGER - used across all dashboards for the admin audit trail
   ========================================================================== */
export async function logActivity(uid, role, action, details = "") {
  try {
    await addDoc(collection(db, COL.activityLogs), {
      uid, role, action, details,
      timestamp: serverTimestamp(),
      device: navigator.userAgent
    });
  } catch (e) { console.warn("logActivity failed", e); }
}

/* ==========================================================================
   ID / PASSCODE GENERATORS (used by Admin when creating Teachers/Students)
   ========================================================================== */
export function generateId(prefix) {
  const year = new Date().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${year}-${rand}`;
}
export function generatePasscode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
