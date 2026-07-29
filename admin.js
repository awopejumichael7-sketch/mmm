/* ==========================================================================
   ADMIN.JS — Administrator Dashboard
   ========================================================================== */
import { guardRoute, logout } from "./auth.js";
import {
  app, auth, db, storage, COL,
  collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp,
  ref, uploadBytesResumable, getDownloadURL,
  generateId, generatePasscode, logActivity
} from "./firebase-config.js";
import { DEFAULT_COURSES, seedCourses } from "./courses-data.js";
import { toast, initTheme, toggleTheme, registerServiceWorker } from "./app-shell.js";
import { openDrivePicker, makeFilePublic, verifyPublicAccess, driveFileViewUrl, loadGoogleScripts } from "./drive-config.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth as getAuthSecondary, createUserWithEmailAndPassword, signOut as signOutSecondary } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initNotifications } from "./notifications.js";

initTheme();
registerServiceWorker();

/* ---------- Reusable client-side search filter for data tables (free, no new queries) ---------- */
function bindTableSearch(inputId, wrapId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.oninput = () => {
    const term = input.value.trim().toLowerCase();
    document.querySelectorAll(`#${wrapId} tbody tr`).forEach(row => {
      row.style.display = !term || row.textContent.toLowerCase().includes(term) ? "" : "none";
    });
  };
}
const main = document.getElementById("main-content");
let user;

document.getElementById("theme-btn").onclick = toggleTheme;
document.getElementById("logout-btn").onclick = logout;

guardRoute("admin").then(async (u) => {
  user = u;
  await seedCourses(db, collection, doc, setDoc, getDocs, COL);
  initNotifications({ role: "admin", uid: u.uid });
  bindSidebar();
  renderOverview();
});

function bindSidebar() {
  document.querySelectorAll(".sidebar a").forEach(a => {
    a.addEventListener("click", () => {
      document.querySelectorAll(".sidebar a").forEach(x => x.classList.remove("active"));
      a.classList.add("active");
      const view = a.dataset.view;
      ({
        overview: renderOverview, teachers: renderTeachers, students: renderStudents,
        courses: renderCourses, content: renderContent, exams: renderExams,
        announcements: renderAnnouncements, feedback: renderFeedback,
        reports: renderReports, logs: renderLogs
      })[view]();
    });
  });
}

/* ---------- A secondary Firebase app so creating Teacher/Student accounts
   doesn't log the Admin out of their own session ---------- */
function secondaryAuth() {
  const existing = getApps().find(a => a.name === "secondary");
  const secApp = existing || initializeApp(app.options, "secondary");
  return getAuthSecondary(secApp);
}

/* ============================== OVERVIEW ============================== */
async function renderOverview() {
  main.innerHTML = `<div class="skeleton" style="height:220px;"></div>`;
  const [teachers, students, courses, attendance, feedback] = await Promise.all(
    [COL.teachers, COL.students, COL.courses, COL.attendance, COL.feedback].map(c => getDocs(collection(db, c)))
  );
  main.innerHTML = `
    <h2>Welcome back, Administrator</h2>
    <p style="color:var(--muted);margin-bottom:20px;">Here's what's happening across the college today.</p>
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${teachers.size}</div><div class="label"><i class="fa-solid fa-chalkboard-user"></i> Teachers</div></div>
      <div class="stat-card"><div class="num">${students.size}</div><div class="label"><i class="fa-solid fa-user-graduate"></i> Students</div></div>
      <div class="stat-card"><div class="num">${courses.size}</div><div class="label"><i class="fa-solid fa-book-bible"></i> Courses</div></div>
      <div class="stat-card"><div class="num">${attendance.size}</div><div class="label"><i class="fa-solid fa-clipboard-check"></i> Attendance Records</div></div>
      <div class="stat-card"><div class="num">${feedback.size}</div><div class="label"><i class="fa-solid fa-comments"></i> Feedback Entries</div></div>
    </div>
    <div class="glass-card">
      <h4>Quick Actions</h4>
      <button class="btn-navy" id="qa-teacher"><i class="fa-solid fa-plus"></i> New Teacher</button>
      <button class="btn-navy" id="qa-student"><i class="fa-solid fa-plus"></i> New Student</button>
      <button class="btn-gold" id="qa-announce"><i class="fa-solid fa-bullhorn"></i> New Announcement</button>
    </div>`;
  document.getElementById("qa-teacher").onclick = () => document.querySelector('[data-view="teachers"]').click();
  document.getElementById("qa-student").onclick = () => document.querySelector('[data-view="students"]').click();
  document.getElementById("qa-announce").onclick = () => document.querySelector('[data-view="announcements"]').click();
}

/* ---------- Persistent credentials modal (doesn't auto-dismiss like a toast) ---------- */
function showCredentialsModal(role, name, id, passcode) {
  const old = document.getElementById("creds-modal-backdrop");
  if (old) old.remove();
  const backdrop = document.createElement("div");
  backdrop.id = "creds-modal-backdrop";
  backdrop.style.cssText = "position:fixed;inset:0;background:rgba(11,37,69,.75);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px;";
  backdrop.innerHTML = `
    <div class="glass-card" style="max-width:440px;width:100%;background:#fff;">
      <h4><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> ${role} Created</h4>
      <p style="color:var(--muted);">Save or share these login details with <strong>${name}</strong> now — this passcode cannot be shown again after you close this box.</p>
      <div class="form-field"><label>Login ID</label><input readonly value="${id}" id="cred-id"></div>
      <div class="form-field"><label>Passcode</label><input readonly value="${passcode}" id="cred-pass"></div>
      <button class="btn-gold" id="cred-copy"><i class="fa-solid fa-copy"></i> Copy Both</button>
      <button class="btn-outline" id="cred-close">I've Saved This — Close</button>
    </div>`;
  document.body.appendChild(backdrop);
  document.getElementById("cred-copy").onclick = async () => {
    await navigator.clipboard.writeText(`Login ID: ${id}\nPasscode: ${passcode}`);
    toast("Copied to clipboard", "success");
  };
  document.getElementById("cred-close").onclick = () => backdrop.remove();
}

/* ---------- Reset Login: issues a brand-new ID + passcode (see chat explanation
   for why an in-place password change isn't possible on the free client-only
   Firebase plan) ---------- */
