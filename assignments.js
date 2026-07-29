/* ==========================================================================
   ASSIGNMENTS.JS — Free assignment submission system
   --------------------------------------------------------------------------
   Shared by the Teacher and Student portals. Zero extra cost: files are
   uploaded straight to the Firebase Storage bucket you already have (same
   free Spark plan, same mechanism your Materials upload already uses) —
   deliberately NOT the Google Drive integration, since that relies on a
   single shared OAuth app that only pre-approved test users can authorize.
   Every enrolled student is already signed in through Firebase Auth, so
   Storage works for all of them out of the box with no extra setup per
   student.
   ========================================================================== */
import {
  db, storage, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc,
  query, where, orderBy, serverTimestamp, ref, uploadBytesResumable, getDownloadURL
} from "./firebase-config.js";
import { toast } from "./app-shell.js";

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============================== TEACHER ============================== */
export async function renderTeacherAssignments(container, { course, user }) {
  container.innerHTML = `
    <div class="glass-card" style="margin-bottom:16px;">
      <h4><i class="fa-solid fa-square-plus"></i> New Assignment</h4>
      <form id="asg-create-form" class="row g-2">
        <div class="col-md-6 form-field"><label>Title</label><input required id="asg-title" type="text"></div>
        <div class="col-md-6 form-field"><label>Due Date</label><input required id="asg-due" type="date"></div>
        <div class="col-12 form-field"><label>Instructions</label><textarea id="asg-desc" rows="2"></textarea></div>
        <div class="col-12"><button class="btn-gold" type="submit"><i class="fa-solid fa-paper-plane"></i> Post Assignment</button></div>
      </form>
    </div>
    <div id="asg-teacher-list">Loading…</div>`;

  document.getElementById("asg-create-form").onsubmit = async (e) => {
    e.preventDefault();
    const title = document.getElementById("asg-title").value.trim();
    const dueDate = document.getElementById("asg-due").value;
    const description = document.getElementById("asg-desc").value.trim();
    if (!title || !dueDate) return;
    await addDoc(collection(db, "assignments"), {
      courseId: course.id, teacherId: user.uid, title, description, dueDate, createdAt: serverTimestamp()
    });
    toast("Assignment posted.", "success");
    e.target.reset();
    loadTeacherAssignmentList(course.id);
  };

  loadTeacherAssignmentList(course.id);
}

async function loadTeacherAssignmentList(courseId) {
  const wrap = document.getElementById("asg-teacher-list");
  if (!wrap) return;
  wrap.innerHTML = "Loading…";
  const snap = await getDocs(query(collection(db, "assignments"), where("courseId", "==", courseId)));
  if (snap.empty) { wrap.innerHTML = "<p style='color:var(--muted);'>No assignments posted for this course yet.</p>"; return; }

  const assignments = [];
  snap.forEach(d => assignments.push({ id: d.id, ...d.data() }));
  assignments.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));

  wrap.innerHTML = assignments.map(a => `
    <div class="glass-card" style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>${escapeHtml(a.title)}</strong>
          <div style="color:var(--muted);font-size:.85rem;">Due ${escapeHtml(a.dueDate || "—")}</div>
        </div>
        <button class="btn-outline" data-asg="${a.id}" type="button"><i class="fa-solid fa-eye"></i> View Submissions</button>
      </div>
      <p style="margin:10px 0 0;">${escapeHtml(a.description || "")}</p>
      <div id="asg-subs-${a.id}" style="display:none;margin-top:12px;border-top:1px solid #eef1f7;padding-top:12px;"></div>
    </div>`).join("");

  wrap.querySelectorAll("[data-asg]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.asg;
      const panel = document.getElementById(`asg-subs-${id}`);
      const showing = panel.style.display !== "none";
      panel.style.display = showing ? "none" : "block";
      if (!showing) await loadSubmissionsForAssignment(id, panel);
    };
  });
}

