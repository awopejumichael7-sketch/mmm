/* ==========================================================================
   UI-STATES.JS — Consistent loading & empty states
   --------------------------------------------------------------------------
   A tiny, reusable pair of HTML templates so every new list/section in the
   app shows the same polished "loading" and "nothing here yet" look instead
   of plain "Loading…" text. Free, no dependencies.

   SCOPE NOTE, stated plainly: this is applied to the newer features built
   in this and recent sessions (Assignments, Calendar, Bulk Import). It is
   deliberately NOT retrofitted across the dozens of pre-existing "Loading…"
   spots throughout teacher.js/student.js/admin.js's original functions —
   doing that would mean editing a very large surface of already-working
   code for a purely cosmetic gain, which carries real risk of introducing
   a regression somewhere in return for very little benefit. This utility
   exists so anything built from here forward is consistent by default.
   ========================================================================== */

export function loadingHtml(message = "Loading…") {
  return `
    <div class="ui-loading-state">
      <div class="ui-spinner"></div>
      <p>${message}</p>
    </div>`;
}

export function emptyStateHtml(message = "Nothing here yet.", icon = "fa-inbox") {
  return `
    <div class="ui-empty-state">
      <i class="fa-solid ${icon}"></i>
      <p>${message}</p>
    </div>`;
}