async function resetCredentials(role, oldDocId, refreshFn) {
  const col = role === "teacher" ? COL.teachers : COL.students;
  const idField = role === "teacher" ? "teacherId" : "studentId";
  const prefix = role === "teacher" ? "TCH" : "STU";

  if (!confirm(`Reset this ${role}'s login? They will receive a brand-new ID and passcode — their old ID will stop working. Their name, email, course, and history stay linked to their profile.`)) return;

  const oldSnap = await getDoc(doc(db, col, oldDocId));
  if (!oldSnap.exists()) { toast("Record not found.", "error"); return; }
  const oldData = oldSnap.data();

  const newId = generateId(prefix);
  const newPasscode = generatePasscode();

  try {
    const sAuth = secondaryAuth();
    const cred = await createUserWithEmailAndPassword(sAuth, `${newId.toLowerCase()}@cacgw.app`, newPasscode);
    await setDoc(doc(db, col, cred.user.uid), {
      ...oldData,
      [idField]: newId,
      createdAt: oldData.createdAt || serverTimestamp()
    });
    if (role === "teacher") {
      const ids = oldData.courseIds || (oldData.courseId ? [oldData.courseId] : []);
      for (const cid of ids) await updateDoc(doc(db, COL.courses, cid), { teacherId: cred.user.uid });
    }
    await deleteDoc(doc(db, col, oldDocId)); // old login profile removed so old ID/passcode can no longer sign in
    await signOutSecondary(sAuth);
    await logActivity(user.uid, "admin", "reset_" + role, `${oldData[idField]} -> ${newId}`);
    showCredentialsModal(role === "teacher" ? "Teacher" : "Student", oldData.fullName, newId, newPasscode);
    if (refreshFn) refreshFn();
  } catch (err) {
    console.error(err);
    toast(err.message, "error");
  }
}


async function renderTeachers() {
  main.innerHTML = `<div class="skeleton" style="height:220px;"></div>`;
  const coursesSnap = await getDocs(collection(db, COL.courses));
  const courseCheckboxes = coursesSnap.docs.map(d =>
    `<label style="display:block;padding:6px 0;">
       <input type="checkbox" class="t-course-check" value="${d.id}"> ${d.data().code} — ${d.data().title}
     </label>`
  ).join("");

  main.innerHTML = `
    <h2><i class="fa-solid fa-chalkboard-user"></i> Teachers</h2>
    <div class="glass-card" style="margin-bottom:20px;">
      <h4>Create New Teacher</h4>
      <form id="teacher-form" class="row g-2">
        <div class="col-md-6 form-field"><label>Full Name</label><input required id="t-name" type="text"></div>
        <div class="col-md-6 form-field"><label>Email (for notifications)</label><input required id="t-email" type="email"></div>
        <div class="col-12 form-field">
          <label>Assign Course(s)</label>
          <div style="margin-bottom:6px;">
            <button type="button" class="btn-outline" id="t-select-all" style="padding:5px 14px;font-size:.82rem;">Select All Courses</button>
            <button type="button" class="btn-outline" id="t-select-none" style="padding:5px 14px;font-size:.82rem;">Clear</button>
          </div>
          <div style="max-height:220px;overflow-y:auto;border:1px solid #d8dde8;border-radius:10px;padding:10px 14px;background:#fff;">
            ${courseCheckboxes}
          </div>
        </div>
        <div class="col-12"><button class="btn-gold" type="submit"><i class="fa-solid fa-user-plus"></i> Generate ID & Create Teacher</button></div>
      </form>
    </div>
    <div class="glass-card">
      <input id="teacher-search" type="text" placeholder="Search teachers by name, ID, or email…" style="width:100%;max-width:340px;padding:9px 12px;border-radius:10px;border:1.5px solid #d8dde8;margin-bottom:14px;">
      <div id="teacher-table-wrap">Loading…</div>
    </div>
    <div id="teacher-courses-modal"></div>`;

  bindTableSearch("teacher-search", "teacher-table-wrap");

  document.getElementById("t-select-all").onclick = () => document.querySelectorAll(".t-course-check").forEach(c => c.checked = true);
  document.getElementById("t-select-none").onclick = () => document.querySelectorAll(".t-course-check").forEach(c => c.checked = false);

  document.getElementById("teacher-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("t-name").value;
    const email = document.getElementById("t-email").value;
    const courseIds = Array.from(document.querySelectorAll(".t-course-check:checked")).map(c => c.value);
    if (!courseIds.length) { toast("Select at least one course for this teacher.", "error"); return; }
    const teacherId = generateId("TCH");
    const passcode = generatePasscode();
    try {
      const sAuth = secondaryAuth();
      const cred = await createUserWithEmailAndPassword(sAuth, `${teacherId.toLowerCase()}@cacgw.app`, passcode);
      await setDoc(doc(db, COL.teachers, cred.user.uid), {
        fullName: name, email, teacherId, courseIds, active: true,
        createdAt: serverTimestamp()
      });
      for (const cid of courseIds) await updateDoc(doc(db, COL.courses, cid), { teacherId: cred.user.uid });
      await signOutSecondary(sAuth);
      await logActivity(user.uid, "admin", "create_teacher", teacherId);
      showCredentialsModal("Teacher", name, teacherId, passcode);
      e.target.reset();
      loadTeacherTable();
    } catch (err) { console.error(err); toast(err.message, "error"); }
  });

  loadTeacherTable();
}

async function loadTeacherTable() {
  const wrap = document.getElementById("teacher-table-wrap");
  const [snap, coursesSnap] = await Promise.all([getDocs(collection(db, COL.teachers)), getDocs(collection(db, COL.courses))]);
  if (snap.empty) { wrap.innerHTML = "<p>No teachers yet.</p>"; return; }
  const courseMap = {}; coursesSnap.forEach(d => courseMap[d.id] = d.data().code);
  let rows = "";
  snap.forEach(d => {
    const t = d.data();
    const ids = t.courseIds || (t.courseId ? [t.courseId] : []); // backward-compatible with older single-course records
    const courseLabel = ids.length ? ids.map(id => courseMap[id] || id).join(", ") : "None";
    rows += `<tr>
      <td>${t.teacherId || "—"}</td><td>${t.fullName}</td><td>${t.email || ""}</td>
      <td style="max-width:220px;">${courseLabel}</td>
      <td><span class="badge ${t.active === false ? "inactive" : "active"}">${t.active === false ? "Inactive" : "Active"}</span></td>
      <td>
        <button class="btn-outline" data-act="courses" data-id="${d.id}"><i class="fa-solid fa-book"></i> Courses</button>
        <button class="btn-outline" data-act="toggle" data-id="${d.id}" data-state="${t.active}">${t.active === false ? "Activate" : "Deactivate"}</button>
        <button class="btn-navy" data-act="reset" data-id="${d.id}"><i class="fa-solid fa-key"></i> Reset Login</button>
        <button class="btn-danger" data-act="delete" data-id="${d.id}">Delete</button>
      </td></tr>`;
  });
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Courses</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll("[data-act=toggle]").forEach(b => b.onclick = async () => {
    await updateDoc(doc(db, COL.teachers, b.dataset.id), { active: !(b.dataset.state === "true") });
    toast("Status updated", "success"); loadTeacherTable();
  });
  wrap.querySelectorAll("[data-act=reset]").forEach(b => b.onclick = () => resetCredentials("teacher", b.dataset.id, loadTeacherTable));
  wrap.querySelectorAll("[data-act=courses]").forEach(b => b.onclick = () => openTeacherCoursesEditor(b.dataset.id));
  wrap.querySelectorAll("[data-act=delete]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this teacher record? (Auth account must be removed separately in Firebase console)")) return;
    await deleteDoc(doc(db, COL.teachers, b.dataset.id));
    toast("Teacher deleted", "success"); loadTeacherTable();
  });
}