async function loadSubmissionsForAssignment(assignmentId, panel) {
  panel.innerHTML = "Loading submissions…";
  const snap = await getDocs(query(collection(db, "assignmentSubmissions"), where("assignmentId", "==", assignmentId)));
  if (snap.empty) { panel.innerHTML = "<p style='color:var(--muted);'>No submissions yet.</p>"; return; }
  const subs = [];
  snap.forEach(d => subs.push({ id: d.id, ...d.data() }));
  panel.innerHTML = subs.map(s => `
    <div style="padding:10px 0;border-bottom:1px solid #eef1f7;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center;">
        <div>
          <strong>${escapeHtml(s.studentName || s.studentId || "Student")}</strong>
          <span style="color:var(--muted);font-size:.82rem;"> — ${escapeHtml(s.fileName || "file")}</span>
          ${s.method === "drive_link" ? ' <span class="badge active"><i class="fa-brands fa-google-drive"></i> Drive link</span>' : ""}
        </div>
        <a class="btn-outline" href="${s.fileUrl}" target="_blank" rel="noopener">${s.method === "drive_link" ? '<i class="fa-solid fa-arrow-up-right-from-square"></i> Open' : '<i class="fa-solid fa-download"></i> Download'}</a>
      </div>
      <div class="row g-2" style="margin-top:8px;">
        <div class="col-md-3 form-field"><label>Grade</label><input type="text" class="asg-grade-input" data-sub="${s.id}" value="${escapeHtml(s.grade || "")}" placeholder="e.g. 85%"></div>
        <div class="col-md-7 form-field"><label>Feedback</label><input type="text" class="asg-feedback-input" data-sub="${s.id}" value="${escapeHtml(s.feedback || "")}"></div>
        <div class="col-md-2" style="display:flex;align-items:flex-end;">
          <button class="btn-navy asg-save-grade" data-sub="${s.id}" type="button" style="width:100%;">Save</button>
        </div>
      </div>
    </div>`).join("");

  panel.querySelectorAll(".asg-save-grade").forEach(btn => {
    btn.onclick = async () => {
      const subId = btn.dataset.sub;
      const grade = panel.querySelector(`.asg-grade-input[data-sub="${subId}"]`).value.trim();
      const feedback = panel.querySelector(`.asg-feedback-input[data-sub="${subId}"]`).value.trim();
      await updateDoc(doc(db, "assignmentSubmissions", subId), { grade, feedback });
      toast("Saved.", "success");
    };
  });
}

/* ============================== STUDENT ============================== */
function submitControlsHtml(assignmentId, isReplace) {
  return `
    <div class="asg-submit-tabs" style="margin-bottom:8px;display:flex;gap:6px;">
      <button type="button" class="btn-outline asg-mode-btn active" data-mode="upload" data-asg="${assignmentId}"><i class="fa-solid fa-upload"></i> Upload File</button>
      <button type="button" class="btn-outline asg-mode-btn" data-mode="link" data-asg="${assignmentId}"><i class="fa-brands fa-google-drive"></i> Paste Drive Link</button>
    </div>
    <div class="asg-mode-panel" data-mode="upload" data-asg="${assignmentId}">
      <input type="file" class="asg-file-input" data-asg="${assignmentId}" style="max-width:260px;display:inline-block;">
      <button class="${isReplace ? "btn-outline" : "btn-gold"} asg-submit-btn" data-asg="${assignmentId}" type="button"><i class="fa-solid fa-upload"></i> ${isReplace ? "Replace Submission" : "Submit"}</button>
    </div>
    <div class="asg-mode-panel" data-mode="link" data-asg="${assignmentId}" style="display:none;">
      <input type="url" class="asg-link-input" data-asg="${assignmentId}" placeholder="Paste your Google Drive share link…" style="width:100%;max-width:320px;padding:8px 10px;border-radius:8px;border:1.5px solid #d8dde8;">
      <button class="${isReplace ? "btn-outline" : "btn-gold"} asg-submit-link-btn" data-asg="${assignmentId}" type="button" style="margin-top:6px;"><i class="fa-brands fa-google-drive"></i> ${isReplace ? "Replace with Link" : "Submit Link"}</button>
      <p style="color:var(--muted);font-size:.78rem;margin-top:4px;">Set sharing to "Anyone with the link" first, or your teacher won't be able to open it.</p>
    </div>
    <div class="asg-progress" data-asg="${assignmentId}" style="margin-top:6px;"></div>`;
}

