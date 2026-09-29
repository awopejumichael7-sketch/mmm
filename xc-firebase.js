/* ==========================================================================
   XC-FIREBASE.JS — single import point for the Exam Centre modules.
   Re-exports everything from the app's existing firebase-config.js (which is
   left untouched) and adds `writeBatch`, which that file doesn't re-export.
   The version below MUST match the one in firebase-config.js so both share
   the same Firestore SDK instance.
   ========================================================================== */
export * from "./firebase-config.js";
export { writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