/* ============================== STUDENTS ============================== */
async function renderStudents() {
  main.innerHTML = `<div class="skeleton" style="height:220px;"></div>`;
  const coursesSnap = await getDocs(collection(db, COL.courses));
  const courseCheckboxes = coursesSnap.docs.map(d =>
    `<label style="display:block;padding:6px 0;">
       <input type="checkbox" class="s-course-check" value="${d.id}"> ${d.data().code} — ${d.data().title}
     </label>`
  ).join("");

  main.innerHTML = `
    <h2><i class="fa-solid fa-user-graduate"></i> Students</h2>
    <div class="glass-card" style="margin-bottom:20px;">
      <h4>Create New Student</h4>
      <form id="student-form" class="row g-2">
        <div class="col-md-6 form-field"><label>Full Name</label><input required id="s-name" type="text"></div>
        <div class="col-md-6 form-field"><label>Email (for notifications)</label><input required id="s-email" type="email"></div>
        <div class="col-12 form-field">
          <label>Enroll in Course(s)</label>
          <div style="margin-bottom:6px;">
            <button type="button" class="btn-outline" id="s-select-all" style="padding:5px 14px;font-size:.82rem;">Select All Courses</button>
            <button type="button" class="btn-outline" id="s-select-none" style="padding:5px 14px;font-size:.82rem;">Clear</button>
          </div>
          <div style="max-height:220px;overflow-y:auto;border:1px solid #d8dde8;border-radius:10px;padding:10px 14px;background:#fff;">
            ${courseCheckboxes}
          </div>
        </div>
        <div class="col-12"><button class="btn-gold" type="submit"><i class="fa-solid fa-user-plus"></i> Generate ID & Create Student</button></div>
      </form>
    </div>
    <div class="glass-card">
      <input id="student-search" type="text" placeholder="Search students by name, ID, or email…" style="width:100%;max-width:340px;padding:9px 12px;border-radius:10px;border:1.5px solid #d8dde8;margin-bottom:14px;">
      <div id="student-table-wrap">Loading…</div>
    </div>
    <div id="student-courses-modal"></div>`;

  bindTableSearch("student-search", "student-table-wrap");

  document.getElementById("s-select-all").onclick = () => document.querySelectorAll(".s-course-check").forEach(c => c.checked = true);
  document.getElementById("s-select-none").onclick = () => document.querySelectorAll(".s-course-check").forEach(c => c.checked = false);

  document.getElementById("student-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("s-name").value;
    const email = document.getElementById("s-email").value;
    const courseIds = Array.from(document.querySelectorAll(".s-course-check:checked")).map(c => c.value);
    if (!courseIds.length) { toast("Select at least one course for this student.", "error"); return; }
    const studentId = generateId("STU");
    const passcode = generatePasscode();
    try {
      const sAuth = secondaryAuth();
      const cred = await createUserWithEmailAndPassword(sAuth, `${studentId.toLowerCase()}@cacgw.app`, passcode);
      await setDoc(doc(db, COL.students, cred.user.uid), {
        fullName: name, email, studentId, courseIds, active: true,
        createdAt: serverTimestamp(), progress: {}
      });
      await signOutSecondary(sAuth);
      await logActivity(user.uid, "admin", "create_student", studentId);
      showCredentialsModal("Student", name, studentId, passcode);
      e.target.reset();
      loadStudentTable();
    } catch (err) { console.error(err); toast(err.message, "error"); }
  });

  loadStudentTable();
}

