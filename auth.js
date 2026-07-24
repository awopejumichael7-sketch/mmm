/* ==========================================================================
   AUTH.JS — login, role detection & route guarding
   Login model: Admin logs in with email/password (created manually in the
   Firebase console the first time). Teachers & Students log in with the
   ID + Passcode the Admin generated for them (auth.js turns that into an
   internal email/password sign-in behind the scenes: <ID>@cacgw.app / passcode).
   ========================================================================== */
import {
  auth, db, COL, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  doc, getDoc, logActivity
} from "./firebase-config.js";
import { toast } from "./app-shell.js";

let currentRole = "student"; // 'admin' | 'teacher' | 'student'

export function setLoginRole(role) { currentRole = role; }

export async function handleLogin(identifier, secret) {
  try {
    let email = identifier.trim();
    if (currentRole !== "admin") {
      // Teachers/Students sign in with generated ID -> mapped to a synthetic email
      email = `${identifier.trim().toLowerCase()}@cacgw.app`;
    }
    const cred = await signInWithEmailAndPassword(auth, email, secret);
    const uid = cred.user.uid;

    const roleCol = currentRole === "admin" ? COL.admins : currentRole === "teacher" ? COL.teachers : COL.students;
    const profileSnap = await getDoc(doc(db, roleCol, uid));
    if (!profileSnap.exists()) {
      await signOut(auth);
      toast("No matching " + currentRole + " profile found for this account.", "error");
      return;
    }
    const profile = profileSnap.data();
    if (profile.active === false) {
      await signOut(auth);
      toast("This account has been deactivated. Contact the Administrator.", "error");
      return;
    }
    localStorage.setItem("cacgw_role", currentRole);
    localStorage.setItem("cacgw_uid", uid);
    await logActivity(uid, currentRole, "login");
    toast("Welcome, " + (profile.fullName || profile.name || "back") + "!", "success");
    setTimeout(() => {
      window.location.href = currentRole === "admin" ? "admin.html" : currentRole === "teacher" ? "teacher.html" : "student.html";
    }, 500);
  } catch (err) {
    console.error(err);
    toast(friendlyAuthError(err.code), "error");
  }
}

function friendlyAuthError(code) {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect ID/email or passcode.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "No internet connection. Try again when you're back online.";
    default:
      return "Login failed. Please check your details and try again.";
  }
}

/* ---------- Route guard: call this at the top of every dashboard page ---------- */
export function guardRoute(requiredRole) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      const savedRole = localStorage.getItem("cacgw_role");
      if (!user || savedRole !== requiredRole) {
        window.location.href = "index.html";
        return;
      }
      resolve(user);
    });
  });
}

export async function logout() {
  const uid = localStorage.getItem("cacgw_uid");
  const role = localStorage.getItem("cacgw_role");
  if (uid) await logActivity(uid, role, "logout");
  await signOut(auth);
  localStorage.removeItem("cacgw_role");
  localStorage.removeItem("cacgw_uid");
  window.location.href = "index.html";
}
