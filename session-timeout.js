/* ==========================================================================
   SESSION-TIMEOUT.JS — Auto-logout after inactivity, with a warning first
   --------------------------------------------------------------------------
   Shared by the Admin, Teacher, and Student portals. Zero cost, no new
   infrastructure: pure client-side inactivity tracking using the browser's
   own event system, calling the existing logout() from auth.js when time
   runs out. Relevant since this app handles exam sessions and student
   records — an unattended, still-logged-in device is a real exposure.

   Default behavior: after 30 minutes with no mouse, keyboard, scroll, or
   touch activity, a modal warns the person and counts down 60 seconds. Any
   activity (or clicking "Stay Logged In") cancels the countdown and resets
   the idle clock. If the countdown reaches zero, they're logged out
   automatically via the app's normal logout() — same as clicking the
   logout button themselves.
   ========================================================================== */
import { logout } from "./auth.js";

const IDLE_LIMIT_MS = 30 * 60 * 1000;   // 30 minutes of inactivity before warning
const WARNING_MS = 60 * 1000;            // 60 seconds to respond once warned

let idleTimer = null;
let countdownTimer = null;
let modalEl = null;

function clearTimers() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function removeModal() {
  if (modalEl) { modalEl.remove(); modalEl = null; }
}

function showWarning() {
  removeModal();
  let secondsLeft = Math.floor(WARNING_MS / 1000);

  modalEl = document.createElement("div");
  modalEl.id = "session-timeout-modal";
  modalEl.innerHTML = `
    <div class="session-timeout-card">
      <i class="fa-solid fa-clock" style="font-size:1.8rem;color:var(--gold);"></i>
      <h3>Still there?</h3>
      <p>You've been inactive for a while. For account security, you'll be signed out in <strong id="session-timeout-seconds">${secondsLeft}</strong> seconds.</p>
      <button class="btn-gold" id="session-timeout-stay" type="button">Stay Logged In</button>
    </div>`;
  document.body.appendChild(modalEl);

  document.getElementById("session-timeout-stay").onclick = resetIdleTimer;

  countdownTimer = setInterval(() => {
    secondsLeft--;
    const el = document.getElementById("session-timeout-seconds");
    if (el) el.textContent = String(Math.max(secondsLeft, 0));
    if (secondsLeft <= 0) {
      clearTimers();
      removeModal();
      logout();
    }
  }, 1000);
}

function resetIdleTimer() {
  clearTimers();
  removeModal();
  idleTimer = setTimeout(showWarning, IDLE_LIMIT_MS);
}

/** Call once per dashboard, right after login. */
export function initSessionTimeout() {
  const activityEvents = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
  activityEvents.forEach(evt => {
    document.addEventListener(evt, () => {
      // While the warning modal is up, only the "Stay Logged In" button
      // (or actual continued activity) should cancel it — this listener
      // already covers that since any of these events calls the same reset.
      if (!modalEl) resetIdleTimer();
    }, { passive: true });
  });
  resetIdleTimer();
}