async function loadStudentTable() {
  const wrap = document.getElementById("student-table-wrap");
  const [snap, coursesSnap] = await Promise.all([getDocs(collection(db, COL.students)), getDocs(collection(db, COL.courses))]);
  if (snap.empty) { wrap.innerHTML = "<p>No students yet.</p>"; return; }
  const courseMap = {}; coursesSnap.forEach(d => courseMap[d.id] = d.data().code);
  let rows = "";
  snap.forEach(d => {
    const s = d.data();
    const ids = s.courseIds || (s.courseId ? [s.courseId] : []); // backward-compatible with older single-course records
    const courseLabel = ids.length ? ids.map(id => courseMap[id] || id).join(", ") : "None";
    rows += `<tr>
      <td>${s.studentId || "—"}</td><td>${s.fullName}</td><td>${s.email || ""}</td>
      <td style="max-width:220px;">${courseLabel}</td>
      <td><span class="badge ${s.active === false ? "inactive" : "active"}">${s.active === false ? "Inactive" : "Active"}</span></td>
      <td>
        <button class="btn-outline" data-act="progress" data-id="${d.id}"><i class="fa-solid fa-chart-line"></i> Progress</button>
        <button class="btn-outline" data-act="courses" data-id="${d.id}"><i class="fa-solid fa-book"></i> Courses</button>
        <button class="btn-outline" data-act="toggle" data-id="${d.id}" data-state="${s.active}">${s.active === false ? "Activate" : "Deactivate"}</button>
        <button class="btn-navy" data-act="reset" data-id="${d.id}"><i class="fa-solid fa-key"></i> Reset Login</button>
        <button class="btn-danger" data-act="delete" data-id="${d.id}">Delete</button>
      </td></tr>`;
  });
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Courses</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
    <div id="student-progress-panel"></div>`;
  wrap.querySelectorAll("[data-act=progress]").forEach(b => b.onclick = () => openStudentProgress(b.dataset.id));
  wrap.querySelectorAll("[data-act=toggle]").forEach(b => b.onclick = async () => {
    await updateDoc(doc(db, COL.students, b.dataset.id), { active: !(b.dataset.state === "true") });
    toast("Status updated", "success"); loadStudentTable();
  });
  wrap.querySelectorAll("[data-act=reset]").forEach(b => b.onclick = () => resetCredentials("student", b.dataset.id, loadStudentTable));
  wrap.querySelectorAll("[data-act=courses]").forEach(b => b.onclick = () => openStudentCoursesEditor(b.dataset.id));
  wrap.querySelectorAll("[data-act=delete]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this student record?")) return;
    await deleteDoc(doc(db, COL.students, b.dataset.id));
    toast("Student deleted", "success"); loadStudentTable();
  });
}

/* ---------- View a student's per-course progress: attendance, exam result,
   certificate eligibility. Read-only overview for the Admin. ---------- */
async function openStudentProgress(studentDocId) {
  const panel = document.getElementById("student-progress-panel");
  panel.innerHTML = `<div class="glass-card" style="margin-top:20px;">Loading progress…</div>`;
  panel.scrollIntoView({ behavior: "smooth" });
  try {
    const sSnap = await getDoc(doc(db, COL.students, studentDocId));
    const s = sSnap.data();
    const courseIds = s.courseIds || (s.courseId ? [s.courseId] : []);
    if (!courseIds.length) { panel.innerHTML = `<div class="glass-card" style="margin-top:20px;">${s.fullName} isn't enrolled in any course yet.</div>`; return; }

    const coursesSnap = await getDocs(collection(db, COL.courses));
    const courseMap = {}; coursesSnap.forEach(d => courseMap[d.id] = d.data());

    const [attSnap, resultsSnap] = await Promise.all([
      getDocs(query(collection(db, COL.attendance), where("studentId", "==", s.studentId))),
      getDocs(query(collection(db, COL.results), where("studentUid", "==", studentDocId)))
    ]);
    const attCountByCourse = {};
    attSnap.forEach(d => { const a = d.data(); attCountByCourse[a.courseId] = (attCountByCourse[a.courseId] || 0) + 1; });
    const resultByCourse = {};
    resultsSnap.forEach(d => { const r = d.data(); resultByCourse[r.courseId] = r; });

    let rows = "";
    courseIds.forEach(cid => {
      const c = courseMap[cid];
      const att = attCountByCourse[cid] || 0;
      const r = resultByCourse[cid];
      const resultLabel = r
        ? `${r.score}/${r.total} (${r.percent}%) — Grade ${r.grade}${r.needsManualGrading ? ' <span class="badge inactive">Theory pending</span>' : ""}`
        : "Not attempted";
      const certLabel = r && !r.needsManualGrading && r.percent >= 50
        ? '<span class="badge active">Eligible</span>'
        : '<span class="badge inactive">Not yet</span>';
      rows += `<tr><td>${c ? c.code + " — " + c.title : cid}</td><td>${att}</td><td>${resultLabel}</td><td>${certLabel}</td></tr>`;
    });

    panel.innerHTML = `<div class="glass-card" style="margin-top:20px;">
      <h4><i class="fa-solid fa-chart-line"></i> Progress — ${s.fullName} (${s.studentId})</h4>
      <table class="data-table"><thead><tr><th>Course</th><th>Attendance</th><th>Exam Result</th><th>Certificate</th></tr></thead><tbody>${rows}</tbody></table>
      <button class="btn-outline" id="progress-close" style="margin-top:12px;">Close</button>
    </div>`;
    document.getElementById("progress-close").onclick = () => panel.innerHTML = "";
  } catch (err) {
    panel.innerHTML = `<div class="glass-card" style="margin-top:20px;color:var(--danger);">Could not load progress: ${err.message}</div>`;
  }
}


/* ---------- Edit an existing teacher's assigned course list — keeps each
   course's teacherId in sync (cleared if unassigned, set if newly assigned) ---------- */
async function openTeacherCoursesEditor(teacherDocId) {
  const [tSnap, coursesSnap] = await Promise.all([getDoc(doc(db, COL.teachers, teacherDocId)), getDocs(collection(db, COL.courses))]);
  const t = tSnap.data();
  const currentIds = new Set(t.courseIds || (t.courseId ? [t.courseId] : []));
  const modalWrap = document.getElementById("teacher-courses-modal");
  const checkboxes = coursesSnap.docs.map(d =>
    `<label style="display:block;padding:6px 0;">
       <input type="checkbox" class="tedit-course-check" value="${d.id}" ${currentIds.has(d.id) ? "checked" : ""}> ${d.data().code} — ${d.data().title}
       ${d.data().teacherId && d.data().teacherId !== teacherDocId ? '<span class="badge inactive" style="margin-left:6px;">Assigned to another teacher</span>' : ""}
     </label>`
  ).join("");
  modalWrap.innerHTML = `
    <div class="glass-card" style="margin-top:20px;max-width:520px;">
      <h4><i class="fa-solid fa-book"></i> Courses for ${t.fullName}</h4>
      <p style="color:var(--muted);font-size:.85rem;">Checking a course already assigned to someone else will reassign it to this teacher.</p>
      <div style="margin-bottom:6px;">
        <button type="button" class="btn-outline" id="tedit-select-all" style="padding:5px 14px;font-size:.82rem;">Select All Courses</button>
        <button type="button" class="btn-outline" id="tedit-select-none" style="padding:5px 14px;font-size:.82rem;">Clear</button>
      </div>
      <div style="max-height:220px;overflow-y:auto;border:1px solid #d8dde8;border-radius:10px;padding:10px 14px;background:#fff;">
        ${checkboxes}
      </div>
      <button class="btn-gold" id="tcourses-save" style="margin-top:12px;">Save</button>
      <button class="btn-outline" id="tcourses-cancel">Cancel</button>
    </div>`;
  modalWrap.scrollIntoView({ behavior: "smooth" });
  document.getElementById("tedit-select-all").onclick = () => document.querySelectorAll(".tedit-course-check").forEach(c => c.checked = true);
  document.getElementById("tedit-select-none").onclick = () => document.querySelectorAll(".tedit-course-check").forEach(c => c.checked = false);
  document.getElementById("tcourses-cancel").onclick = () => modalWrap.innerHTML = "";
  document.getElementById("tcourses-save").onclick = async () => {
    const newIds = Array.from(document.querySelectorAll(".tedit-course-check:checked")).map(c => c.value);
    if (!newIds.length) { toast("Select at least one course.", "error"); return; }
    // Clear teacherId from courses that were removed from this teacher's list
    for (const oldId of currentIds) {
      if (!newIds.includes(oldId)) await updateDoc(doc(db, COL.courses, oldId), { teacherId: "" });
    }
    // Assign this teacher to every currently-checked course
    for (const newId of newIds) await updateDoc(doc(db, COL.courses, newId), { teacherId: teacherDocId });
    await updateDoc(doc(db, COL.teachers, teacherDocId), { courseIds: newIds });
    await logActivity(user.uid, "admin", "edit_teacher_courses", `${t.teacherId}: ${newIds.join(", ")}`);
    toast("Courses updated", "success");
    modalWrap.innerHTML = "";
    loadTeacherTable();
  };
}