export async function renderStudentAssignments(container, { course, user, profile }) {
  container.innerHTML = `<div id="asg-student-list">Loading…</div>`;
  const wrap = document.getElementById("asg-student-list");
  const snap = await getDocs(query(collection(db, "assignments"), where("courseId", "==", course.id)));
  if (snap.empty) { wrap.innerHTML = "<p style='color:var(--muted);'>No assignments posted for this course yet.</p>"; return; }

  const assignments = [];
  snap.forEach(d => assignments.push({ id: d.id, ...d.data() }));
  assignments.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));

  wrap.innerHTML = "";
  for (const a of assignments) {
    const subId = `${a.id}_${user.uid}`;
    const subSnap = await getDoc(doc(db, "assignmentSubmissions", subId));
    const sub = subSnap.exists() ? subSnap.data() : null;

    const card = document.createElement("div");
    card.className = "glass-card";
    card.style.marginBottom = "12px";
    card.innerHTML = `
      <strong>${escapeHtml(a.title)}</strong>
      <div style="color:var(--muted);font-size:.85rem;">Due ${escapeHtml(a.dueDate || "—")}</div>
      <p style="margin:10px 0;">${escapeHtml(a.description || "")}</p>
      ${sub
        ? `<div style="background:var(--bg);border-radius:10px;padding:10px 14px;">
             <i class="fa-solid fa-circle-check" style="color:var(--success);"></i> Submitted: <a href="${sub.fileUrl}" target="_blank" rel="noopener">${escapeHtml(sub.fileName || "your file")}</a>${sub.method === "drive_link" ? ' <span class="badge active"><i class="fa-brands fa-google-drive"></i> Drive link</span>' : ""}
             ${sub.grade ? `<div style="margin-top:6px;"><strong>Grade:</strong> ${escapeHtml(sub.grade)}</div>` : ""}
             ${sub.feedback ? `<div><strong>Feedback:</strong> ${escapeHtml(sub.feedback)}</div>` : ""}
             <div style="margin-top:8px;">${submitControlsHtml(a.id, true)}</div>
           </div>`
        : `<div>${submitControlsHtml(a.id, false)}</div>`}`;
    wrap.appendChild(card);
  }

  wrap.querySelectorAll(".asg-mode-btn").forEach(btn => {
    btn.onclick = () => {
      const assignmentId = btn.dataset.asg;
      wrap.querySelectorAll(`.asg-mode-btn[data-asg="${assignmentId}"]`).forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      wrap.querySelectorAll(`.asg-mode-panel[data-asg="${assignmentId}"]`).forEach(p => {
        p.style.display = p.dataset.mode === btn.dataset.mode ? "" : "none";
      });
    };
  });

  wrap.querySelectorAll(".asg-submit-btn").forEach(btn => {
    btn.onclick = async () => {
      const assignmentId = btn.dataset.asg;
      const fileInput = wrap.querySelector(`.asg-file-input[data-asg="${assignmentId}"]`);
      const file = fileInput.files?.[0];
      if (!file) { toast("Choose a file first.", "error"); return; }
      const progressEl = wrap.querySelector(`.asg-progress[data-asg="${assignmentId}"]`);
      btn.disabled = true;
      const path = `assignmentSubmissions/${course.id}/${assignmentId}/${user.uid}_${Date.now()}_${file.name}`;
      const sref = ref(storage, path);
      const task = uploadBytesResumable(sref, file);
      task.on("state_changed", (s) => {
        const pct = Math.round((s.bytesTransferred / s.totalBytes) * 100);
        progressEl.innerHTML = `<div class="skeleton" style="height:8px;width:${pct}%;"></div><small>${pct}%</small>`;
      }, (err) => {
        toast(err.message, "error");
        btn.disabled = false;
      }, async () => {
        const fileUrl = await getDownloadURL(sref);
        await setDoc(doc(db, "assignmentSubmissions", `${assignmentId}_${user.uid}`), {
          assignmentId, courseId: course.id, studentUid: user.uid,
          studentId: profile.studentId || "", studentName: profile.fullName || "",
          fileUrl, fileName: file.name, method: "upload", submittedAt: serverTimestamp()
        }, { merge: true });
        toast("Assignment submitted.", "success");
        progressEl.innerHTML = "";
        renderStudentAssignments(container, { course, user, profile });
      });
    };
  });

  wrap.querySelectorAll(".asg-submit-link-btn").forEach(btn => {
    btn.onclick = async () => {
      const assignmentId = btn.dataset.asg;
      const linkInput = wrap.querySelector(`.asg-link-input[data-asg="${assignmentId}"]`);
      const link = linkInput.value.trim();
      if (!/^https?:\/\//i.test(link)) { toast("Paste a valid link starting with https://", "error"); return; }
      btn.disabled = true;
      try {
        await setDoc(doc(db, "assignmentSubmissions", `${assignmentId}_${user.uid}`), {
          assignmentId, courseId: course.id, studentUid: user.uid,
          studentId: profile.studentId || "", studentName: profile.fullName || "",
          fileUrl: link, fileName: "Google Drive link", method: "drive_link", submittedAt: serverTimestamp()
        }, { merge: true });
        toast("Assignment submitted.", "success");
        renderStudentAssignments(container, { course, user, profile });
      } catch (e) {
        toast(e.message || "Couldn't save your link.", "error");
        btn.disabled = false;
      }
    };
  });
}
