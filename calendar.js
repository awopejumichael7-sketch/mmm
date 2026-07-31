/* ==========================================================================
   CALENDAR.JS — Free unified deadlines calendar
   --------------------------------------------------------------------------
   Shared by the Teacher and Student portals. Zero extra cost: purely a
   client-side rendering of data you already have in Firestore — no new
   collections, no external calendar service.

   Honest scope note: Live Class sessions are started ad-hoc (there's no
   stored future schedule for them anywhere in this app), and Exams don't
   have a fixed date either — students can take them whenever they open the
   Exams page. So the one genuine source of "future dated events" in this
   app is Assignment due dates, which is what this calendar is built from.
   If a fixed class timetable or scheduled exam dates get added later, this
   is the natural place to fold them in too.
   ========================================================================== */
import { db, collection, query, where, getDocs } from "./firebase-config.js";

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let viewYear, viewMonth; // 0-indexed month, module-local so prev/next survive re-render

export async function renderCalendarView(container, { course, role }) {
  if (!course) { container.innerHTML = "<p>No course assigned yet.</p>"; return; }

  const today = new Date();
  if (viewYear === undefined) { viewYear = today.getFullYear(); viewMonth = today.getMonth(); }

  const snap = await getDocs(query(collection(db, "assignments"), where("courseId", "==", course.id)));
  const assignmentsByDate = {}; // "YYYY-MM-DD" -> [assignment, ...]
  snap.forEach(d => {
    const a = d.data();
    if (!a.dueDate) return;
    (assignmentsByDate[a.dueDate] ||= []).push(a);
  });

  container.innerHTML = `
    <div class="glass-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <button class="btn-outline" id="cal-prev" type="button"><i class="fa-solid fa-chevron-left"></i></button>
        <h4 style="margin:0;">${MONTH_NAMES[viewMonth]} ${viewYear}</h4>
        <button class="btn-outline" id="cal-next" type="button"><i class="fa-solid fa-chevron-right"></i></button>
      </div>
      <div id="cal-grid" class="calendar-grid"></div>
    </div>
    <div id="cal-list" style="margin-top:16px;"></div>`;

  renderGrid(assignmentsByDate, today);
  renderMonthList(assignmentsByDate);

  document.getElementById("cal-prev").onclick = () => {
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendarView(container, { course, role });
  };
  document.getElementById("cal-next").onclick = () => {
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendarView(container, { course, role });
  };
}

function renderGrid(assignmentsByDate, today) {
  const grid = document.getElementById("cal-grid");
  if (!grid) return;
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayStr = today.toISOString().slice(0, 10);

  let html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => `<div class="calendar-dow">${d}</div>`).join("");
  for (let i = 0; i < firstDay; i++) html += `<div class="calendar-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const items = assignmentsByDate[dateStr] || [];
    const isToday = dateStr === todayStr;
    html += `<div class="calendar-cell${isToday ? " today" : ""}${items.length ? " has-events" : ""}" title="${items.map(a => escapeHtml(a.title)).join(", ")}">
      <span class="calendar-daynum">${day}</span>
      ${items.length ? `<span class="calendar-dot"></span>` : ""}
    </div>`;
  }
  grid.innerHTML = html;
}

function renderMonthList(assignmentsByDate) {
  const list = document.getElementById("cal-list");
  if (!list) return;
  const prefix = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}`;
  const entries = Object.entries(assignmentsByDate)
    .filter(([date]) => date.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b));

  if (!entries.length) {
    list.innerHTML = `<p style="color:var(--muted);">No assignment due dates this month.</p>`;
    return;
  }
  list.innerHTML = `<div class="glass-card"><h4>This Month's Deadlines</h4>` +
    entries.map(([date, items]) => items.map(a => `
      <div style="padding:8px 0;border-bottom:1px solid #eef1f7;">
        <strong>${escapeHtml(a.title)}</strong>
        <div style="color:var(--muted);font-size:.85rem;">${date}</div>
      </div>`).join("")).join("") +
    `</div>`;
}