/* ---------- Edit an existing student's enrolled course list ---------- */
async function openStudentCoursesEditor(studentDocId) {
  const [sSnap, coursesSnap] = await Promise.all([getDoc(doc(db, COL.students, studentDocId)), getDocs(collection(db, COL.courses))]);
  const s = sSnap.data();
  const currentIds = new Set(s.courseIds || (s.courseId ? [s.courseId] : []));
  const modalWrap = document.getElementById("student-courses-modal");
  const checkboxes = coursesSnap.docs.map(d =>
    `<label style="display:block;padding:6px 0;">
       <input type="checkbox" class="edit-course-check" value="${d.id}" ${currentIds.has(d.id) ? "checked" : ""}> ${d.data().code} — ${d.data().title}
     </label>`
  ).join("");
  modalWrap.innerHTML = `
    <div class="glass-card" style="margin-top:20px;max-width:480px;">
      <h4><i class="fa-solid fa-book"></i> Courses for ${s.fullName}</h4>
      <div style="margin-bottom:6px;">
        <button type="button" class="btn-outline" id="edit-select-all" style="padding:5px 14px;font-size:.82rem;">Select All Courses</button>
        <button type="button" class="btn-outline" id="edit-select-none" style="padding:5px 14px;font-size:.82rem;">Clear</button>
      </div>
      <div style="max-height:220px;overflow-y:auto;border:1px solid #d8dde8;border-radius:10px;padding:10px 14px;background:#fff;">
        ${checkboxes}
      </div>
      <button class="btn-gold" id="courses-save" style="margin-top:12px;">Save</button>
      <button class="btn-outline" id="courses-cancel">Cancel</button>
    </div>`;
  modalWrap.scrollIntoView({ behavior: "smooth" });
  document.getElementById("edit-select-all").onclick = () => document.querySelectorAll(".edit-course-check").forEach(c => c.checked = true);
  document.getElementById("edit-select-none").onclick = () => document.querySelectorAll(".edit-course-check").forEach(c => c.checked = false);
  document.getElementById("courses-cancel").onclick = () => modalWrap.innerHTML = "";
  document.getElementById("courses-save").onclick = async () => {
    const courseIds = Array.from(document.querySelectorAll(".edit-course-check:checked")).map(c => c.value);
    if (!courseIds.length) { toast("Select at least one course.", "error"); return; }
    await updateDoc(doc(db, COL.students, studentDocId), { courseIds });
    await logActivity(user.uid, "admin", "edit_student_courses", `${s.studentId}: ${courseIds.join(", ")}`);
    toast("Courses updated", "success");
    modalWrap.innerHTML = "";
    loadStudentTable();
  };
}

/* ============================== COURSES ============================== */
async function renderCourses() {
  main.innerHTML = `<div class="skeleton" style="height:220px;"></div>`;
  const [coursesSnap, teachersSnap] = await Promise.all([getDocs(collection(db, COL.courses)), getDocs(collection(db, COL.teachers))]);
  const teacherMap = {}; teachersSnap.forEach(d => teacherMap[d.id] = d.data().fullName);
  let tiles = "";
  coursesSnap.forEach(d => {
    const c = d.data();
    tiles += `<div class="course-tile" style="background:${c.color};position:relative;" data-id="${d.id}">
      <button class="btn-danger" data-del="${d.id}" title="Delete course"
        style="position:absolute;top:8px;right:8px;padding:2px 9px;font-size:.8rem;">
        <i class="fa-solid fa-trash"></i>
      </button>
      <div data-edit="${d.id}" style="cursor:pointer;">
        <h5>${c.code}</h5><div>${c.title}</div>
        <small>${c.teacherId ? "Teacher: " + (teacherMap[c.teacherId] || "Assigned") : "No teacher assigned"}</small>
        <small style="opacity:.75;margin-top:6px;display:block;"><i class="fa-solid fa-pen"></i> Click to edit</small>
      </div>
    </div>`;
  });
  main.innerHTML = `<h2><i class="fa-solid fa-book-bible"></i> Course Catalog</h2>
    <p style="color:var(--muted);">Click a course tile to rename it. Assign teachers from the Teachers tab. Upload materials from Content Uploads.</p>
    <div class="glass-card" style="margin-bottom:20px;">
      <h4>Add New Course</h4>
      <form id="add-course-form" class="row g-2">
        <div class="col-md-4 form-field"><label>Course Code</label><input required id="new-code" type="text" placeholder="e.g. BIB111"></div>
        <div class="col-md-5 form-field"><label>Course Title</label><input required id="new-title" type="text" placeholder="e.g. Prophetic Ministry"></div>
        <div class="col-md-2 form-field"><label>Color</label><input id="new-color" type="color" value="#0b2545" style="width:100%;height:44px;"></div>
        <div class="col-md-1 form-field" style="align-self:end;"><button class="btn-gold w-100" type="submit"><i class="fa-solid fa-plus"></i></button></div>
      </form>
    </div>
    <div class="course-grid">${tiles}</div>
    <div id="course-edit-modal"></div>`;

  document.getElementById("add-course-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("new-code").value.trim();
    const title = document.getElementById("new-title").value.trim();
    const color = document.getElementById("new-color").value;
    if (!code || !title) return;
    const newDoc = await addDoc(collection(db, COL.courses), {
      code, title, color, teacherId: "", studentCount: 0, createdAt: new Date().toISOString()
    });
    await logActivity(user.uid, "admin", "add_course", `${newDoc.id}: ${code} — ${title}`);
    toast("Course added!", "success");
    renderCourses();
  });

  document.querySelectorAll('[data-edit]').forEach(tile => {
    tile.onclick = () => openCourseEditor(tile.dataset.edit);
  });
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      if (!confirm("Delete this course? This does NOT delete its uploaded ebooks/videos/exam questions in Storage — remove those separately if needed.")) return;
      await deleteDoc(doc(db, COL.courses, id));
      await logActivity(user.uid, "admin", "delete_course", id);
      toast("Course deleted", "success");
      renderCourses();
    };
  });
}

async function openCourseEditor(courseId) {
  const cSnap = await getDoc(doc(db, COL.courses, courseId));
  const c = cSnap.data();
  const modalWrap = document.getElementById("course-edit-modal");
  modalWrap.innerHTML = `
    <div class="glass-card" style="margin-top:20px;max-width:480px;">
      <h4><i class="fa-solid fa-pen"></i> Edit Course</h4>
      <div class="form-field"><label>Course Code</label><input id="edit-code" type="text" value="${c.code}"></div>
      <div class="form-field"><label>Course Title</label><input id="edit-title" type="text" value="${c.title}"></div>
      <div class="form-field"><label>Tile Color</label><input id="edit-color" type="color" value="${c.color || "#0b2545"}"></div>
      <button class="btn-gold" id="edit-save">Save Changes</button>
      <button class="btn-outline" id="edit-cancel">Cancel</button>
    </div>`;
  modalWrap.scrollIntoView({ behavior: "smooth" });
  document.getElementById("edit-cancel").onclick = () => modalWrap.innerHTML = "";
  document.getElementById("edit-save").onclick = async () => {
    const code = document.getElementById("edit-code").value.trim();
    const title = document.getElementById("edit-title").value.trim();
    const color = document.getElementById("edit-color").value;
    if (!code || !title) { toast("Course code and title cannot be empty.", "error"); return; }
    await updateDoc(doc(db, COL.courses, courseId), { code, title, color });
    await logActivity(user.uid, "admin", "edit_course", `${courseId}: ${code} — ${title}`);
    toast("Course updated!", "success");
    renderCourses();
  };
}

/* ============================== CONTENT UPLOADS ============================== */
async function renderContent() {
  main.innerHTML = `<div class="skeleton" style="height:220px;"></div>`;
  loadGoogleScripts().catch(() => {}); // warm up Drive sign-in in the background so it's instant when clicked
  const coursesSnap = await getDocs(collection(db, COL.courses));
  const courseOptions = coursesSnap.docs.map(d => `<option value="${d.id}">${d.data().code} — ${d.data().title}</option>`).join("");
  main.innerHTML = `
    <h2><i class="fa-solid fa-cloud-arrow-up"></i> Content Uploads</h2>
    <div class="glass-card">
      <form id="upload-form" class="row g-2">
        <div class="col-md-4 form-field"><label>Course</label><select id="u-course">${courseOptions}</select></div>
        <div class="col-md-4 form-field"><label>Content Type</label>
          <select id="u-type">
            <option value="ebooks">Ebook</option>
            <option value="handbooks">Handbook</option>
            <option value="syllabus">Syllabus</option>
            <option value="audio">Audio Teaching</option>
            <option value="videos">Video</option>
          </select>
        </div>
        <div class="col-md-4 form-field"><label>Title</label><input required id="u-title" type="text"></div>

        <div class="col-12 form-field">
          <label>Save To</label><br>
          <label style="margin-right:16px;"><input type="radio" name="u-dest" value="storage" checked> Firebase Storage (upload from this device)</label>
          <label><input type="radio" name="u-dest" value="drive"> Google Drive (pick an existing file)</label>
        </div>
        <div class="col-md-8 form-field" id="storage-file-field"><label>File</label><input id="u-file" type="file"></div>
        <div class="col-md-8 form-field" id="drive-file-field" style="display:none;">
          <button type="button" class="btn-outline" id="u-drive-pick"><i class="fa-brands fa-google-drive"></i> Choose from Google Drive</button>
          <span id="u-drive-chosen" style="margin-left:10px;color:var(--muted);"></span>
        </div>

        <div class="col-md-4 form-field" style="align-self:end;"><button class="btn-gold w-100" type="submit"><i class="fa-solid fa-upload"></i> Save</button></div>
      </form>
      <div id="upload-progress" style="margin-top:10px;"></div>
    </div>
    <div class="glass-card" style="margin-top:20px;">
      <h4>Existing Content</h4>
      <div class="row g-2" style="margin-bottom:12px;">
        <div class="col-md-6 form-field"><label>Filter by Course</label><select id="cl-course">${courseOptions}</select></div>
        <div class="col-md-6 form-field"><label>Filter by Type</label>
          <select id="cl-type">
            <option value="ebooks">Ebooks</option>
            <option value="handbooks">Handbooks</option>
            <option value="syllabus">Syllabus</option>
            <option value="audio">Audio Teachings</option>
            <option value="videos">Videos</option>
          </select>
        </div>
      </div>
      <div id="content-list">Loading…</div>
    </div>`;

  let pickedDriveFile = null;
  document.querySelectorAll('input[name="u-dest"]').forEach(r => r.onchange = () => {
    const isDrive = document.querySelector('input[name="u-dest"]:checked').value === "drive";
    document.getElementById("storage-file-field").style.display = isDrive ? "none" : "block";
    document.getElementById("drive-file-field").style.display = isDrive ? "block" : "none";
  });
  document.getElementById("u-drive-pick").onclick = async () => {
    try {
      const file = await openDrivePicker();
      if (file) { pickedDriveFile = file; document.getElementById("u-drive-chosen").textContent = `Selected: ${file.name}`; }
    } catch (err) { toast("Could not connect to Google Drive: " + err.message, "error"); }
  };

  document.getElementById("upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const courseId = document.getElementById("u-course").value;
    const type = document.getElementById("u-type").value;
    const title = document.getElementById("u-title").value;
    const dest = document.querySelector('input[name="u-dest"]:checked').value;
    const prog = document.getElementById("upload-progress");

    if (dest === "storage") {
      const file = document.getElementById("u-file").files[0];
      if (!file) { toast("Choose a file first.", "error"); return; }
      const path = `${type}/${courseId}/${Date.now()}_${file.name}`;
      const sref = ref(storage, path);
      const task = uploadBytesResumable(sref, file);
      task.on("state_changed", (snap) => {
        const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
        prog.innerHTML = `<div class="skeleton" style="height:10px;width:${pct}%;"></div><small>${pct}%</small>`;
      }, (err) => toast(err.message, "error"), async () => {
        const url = await getDownloadURL(sref);
        await addDoc(collection(db, COL[type]), { courseId, title, url, path, source: "storage", uploadedAt: serverTimestamp(), uploadedBy: "admin" });
        await logActivity(user.uid, "admin", "upload_" + type, title);
        toast("Uploaded to Firebase Storage", "success");
        prog.innerHTML = ""; e.target.reset(); pickedDriveFile = null;
        document.getElementById("cl-course").value = courseId;
        document.getElementById("cl-type").value = type;
        loadContentList();
      });
    } else {
      if (!pickedDriveFile) { toast("Choose a file from Google Drive first.", "error"); return; }
      prog.innerHTML = "Step 1 of 3: Making the file link-shareable…";
      try {
        await makeFilePublic(pickedDriveFile.id);
        prog.innerHTML = "Step 2 of 3: Confirming it's publicly reachable…";
        await verifyPublicAccess(pickedDriveFile.id);
        prog.innerHTML = "Step 3 of 3: Saving to the course…";
        await addDoc(collection(db, COL[type]), {
          courseId, title, url: driveFileViewUrl(pickedDriveFile.id), driveFileId: pickedDriveFile.id,
          source: "drive", uploadedAt: serverTimestamp(), uploadedBy: "admin"
        });
        await logActivity(user.uid, "admin", "link_drive_" + type, title);
        toast("Linked from Google Drive", "success");
        prog.innerHTML = ""; e.target.reset(); pickedDriveFile = null;
        document.getElementById("u-drive-chosen").textContent = "";
        document.getElementById("cl-course").value = courseId;
        document.getElementById("cl-type").value = type;
        loadContentList();
      } catch (err) {
        toast(err.message, "error");
        prog.innerHTML = `<p style="color:var(--danger);border:1px solid var(--danger);border-radius:10px;padding:10px 14px;">
          <i class="fa-solid fa-triangle-exclamation"></i> ${err.message}</p>`;
      }
    }
  });

  document.getElementById("cl-course").onchange = loadContentList;
  document.getElementById("cl-type").onchange = loadContentList;
  // Default the filters to whatever the upload form is set to, for convenience
  document.getElementById("cl-course").value = document.getElementById("u-course").value;
  document.getElementById("cl-type").value = document.getElementById("u-type").value;
  loadContentList();
}

async function loadContentList() {
  const wrap = document.getElementById("content-list");
  if (!wrap) return;
  wrap.innerHTML = "Loading…";
  const courseId = document.getElementById("cl-course").value;
  const type = document.getElementById("cl-type").value;
  let snap;
  try {
    snap = await getDocs(query(collection(db, COL[type]), where("courseId", "==", courseId)));
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--danger);">Could not load this list: ${err.message}</p>
      <button class="btn-outline" id="cl-retry">Retry</button>`;
    document.getElementById("cl-retry").onclick = loadContentList;
    return;
  }
  if (snap.empty) { wrap.innerHTML = "<p>Nothing uploaded here yet for this course/type.</p>"; return; }
  let rows = "";
  snap.forEach(d => {
    const item = d.data();
    const badge = item.source === "drive"
      ? '<span class="badge active"><i class="fa-brands fa-google-drive"></i> Drive</span>'
      : '<span class="badge active">Firebase Storage</span>';
    rows += `<tr><td>${item.title}</td><td>${badge}</td>
      <td><a class="btn-outline" href="${item.url}" target="_blank" rel="noopener"><i class="fa-solid fa-eye"></i> Open</a>
      <button class="btn-danger" data-id="${d.id}" data-type="${type}">Delete</button></td></tr>`;
  });
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>Title</th><th>Source</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll("button[data-id]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this item? This removes it from the college's content — it does not delete the underlying file from Firebase Storage or Google Drive itself.")) return;
    try {
      await deleteDoc(doc(db, COL[b.dataset.type], b.dataset.id));
      await logActivity(user.uid, "admin", "delete_content_" + b.dataset.type, b.dataset.id);
      toast("Deleted", "success");
      loadContentList();
    } catch (err) {
      toast("Could not delete: " + err.message, "error");
    }
  });
}

/* ============================== EXAM QUESTIONS ============================== */
async function renderExams() {
  main.innerHTML = `<div class="skeleton" style="height:220px;"></div>`;
  const coursesSnap = await getDocs(collection(db, COL.courses));
  const courseOptions = coursesSnap.docs.map(d => `<option value="${d.id}">${d.data().code} — ${d.data().title}</option>`).join("");
  main.innerHTML = `
    <h2><i class="fa-solid fa-file-pen"></i> Exam Questions</h2>
    <div class="glass-card">
      <form id="exam-form">
        <div class="row g-2">
          <div class="col-md-4 form-field"><label>Course</label><select id="e-course">${courseOptions}</select></div>
          <div class="col-md-4 form-field"><label>Question Type</label>
            <select id="e-type"><option value="objective">Objective</option><option value="theory">Theory</option></select></div>
          <div class="col-md-4 form-field"><label>Language</label>
            <select id="e-lang"><option value="english">English</option><option value="yoruba">Yoruba</option></select></div>
        </div>
        <div class="form-field"><label>Question</label><textarea id="e-question" required rows="2"></textarea></div>
        <div class="row g-2" id="options-wrap">
          <div class="col-md-3 form-field"><label>Option A</label><input id="e-a" type="text"></div>
          <div class="col-md-3 form-field"><label>Option B</label><input id="e-b" type="text"></div>
          <div class="col-md-3 form-field"><label>Option C</label><input id="e-c" type="text"></div>
          <div class="col-md-3 form-field"><label>Option D</label><input id="e-d" type="text"></div>
        </div>
        <div class="row g-2">
          <div class="col-md-6 form-field"><label>Correct Answer (A/B/C/D, ignored for theory)</label><input id="e-correct" type="text" maxlength="1"></div>
          <div class="col-md-6 form-field"><label>Marks (theory questions only)</label><input id="e-marks" type="number" min="1" value="10"></div>
        </div>
        <button class="btn-gold" type="submit"><i class="fa-solid fa-plus"></i> Add Question</button>
      </form>
    </div>
    <div class="glass-card" style="margin-top:20px;"><div id="exam-list">Loading…</div></div>`;

  document.getElementById("exam-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = {
      courseId: document.getElementById("e-course").value,
      type: document.getElementById("e-type").value,
      language: document.getElementById("e-lang").value,
      question: document.getElementById("e-question").value,
      options: {
        A: document.getElementById("e-a").value, B: document.getElementById("e-b").value,
        C: document.getElementById("e-c").value, D: document.getElementById("e-d").value
      },
      correct: document.getElementById("e-correct").value.toUpperCase(),
      marks: Number(document.getElementById("e-marks").value) || 10,
      createdAt: serverTimestamp()
    };
    await addDoc(collection(db, COL.examQuestions), q);
    toast("Question added", "success");
    e.target.reset();
    loadExamList();
  });
  loadExamList();
}
async function loadExamList() {
  const wrap = document.getElementById("exam-list");
  const snap = await getDocs(collection(db, COL.examQuestions));
  if (snap.empty) { wrap.innerHTML = "<p>No exam questions yet.</p>"; return; }
  let rows = "";
  snap.forEach(d => {
    const q = d.data();
    rows += `<tr><td>${q.question}</td><td>${q.type}</td><td>${q.language}</td><td>${q.type === "theory" ? (q.marks || 10) + " marks" : (q.correct || "—")}</td>
      <td><button class="btn-danger" data-id="${d.id}">Delete</button></td></tr>`;
  });
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>Question</th><th>Type</th><th>Lang</th><th>Answer / Marks</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll("button[data-id]").forEach(b => b.onclick = async () => {
    await deleteDoc(doc(db, COL.examQuestions, b.dataset.id)); loadExamList();
  });
}

/* ============================== ANNOUNCEMENTS ============================== */
async function renderAnnouncements() {
  main.innerHTML = `
    <h2><i class="fa-solid fa-bullhorn"></i> Announcements</h2>
    <div class="glass-card">
      <form id="ann-form">
        <div class="form-field"><label>Title</label><input required id="a-title" type="text"></div>
        <div class="form-field"><label>Message</label><textarea required id="a-message" rows="3"></textarea></div>
        <button class="btn-gold" type="submit"><i class="fa-solid fa-paper-plane"></i> Publish to Everyone</button>
      </form>
    </div>
    <div class="glass-card" style="margin-top:20px;"><div id="ann-list">Loading…</div></div>`;
  document.getElementById("ann-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await addDoc(collection(db, COL.notifications), {
      title: document.getElementById("a-title").value,
      body: document.getElementById("a-message").value,
      audience: "all", createdAt: serverTimestamp()
    });
    toast("Announcement published", "success");
    e.target.reset();
    loadAnnouncements();
  });
  loadAnnouncements();
}
async function loadAnnouncements() {
  const wrap = document.getElementById("ann-list");
  const snap = await getDocs(query(collection(db, COL.notifications), orderBy("createdAt", "desc")));
  let rows = "";
  snap.forEach(d => { const a = d.data(); rows += `<tr><td>${a.title}</td><td>${a.body}</td></tr>`; });
  wrap.innerHTML = snap.empty ? "<p>No announcements yet.</p>" : `<table class="data-table"><thead><tr><th>Title</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ============================== FEEDBACK ============================== */
async function renderFeedback() {
  main.innerHTML = `<h2><i class="fa-solid fa-comments"></i> Feedback</h2><div class="glass-card"><div id="fb-list">Loading…</div></div>`;
  const snap = await getDocs(collection(db, COL.feedback));
  let rows = "";
  snap.forEach(d => { const f = d.data(); rows += `<tr><td>${f.courseId || "—"}</td><td>${f.rating || "—"}★</td><td>${f.comment || ""}</td></tr>`; });
  document.getElementById("fb-list").innerHTML = snap.empty ? "<p>No feedback yet.</p>" : `<table class="data-table"><thead><tr><th>Course</th><th>Rating</th><th>Comment</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ============================== REPORTS / EXPORT ============================== */
async function renderReports() {
  main.innerHTML = `
    <h2><i class="fa-solid fa-chart-column"></i> Reports & Analytics</h2>
    <div class="glass-card">
      <p>Export full platform data for offline record keeping.</p>
      <button class="btn-navy" id="exp-csv"><i class="fa-solid fa-file-csv"></i> Export Students (CSV / Excel)</button>
      <button class="btn-gold" id="exp-pdf"><i class="fa-solid fa-file-pdf"></i> Export Summary (PDF)</button>
    </div>`;
  document.getElementById("exp-csv").onclick = exportStudentsCSV;
  document.getElementById("exp-pdf").onclick = exportSummaryPDF;
}
async function exportStudentsCSV() {
  const snap = await getDocs(collection(db, COL.students));
  let csv = "Student ID,Full Name,Email,Course,Status\n";
  snap.forEach(d => { const s = d.data(); csv += `${s.studentId},${s.fullName},${s.email},${s.courseId},${s.active === false ? "Inactive" : "Active"}\n`; });
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "students.csv"; a.click();
  toast("Exported students.csv", "success");
}
async function exportSummaryPDF() {
  const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/+esm");
  const [teachers, students, courses] = await Promise.all([getDocs(collection(db, COL.teachers)), getDocs(collection(db, COL.students)), getDocs(collection(db, COL.courses))]);
  const pdf = new jsPDF();
  pdf.setFontSize(16); pdf.text("Scholar's Camp", 15, 20);
  pdf.setFontSize(11); pdf.text("Platform Summary Report", 15, 28);
  pdf.text(`Teachers: ${teachers.size}`, 15, 42);
  pdf.text(`Students: ${students.size}`, 15, 50);
  pdf.text(`Courses: ${courses.size}`, 15, 58);
  pdf.text(`Generated: ${new Date().toLocaleString()}`, 15, 70);
  pdf.save("college-summary.pdf");
  toast("PDF report downloaded", "success");
}

/* ============================== ACTIVITY LOGS ============================== */
async function renderLogs() {
  main.innerHTML = `<h2><i class="fa-solid fa-clock-rotate-left"></i> Activity Logs</h2><div class="glass-card"><div id="log-list">Loading…</div></div>`;
  const snap = await getDocs(query(collection(db, COL.activityLogs), orderBy("timestamp", "desc")));
  let rows = "";
  let count = 0;
  snap.forEach(d => {
    if (count++ > 100) return;
    const l = d.data();
    rows += `<tr><td>${l.role}</td><td>${l.action}</td><td>${l.details || ""}</td><td>${l.timestamp?.toDate ? l.timestamp.toDate().toLocaleString() : ""}</td></tr>`;
  });
  document.getElementById("log-list").innerHTML = snap.empty ? "<p>No activity yet.</p>" : `<table class="data-table"><thead><tr><th>Role</th><th>Action</th><th>Details</th><th>When</th></tr></thead><tbody>${rows}</tbody></table>`;
}
