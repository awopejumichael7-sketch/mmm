/* ==========================================================================
   CONTENT-STUDIO.JS — Exam Centre authoring tool (admin + teacher)
   --------------------------------------------------------------------------
   Four sections:
     Subjects  — add custom subjects on top of the built-in catalog
     Exams     — create/edit exams, add questions (manual or bulk-paste import)
     Textbooks — create/edit books and their Markdown+LaTeX chapters
     Grading   — mark pending theory answers from submitted xcResults

   Everything here writes only to the Exam Centre's own "xc"-prefixed
   collections (see exam-catalog.js's XC map) — the original course/exam
   data admin.js and teacher.js manage is never read or written from here.
   ========================================================================== */
import {
  db, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, serverTimestamp, writeBatch, logActivity
} from "./xc-firebase.js";
import {
  XC, CATEGORIES, CATEGORY_GROUPS, getCategory, subjectsFor, slugify,
  escapeHtml, plural, summarize
} from "./exam-catalog.js";
import { guardRoles } from "./xc-common.js";
import { loadMathEngine, renderRich, isMathEngineReady } from "./math-render.js";
import { parseQuestions } from "./question-import.js";
import { toast, initTheme, toggleTheme } from "./app-shell.js";
import { loadingHtml } from "./ui-states.js";

const $ = (id) => document.getElementById(id);
const main = $("cs-main");
let user, role, engineOK = false;

/* Cache so switching tabs/categories doesn't re-fetch every click. Cleared
   selectively by the mutating functions below whenever they change data. */
const cache = { customSubjects: null, exams: {}, books: {}, chapters: {}, grading: null };

let state = { section: "subjects", cat: "year-5", editingExam: null, editingBook: null };

/* ==========================================================================
   BOOT
   ========================================================================== */
(async function boot() {
  initTheme();
  syncThemeIcon();
  $("cs-theme").addEventListener("click", () => { toggleTheme(); syncThemeIcon(); });

  const ctx = await guardRoles(["admin", "teacher"]);
  user = ctx.user; role = ctx.role;
  $("cs-role-label").textContent = role === "admin" ? "Admin · Exam Centre Studio" : "Teacher · Exam Centre Studio";
  $("cs-exit").href = role === "admin" ? "admin.html" : "teacher.html";

  try { await loadMathEngine(); engineOK = isMathEngineReady(); } catch (e) { console.error("Math engine failed to load", e); }

  renderShell();
})();

function syncThemeIcon() {
  const dark = document.body.getAttribute("data-theme") === "dark";
  const icon = $("cs-theme")?.querySelector("i");
  if (icon) icon.className = dark ? "fa-solid fa-sun" : "fa-solid fa-moon";
}

/* ==========================================================================
   SHELL: section tabs + category chips
   ========================================================================== */
function renderShell() {
  main.innerHTML = `
    <div class="xc-hub" id="cs-root">
      <div class="xc-hero">
        <div>
          <h2><i class="fa-solid fa-toolbox"></i> Exam Centre Studio</h2>
          <p>Create subjects, exams, questions and textbooks for the student Exam Centre. Nothing here touches the original course exams or ebooks.</p>
        </div>
      </div>
      <div class="tab-strip" id="cs-sections" role="tablist">
        <button type="button" data-sec="subjects" role="tab"><i class="fa-solid fa-layer-group"></i> Subjects</button>
        <button type="button" data-sec="exams" role="tab"><i class="fa-solid fa-file-pen"></i> Exams &amp; Questions</button>
        <button type="button" data-sec="books" role="tab"><i class="fa-solid fa-book-open"></i> Textbooks</button>
        <button type="button" data-sec="grading" role="tab"><i class="fa-solid fa-marker"></i> Theory Grading</button>
      </div>
      <div id="cs-cats"></div>
      <div id="cs-body"></div>
    </div>`;

  main.querySelectorAll("#cs-sections button").forEach((b) => {
    b.addEventListener("click", () => {
      state.section = b.dataset.sec;
      state.editingExam = null; state.editingBook = null;
      renderAll();
    });
  });
  renderAll();
}

function renderAll() {
  main.querySelectorAll("#cs-sections button").forEach((b) => b.classList.toggle("active", b.dataset.sec === state.section));
  const needsCat = state.section !== "grading";
  $("cs-cats").innerHTML = needsCat ? catChipsHtml() : "";
  if (needsCat) wireCatChips();

  if (state.section === "subjects") renderSubjects();
  else if (state.section === "exams") renderExams();
  else if (state.section === "books") renderBooks();
  else renderGrading();
}

function catChipsHtml() {
  return `<nav class="xc-cats" aria-label="Category">` +
    CATEGORY_GROUPS.map((g) => {
      const chips = CATEGORIES.filter((c) => c.group === g.id).map((c) => `
        <button type="button" class="xc-chip ${state.cat === c.id ? "active" : ""}" data-cat="${c.id}">
          <i class="fa-solid ${c.icon}"></i><span><b>${escapeHtml(c.label)}</b><small>${escapeHtml(c.sub)}</small></span>
        </button>`).join("");
      return `<div class="xc-cat-group"><div class="xc-cat-group-label">${escapeHtml(g.label)}</div><div class="xc-chips">${chips}</div></div>`;
    }).join("") + `</nav>`;
}
function wireCatChips() {
  $("cs-cats").querySelectorAll(".xc-chip").forEach((b) => {
    b.onclick = () => { state.cat = b.dataset.cat; state.editingExam = null; state.editingBook = null; renderAll(); };
  });
}

function showError(el, err, retry) {
  console.error(err);
  el.innerHTML = `<div class="glass-card xc-error"><i class="fa-solid fa-triangle-exclamation"></i>
    <p>Something went wrong loading this. Please check your connection.</p>
    <button type="button" class="btn-navy" id="cs-retry"><i class="fa-solid fa-rotate-right"></i> Try again</button></div>`;
  $("cs-retry")?.addEventListener("click", retry);
}

/* ==========================================================================
   DATA HELPERS
   ========================================================================== */
async function ensureCustomSubjects() {
  if (cache.customSubjects) return cache.customSubjects;
  const snap = await getDocs(collection(db, XC.subjects));
  return (cache.customSubjects = snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}
async function ensureExams(catId) {
  if (cache.exams[catId]) return cache.exams[catId];
  const snap = await getDocs(query(collection(db, XC.exams), where("categoryId", "==", catId)));
  return (cache.exams[catId] = snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}
async function ensureBooks(catId) {
  if (cache.books[catId]) return cache.books[catId];
  const snap = await getDocs(query(collection(db, XC.books), where("categoryId", "==", catId)));
  return (cache.books[catId] = snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}
async function loadQuestions(examId) {
  const snap = await getDocs(query(collection(db, XC.questions), where("examId", "==", examId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
async function loadChapters(bookId) {
  const snap = await getDocs(query(collection(db, XC.chapters), where("bookId", "==", bookId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
async function syncExamQuestionCount(examId) {
  const qs = await loadQuestions(examId);
  await updateDoc(doc(db, XC.exams, examId), { questionCount: qs.length });
  return qs.length;
}
async function syncBookChapterCount(bookId) {
  const ch = await loadChapters(bookId);
  await updateDoc(doc(db, XC.books, bookId), { chapterCount: ch.length });
  return ch.length;
}

/* ==========================================================================
   SECTION 1 — SUBJECTS
   ========================================================================== */
async function renderSubjects() {
  const body = $("cs-body");
  body.innerHTML = loadingHtml("Loading subjects…");
  let custom;
  try { custom = await ensureCustomSubjects(); } catch (e) { return showError(body, e, renderSubjects); }

  const cat = getCategory(state.cat);
  const subjects = subjectsFor(cat.id, custom);

  body.innerHTML = `
    <div class="xc-cat-head">
      <div><h3>${escapeHtml(cat.label)} <small>· ${escapeHtml(cat.sub)}</small></h3><p>${plural(subjects.length, "subject")} in this category.</p></div>
      <div class="xc-cat-tools"><button type="button" class="btn-gold" id="cs-add-subject"><i class="fa-solid fa-plus"></i> Add subject</button></div>
    </div>
    <div class="xc-subject-grid">
      ${subjects.map((s) => `
        <div class="xc-subject-card" style="cursor:default;">
          <span class="xc-subject-icon"><i class="fa-solid ${escapeHtml(s.icon || "fa-book")}"></i></span>
          <span class="xc-subject-name">${escapeHtml(s.name)}</span>
          <span class="xc-subject-count">${s.custom ? "Custom subject" : "Built-in"}</span>
        </div>`).join("")}
    </div>
    <div id="cs-subject-form" class="glass-card xc-hidden" style="margin-top:16px;"></div>`;

  $("cs-add-subject").addEventListener("click", () => {
    const form = $("cs-subject-form");
    form.classList.remove("xc-hidden");
    form.innerHTML = `
      <h4><i class="fa-solid fa-plus"></i> Add a custom subject to ${escapeHtml(cat.label)}</h4>
      <div class="cs-field"><label>Subject name</label><input type="text" id="cs-sub-name" placeholder="e.g. Further Mathematics"></div>
      <div class="cs-field"><label>Icon (Font Awesome class, optional)</label><input type="text" id="cs-sub-icon" placeholder="fa-square-root-variable"></div>
      <div class="xc-intro-actions"><button type="button" class="btn-gold" id="cs-sub-save"><i class="fa-solid fa-check"></i> Save subject</button>
      <button type="button" class="btn-outline" id="cs-sub-cancel">Cancel</button></div>`;
    $("cs-sub-cancel").onclick = () => form.classList.add("xc-hidden");
    $("cs-sub-save").onclick = async () => {
      const name = $("cs-sub-name").value.trim();
      if (!name) return toast("Please enter a subject name.", "error");
      const id = slugify(name);
      if (!id) return toast("That subject name isn't valid.", "error");
      try {
        await setDoc(doc(db, XC.subjects, id), { name, icon: $("cs-sub-icon").value.trim() || "fa-book", categoryId: cat.id }, { merge: true });
        cache.customSubjects = null;
        toast("Subject added.", "success");
        logActivity(user.uid, role, "xc_subject_add", `${name} (${cat.id})`).catch(() => {});
        renderSubjects();
      } catch (e) { console.error(e); toast("Could not save the subject.", "error"); }
    };
  });
}

/* ==========================================================================
   SECTION 2 — EXAMS & QUESTIONS
   ========================================================================== */
async function renderExams() {
  const body = $("cs-body");
  if (state.editingExam) return renderExamEditor(state.editingExam);

  body.innerHTML = loadingHtml("Loading exams…");
  let exams, custom;
  try { [exams, custom] = await Promise.all([ensureExams(state.cat), ensureCustomSubjects()]); }
  catch (e) { return showError(body, e, renderExams); }

  const cat = getCategory(state.cat);
  const subjects = subjectsFor(cat.id, custom);
  exams = exams.slice().sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));

  body.innerHTML = `
    <div class="xc-cat-head">
      <div><h3>${escapeHtml(cat.label)} <small>· ${escapeHtml(cat.sub)}</small></h3><p>${plural(exams.length, "exam")} in this category.</p></div>
      <div class="xc-cat-tools"><button type="button" class="btn-gold" id="cs-new-exam"><i class="fa-solid fa-plus"></i> New exam</button></div>
    </div>
    <div class="xc-list" id="cs-exam-list">
      ${exams.length ? exams.map((e) => examRowHtml(e, subjects)).join("") : `<div class="glass-card xc-welcome"><i class="fa-solid fa-file-circle-plus"></i><p>No exams yet in this category. Create the first one.</p></div>`}
    </div>`;

  $("cs-new-exam").onclick = () => { state.editingExam = "new"; renderExams(); };
  body.querySelectorAll("[data-edit-exam]").forEach((b) => b.onclick = () => { state.editingExam = b.dataset.editExam; renderExams(); });
  body.querySelectorAll("[data-del-exam]").forEach((b) => b.onclick = () => deleteExam(b.dataset.delExam));
  body.querySelectorAll("[data-pub-exam]").forEach((b) => b.onclick = () => togglePublish("exam", b.dataset.pubExam, b.dataset.pubState === "1"));
}

function examRowHtml(e, subjects) {
  const subj = subjects.find((s) => s.id === e.subjectId);
  return `<article class="xc-card">
    <div class="xc-card-main">
      <h4>${escapeHtml(e.title || "Untitled exam")}</h4>
      <p class="xc-desc">${escapeHtml(subj ? subj.name : e.subjectName || "No subject")} · ${plural(e.questionCount || 0, "question")} · ${e.durationMinutes || 30} min · Pass ${e.passMark ?? 50}%</p>
      <div class="xc-pills"><span class="${e.published ? "secure" : ""}"><i class="fa-solid ${e.published ? "fa-check-circle" : "fa-eye-slash"}"></i> ${e.published ? "Published" : "Draft (hidden from students)"}</span></div>
    </div>
    <div class="xc-card-actions">
      <button type="button" class="btn-navy" data-edit-exam="${e.id}"><i class="fa-solid fa-pen"></i> Edit</button>
      <button type="button" class="btn-outline" data-pub-exam="${e.id}" data-pub-state="${e.published ? "1" : "0"}"><i class="fa-solid ${e.published ? "fa-eye-slash" : "fa-eye"}"></i> ${e.published ? "Unpublish" : "Publish"}</button>
      <button type="button" class="btn-outline" data-del-exam="${e.id}" style="color:var(--danger);border-color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
    </div>
  </article>`;
}

async function togglePublish(kind, id, currentlyPublished) {
  const col = kind === "exam" ? XC.exams : XC.books;
  try {
    await updateDoc(doc(db, col, id), { published: !currentlyPublished });
    if (kind === "exam") cache.exams = {}; else cache.books = {};
    toast(currentlyPublished ? "Unpublished." : "Published — students can now see this.", "success");
    kind === "exam" ? renderExams() : renderBooks();
  } catch (e) { console.error(e); toast("Could not update publish status.", "error"); }
}

async function deleteExam(examId) {
  if (!confirm("Delete this exam and all of its questions? This cannot be undone.")) return;
  try {
    const qs = await loadQuestions(examId);
    const batch = writeBatch(db);
    qs.forEach((q) => batch.delete(doc(db, XC.questions, q.id)));
    batch.delete(doc(db, XC.exams, examId));
    await batch.commit();
    cache.exams = {};
    toast("Exam deleted.", "success");
    state.editingExam = null;
    renderExams();
  } catch (e) { console.error(e); toast("Could not delete the exam.", "error"); }
}

/* ---------- exam editor (create/edit + question manager) ---------- */
async function renderExamEditor(examId) {
  const body = $("cs-body");
  body.innerHTML = loadingHtml("Loading…");
  const isNew = examId === "new";
  const cat = getCategory(state.cat);
  let custom, exam, questions = [];
  try {
    custom = await ensureCustomSubjects();
    if (!isNew) {
      const snap = await getDoc(doc(db, XC.exams, examId));
      if (!snap.exists()) { state.editingExam = null; toast("That exam no longer exists.", "error"); return renderExams(); }
      exam = { id: snap.id, ...snap.data() };
      questions = await loadQuestions(examId);
    } else {
      exam = { categoryId: cat.id, durationMinutes: 30, passMark: 50, maxAttempts: 0, shuffleQuestions: true, shuffleOptions: true, secureMode: true, reviewMode: "full", published: false };
    }
  } catch (e) { return showError(body, e, () => renderExamEditor(examId)); }

  const subjects = subjectsFor(exam.categoryId || cat.id, custom);

  body.innerHTML = `
    <button type="button" class="xc-back" id="cs-exam-back"><i class="fa-solid fa-arrow-left"></i> All exams</button>
    <div class="glass-card">
      <h3>${isNew ? "New exam" : "Edit exam"}</h3>
      <div class="cs-grid">
        <div class="cs-field"><label>Title</label><input type="text" id="cs-e-title" value="${escapeHtml(exam.title || "")}" placeholder="e.g. Fractions & Decimals — Term Test"></div>
        <div class="cs-field"><label>Subject</label>
          <select id="cs-e-subject">${subjects.map((s) => `<option value="${s.id}" ${exam.subjectId === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}</select>
        </div>
        <div class="cs-field cs-span2"><label>Short description (shown to students before they start)</label>
          <input type="text" id="cs-e-desc" value="${escapeHtml(exam.description || "")}"></div>
        <div class="cs-field cs-span2"><label>Instructions (Markdown/LaTeX supported)</label>
          <textarea id="cs-e-instructions" rows="3">${escapeHtml(exam.instructions || "")}</textarea></div>
        <div class="cs-field"><label>Duration (minutes)</label><input type="number" min="1" id="cs-e-duration" value="${exam.durationMinutes ?? 30}"></div>
        <div class="cs-field"><label>Pass mark (%)</label><input type="number" min="0" max="100" id="cs-e-pass" value="${exam.passMark ?? 50}"></div>
        <div class="cs-field"><label>Max attempts (0 = unlimited)</label><input type="number" min="0" id="cs-e-attempts" value="${exam.maxAttempts ?? 0}"></div>
        <div class="cs-field"><label>Review mode</label>
          <select id="cs-e-review"><option value="full" ${exam.reviewMode !== "none" ? "selected" : ""}>Show full review after submission</option><option value="none" ${exam.reviewMode === "none" ? "selected" : ""}>No review (score only)</option></select>
        </div>
        <label class="cs-check"><input type="checkbox" id="cs-e-shuffle-q" ${exam.shuffleQuestions !== false ? "checked" : ""}> Shuffle question order</label>
        <label class="cs-check"><input type="checkbox" id="cs-e-shuffle-o" ${exam.shuffleOptions !== false ? "checked" : ""}> Shuffle option order</label>
        <label class="cs-check"><input type="checkbox" id="cs-e-secure" ${exam.secureMode !== false ? "checked" : ""}> Secure mode (fullscreen, anti-cheat)</label>
        <label class="cs-check"><input type="checkbox" id="cs-e-published" ${exam.published ? "checked" : ""}> Published (visible to students)</label>
      </div>
      <div class="xc-intro-actions">
        <button type="button" class="btn-gold" id="cs-e-save"><i class="fa-solid fa-check"></i> Save exam</button>
        ${!isNew ? `<button type="button" class="btn-outline" id="cs-e-delete" style="color:var(--danger);border-color:var(--danger);"><i class="fa-solid fa-trash"></i> Delete exam</button>` : ""}
      </div>
    </div>
    <div id="cs-questions" style="margin-top:20px;"></div>`;

  $("cs-exam-back").onclick = () => { state.editingExam = null; renderExams(); };
  if (!isNew) $("cs-e-delete").onclick = () => deleteExam(examId);
  $("cs-e-save").onclick = () => saveExam(isNew ? null : examId, subjects);

  if (!isNew) renderQuestionManager(examId, questions);
  else $("cs-questions").innerHTML = `<div class="glass-card xc-welcome"><i class="fa-solid fa-floppy-disk"></i><p>Save the exam first, then you can add questions.</p></div>`;
}

async function saveExam(examId, subjects) {
  const title = $("cs-e-title").value.trim();
  const subjectId = $("cs-e-subject").value;
  const subject = subjects.find((s) => s.id === subjectId);
  if (!title) return toast("Please enter a title.", "error");
  if (!subject) return toast("Please choose a subject.", "error");

  const data = {
    title, description: $("cs-e-desc").value.trim(), instructions: $("cs-e-instructions").value.trim(),
    categoryId: state.cat, subjectId, subjectName: subject.name,
    durationMinutes: Math.max(1, parseInt($("cs-e-duration").value, 10) || 30),
    passMark: Math.min(100, Math.max(0, parseInt($("cs-e-pass").value, 10) || 0)),
    maxAttempts: Math.max(0, parseInt($("cs-e-attempts").value, 10) || 0),
    reviewMode: $("cs-e-review").value,
    shuffleQuestions: $("cs-e-shuffle-q").checked, shuffleOptions: $("cs-e-shuffle-o").checked,
    secureMode: $("cs-e-secure").checked, published: $("cs-e-published").checked,
    updatedAt: serverTimestamp(), updatedBy: user.uid
  };

  try {
    if (examId) {
      await updateDoc(doc(db, XC.exams, examId), data);
    } else {
      data.questionCount = 0; data.createdAt = serverTimestamp(); data.createdBy = user.uid;
      const ref = await addDoc(collection(db, XC.exams), data);
      examId = ref.id;
    }
    cache.exams = {};
    toast("Exam saved.", "success");
    logActivity(user.uid, role, "xc_exam_save", title).catch(() => {});
    state.editingExam = examId;
    renderExamEditor(examId);
  } catch (e) { console.error(e); toast("Could not save the exam.", "error"); }
}

/* ---------- question manager (inside the exam editor) ---------- */
function renderQuestionManager(examId, questions) {
  const host = $("cs-questions");
  host.innerHTML = `
    <div class="glass-card">
      <h3><i class="fa-solid fa-list-check"></i> Questions <small class="xc-muted">(${plural(questions.length, "question")})</small></h3>
      <div class="xc-list" id="cs-q-list">
        ${questions.length ? questions.map((q, i) => questionRowHtml(q, i)).join("") : `<p class="xc-muted">No questions yet — add one below or bulk-import a question bank.</p>`}
      </div>
      <div class="xc-intro-actions">
        <button type="button" class="btn-gold" id="cs-q-add"><i class="fa-solid fa-plus"></i> Add question</button>
        <button type="button" class="btn-outline" id="cs-q-import"><i class="fa-solid fa-file-import"></i> Bulk import</button>
      </div>
      <div id="cs-q-form" class="xc-hidden"></div>
      <div id="cs-q-import-form" class="xc-hidden"></div>
    </div>`;

  host.querySelectorAll("[data-edit-q]").forEach((b) => b.onclick = () => renderQuestionForm(examId, questions.find((q) => q.id === b.dataset.editQ)));
  host.querySelectorAll("[data-del-q]").forEach((b) => b.onclick = () => deleteQuestion(examId, b.dataset.delQ));
  $("cs-q-add").onclick = () => renderQuestionForm(examId, null);
  $("cs-q-import").onclick = () => renderImportForm(examId);
}

function questionRowHtml(q, i) {
  const optCount = Object.keys(q.options || {}).length;
  return `<article class="xc-card">
    <div class="xc-card-main">
      <h4>Q${i + 1}. ${escapeHtml((q.stem || "").split("\n")[0].slice(0, 90))}${(q.stem || "").length > 90 ? "…" : ""}</h4>
      <p class="xc-desc">${q.type === "theory" ? "Theory / written answer" : `Objective · ${optCount} options · correct: ${escapeHtml(q.correct || "—")}`} · ${q.marks ?? 1} mark${(q.marks ?? 1) === 1 ? "" : "s"}</p>
    </div>
    <div class="xc-card-actions">
      <button type="button" class="btn-navy" data-edit-q="${q.id}"><i class="fa-solid fa-pen"></i> Edit</button>
      <button type="button" class="btn-outline" data-del-q="${q.id}" style="color:var(--danger);border-color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
    </div>
  </article>`;
}

function renderQuestionForm(examId, q) {
  const form = $("cs-q-form");
  $("cs-q-import-form").classList.add("xc-hidden");
  form.classList.remove("xc-hidden");
  const isTheory = q ? q.type === "theory" : false;
  const opts = q?.options || {};
  const letters = ["A", "B", "C", "D", "E"];

  form.innerHTML = `
    <hr>
    <h4>${q ? "Edit question" : "New question"}</h4>
    <div class="cs-field"><label>Type</label>
      <select id="cs-q-type"><option value="objective" ${!isTheory ? "selected" : ""}>Objective (multiple choice)</option><option value="theory" ${isTheory ? "selected" : ""}>Theory (written answer)</option></select>
    </div>
    <div class="cs-field"><label>Question (Markdown/LaTeX supported — use $...$ for inline maths)</label>
      <textarea id="cs-q-stem" rows="3">${escapeHtml(q?.stem || "")}</textarea></div>
    <div id="cs-q-options">
      ${letters.map((L) => `<div class="cs-field" data-opt-row="${L}"><label>Option ${L}</label><input type="text" id="cs-q-opt-${L}" value="${escapeHtml(opts[L] || "")}"></div>`).join("")}
      <div class="cs-field"><label>Correct answer</label>
        <select id="cs-q-correct">${letters.map((L) => `<option value="${L}" ${q?.correct === L ? "selected" : ""}>${L}</option>`).join("")}</select>
      </div>
    </div>
    <div class="cs-field"><label>Marks</label><input type="number" min="0.5" step="0.5" id="cs-q-marks" value="${q?.marks ?? (isTheory ? 10 : 1)}"></div>
    <div class="cs-field"><label>Explanation / marking guide (shown in review, optional)</label>
      <textarea id="cs-q-explanation" rows="2">${escapeHtml(q?.explanation || "")}</textarea></div>
    <div class="cs-field"><label>Order</label><input type="number" id="cs-q-order" value="${q?.order ?? 999}"></div>
    <button type="button" class="xc-link" id="cs-q-preview-btn"><i class="fa-solid fa-eye"></i> Preview rendered question</button>
    <div id="cs-q-preview" class="xc-answer-box xc-hidden"></div>
    <div class="xc-intro-actions">
      <button type="button" class="btn-gold" id="cs-q-save"><i class="fa-solid fa-check"></i> Save question</button>
      <button type="button" class="btn-outline" id="cs-q-cancel">Cancel</button>
    </div>`;

  const toggleOptions = () => { $("cs-q-options").classList.toggle("xc-hidden", $("cs-q-type").value === "theory"); };
  toggleOptions();
  $("cs-q-type").addEventListener("change", toggleOptions);

  $("cs-q-preview-btn").onclick = () => {
    const box = $("cs-q-preview");
    box.classList.remove("xc-hidden");
    box.innerHTML = engineOK ? renderRich($("cs-q-stem").value) : `<p>${escapeHtml($("cs-q-stem").value)}</p>`;
  };
  $("cs-q-cancel").onclick = () => form.classList.add("xc-hidden");
  $("cs-q-save").onclick = () => saveQuestion(examId, q?.id || null);
}

async function saveQuestion(examId, questionId) {
  const type = $("cs-q-type").value;
  const stem = $("cs-q-stem").value.trim();
  if (!stem) return toast("Please enter the question text.", "error");
  const marks = Math.max(0.5, parseFloat($("cs-q-marks").value) || 1);
  const order = parseInt($("cs-q-order").value, 10) || 0;
  const explanation = $("cs-q-explanation").value.trim();

  let data;
  if (type === "theory") {
    data = { examId, type, stem, options: {}, correct: "", marks, explanation, order };
  } else {
    const options = {};
    ["A", "B", "C", "D", "E"].forEach((L) => { const v = $(`cs-q-opt-${L}`)?.value.trim(); if (v) options[L] = v; });
    if (Object.keys(options).length < 2) return toast("An objective question needs at least two options.", "error");
    const correct = $("cs-q-correct").value;
    if (!options[correct]) return toast("The correct answer must match a filled-in option.", "error");
    data = { examId, type, stem, options, correct, marks, explanation, order };
  }

  try {
    if (questionId) await updateDoc(doc(db, XC.questions, questionId), data);
    else await addDoc(collection(db, XC.questions), data);
    await syncExamQuestionCount(examId);
    cache.exams = {};
    toast("Question saved.", "success");
    const questions = await loadQuestions(examId);
    renderQuestionManager(examId, questions);
  } catch (e) { console.error(e); toast("Could not save the question.", "error"); }
}

async function deleteQuestion(examId, questionId) {
  if (!confirm("Delete this question?")) return;
  try {
    await deleteDoc(doc(db, XC.questions, questionId));
    await syncExamQuestionCount(examId);
    cache.exams = {};
    toast("Question deleted.", "success");
    const questions = await loadQuestions(examId);
    renderQuestionManager(examId, questions);
  } catch (e) { console.error(e); toast("Could not delete the question.", "error"); }
}

/* ---------- bulk import ---------- */
function renderImportForm(examId) {
  const form = $("cs-q-import-form");
  $("cs-q-form").classList.add("xc-hidden");
  form.classList.remove("xc-hidden");
  form.innerHTML = `
    <hr>
    <h4><i class="fa-solid fa-file-import"></i> Bulk import questions</h4>
    <p class="xc-muted" style="font-size:.85rem;">Paste a question bank. Each question starts with <code>Q:</code>, options are <code>A)</code>…<code>E)</code>, then <code>ANSWER: B</code>. Add <code>[THEORY]</code> to the question text (or leave out the options) for a written question. <code>MARKS:</code> and <code>EXPLANATION:</code> are optional.</p>
    <textarea id="cs-import-text" rows="10" placeholder="Q: What is 3/4 as a decimal?
A) 0.75
B) 0.5
C) 0.25
ANSWER: A
MARKS: 2
EXPLANATION: Divide 3 by 4."></textarea>
    <div class="xc-intro-actions">
      <button type="button" class="btn-gold" id="cs-import-preview"><i class="fa-solid fa-magnifying-glass"></i> Preview</button>
      <button type="button" class="btn-outline" id="cs-import-cancel">Cancel</button>
    </div>
    <div id="cs-import-result"></div>`;

  $("cs-import-cancel").onclick = () => form.classList.add("xc-hidden");
  $("cs-import-preview").onclick = () => {
    const { questions, errors, found } = parseQuestions($("cs-import-text").value);
    const out = $("cs-import-result");
    out.innerHTML = `
      <p style="margin-top:12px;"><b>${plural(questions.length, "question")}</b> ready to import out of ${plural(found, "question")} found${errors.length ? `, <span style="color:var(--danger);">${plural(errors.length, "error")}</span>` : ""}.</p>
      ${errors.length ? `<div class="xc-callout xc-callout-warning"><div class="xc-callout-title">Warning</div><ul style="margin:0;padding-left:18px;">${errors.map((er) => `<li>Question ${er.n}: ${escapeHtml(er.message)} <i>(${escapeHtml(er.preview)}…)</i></li>`).join("")}</ul></div>` : ""}
      ${questions.length ? `<button type="button" class="btn-gold" id="cs-import-confirm"><i class="fa-solid fa-check"></i> Import ${plural(questions.length, "question")}</button>` : ""}`;
    $("cs-import-confirm")?.addEventListener("click", () => confirmImport(examId, questions));
  };
}

async function confirmImport(examId, parsed) {
  try {
    const existing = await loadQuestions(examId);
    let order = existing.reduce((m, q) => Math.max(m, q.order || 0), 0);
    const batch = writeBatch(db);
    parsed.forEach((q) => {
      order += 1;
      const ref = doc(collection(db, XC.questions));
      batch.set(ref, { examId, ...q, order });
    });
    await batch.commit();
    await syncExamQuestionCount(examId);
    cache.exams = {};
    toast(`Imported ${plural(parsed.length, "question")}.`, "success");
    logActivity(user.uid, role, "xc_bulk_import", `${parsed.length} questions into ${examId}`).catch(() => {});
    const questions = await loadQuestions(examId);
    renderQuestionManager(examId, questions);
  } catch (e) { console.error(e); toast("Could not import the questions.", "error"); }
}

/* ==========================================================================
   SECTION 3 — TEXTBOOKS & CHAPTERS
   ========================================================================== */
async function renderBooks() {
  const body = $("cs-body");
  if (state.editingBook) return renderBookEditor(state.editingBook);

  body.innerHTML = loadingHtml("Loading textbooks…");
  let books, custom;
  try { [books, custom] = await Promise.all([ensureBooks(state.cat), ensureCustomSubjects()]); }
  catch (e) { return showError(body, e, renderBooks); }

  const cat = getCategory(state.cat);
  const subjects = subjectsFor(cat.id, custom);
  books = books.slice().sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));

  body.innerHTML = `
    <div class="xc-cat-head">
      <div><h3>${escapeHtml(cat.label)} <small>· ${escapeHtml(cat.sub)}</small></h3><p>${plural(books.length, "textbook")} in this category.</p></div>
      <div class="xc-cat-tools"><button type="button" class="btn-gold" id="cs-new-book"><i class="fa-solid fa-plus"></i> New textbook</button></div>
    </div>
    <div class="xc-list" id="cs-book-list">
      ${books.length ? books.map((b) => bookRowHtml(b, subjects)).join("") : `<div class="glass-card xc-welcome"><i class="fa-solid fa-book-medical"></i><p>No textbooks yet in this category. Create the first one.</p></div>`}
    </div>`;

  $("cs-new-book").onclick = () => { state.editingBook = "new"; renderBooks(); };
  body.querySelectorAll("[data-edit-book]").forEach((b) => b.onclick = () => { state.editingBook = b.dataset.editBook; renderBooks(); });
  body.querySelectorAll("[data-del-book]").forEach((b) => b.onclick = () => deleteBook(b.dataset.delBook));
  body.querySelectorAll("[data-pub-book]").forEach((b) => b.onclick = () => togglePublish("book", b.dataset.pubBook, b.dataset.pubState === "1"));
}

function bookRowHtml(b, subjects) {
  const subj = subjects.find((s) => s.id === b.subjectId);
  return `<article class="xc-card xc-book">
    <div class="xc-cover" style="--c:${escapeHtml(subj ? colorForFallback(subj.id) : "#0c4f36")}"><i class="fa-solid fa-book"></i></div>
    <div class="xc-card-main">
      <h4>${escapeHtml(b.title || "Untitled textbook")}</h4>
      <p class="xc-author">${escapeHtml(b.author || "")}</p>
      <p class="xc-desc">${escapeHtml(subj ? subj.name : b.subjectId || "No subject")} · ${plural(b.chapterCount || 0, "chapter")}</p>
      <div class="xc-pills"><span class="${b.published ? "secure" : ""}"><i class="fa-solid ${b.published ? "fa-check-circle" : "fa-eye-slash"}"></i> ${b.published ? "Published" : "Draft (hidden from students)"}</span></div>
    </div>
    <div class="xc-card-actions">
      <button type="button" class="btn-navy" data-edit-book="${b.id}"><i class="fa-solid fa-pen"></i> Edit</button>
      <button type="button" class="btn-outline" data-pub-book="${b.id}" data-pub-state="${b.published ? "1" : "0"}"><i class="fa-solid ${b.published ? "fa-eye-slash" : "fa-eye"}"></i> ${b.published ? "Unpublish" : "Publish"}</button>
      <button type="button" class="btn-outline" data-del-book="${b.id}" style="color:var(--danger);border-color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
    </div>
  </article>`;
}
function colorForFallback(id) { const p = ["#0c4f36", "#1e3a8a", "#0f766e", "#7c2d12", "#4c1d95"]; let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return p[h % p.length]; }

async function deleteBook(bookId) {
  if (!confirm("Delete this textbook and all of its chapters? This cannot be undone.")) return;
  try {
    const chapters = await loadChapters(bookId);
    const batch = writeBatch(db);
    chapters.forEach((c) => { batch.delete(doc(db, XC.chapters, c.id)); batch.delete(doc(db, XC.chapterBodies, c.id)); });
    batch.delete(doc(db, XC.books, bookId));
    await batch.commit();
    cache.books = {};
    toast("Textbook deleted.", "success");
    state.editingBook = null;
    renderBooks();
  } catch (e) { console.error(e); toast("Could not delete the textbook.", "error"); }
}

async function renderBookEditor(bookId) {
  const body = $("cs-body");
  body.innerHTML = loadingHtml("Loading…");
  const isNew = bookId === "new";
  const cat = getCategory(state.cat);
  let custom, book, chapters = [];
  try {
    custom = await ensureCustomSubjects();
    if (!isNew) {
      const snap = await getDoc(doc(db, XC.books, bookId));
      if (!snap.exists()) { state.editingBook = null; toast("That textbook no longer exists.", "error"); return renderBooks(); }
      book = { id: snap.id, ...snap.data() };
      chapters = await loadChapters(bookId);
    } else {
      book = { categoryId: cat.id, published: false };
    }
  } catch (e) { return showError(body, e, () => renderBookEditor(bookId)); }

  const subjects = subjectsFor(book.categoryId || cat.id, custom);

  body.innerHTML = `
    <button type="button" class="xc-back" id="cs-book-back"><i class="fa-solid fa-arrow-left"></i> All textbooks</button>
    <div class="glass-card">
      <h3>${isNew ? "New textbook" : "Edit textbook"}</h3>
      <div class="cs-grid">
        <div class="cs-field"><label>Title</label><input type="text" id="cs-b-title" value="${escapeHtml(book.title || "")}"></div>
        <div class="cs-field"><label>Subject</label>
          <select id="cs-b-subject">${subjects.map((s) => `<option value="${s.id}" ${book.subjectId === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}</select>
        </div>
        <div class="cs-field"><label>Author</label><input type="text" id="cs-b-author" value="${escapeHtml(book.author || "")}"></div>
        <label class="cs-check"><input type="checkbox" id="cs-b-published" ${book.published ? "checked" : ""}> Published (visible to students)</label>
        <div class="cs-field cs-span2"><label>Description</label><textarea id="cs-b-desc" rows="2">${escapeHtml(book.description || "")}</textarea></div>
      </div>
      <div class="xc-intro-actions">
        <button type="button" class="btn-gold" id="cs-b-save"><i class="fa-solid fa-check"></i> Save textbook</button>
        ${!isNew ? `<button type="button" class="btn-outline" id="cs-b-delete" style="color:var(--danger);border-color:var(--danger);"><i class="fa-solid fa-trash"></i> Delete textbook</button>` : ""}
      </div>
    </div>
    <div id="cs-chapters" style="margin-top:20px;"></div>`;

  $("cs-book-back").onclick = () => { state.editingBook = null; renderBooks(); };
  if (!isNew) $("cs-b-delete").onclick = () => deleteBook(bookId);
  $("cs-b-save").onclick = () => saveBook(isNew ? null : bookId, subjects);

  if (!isNew) renderChapterManager(bookId, chapters);
  else $("cs-chapters").innerHTML = `<div class="glass-card xc-welcome"><i class="fa-solid fa-floppy-disk"></i><p>Save the textbook first, then you can add chapters.</p></div>`;
}

async function saveBook(bookId, subjects) {
  const title = $("cs-b-title").value.trim();
  const subjectId = $("cs-b-subject").value;
  const subject = subjects.find((s) => s.id === subjectId);
  if (!title) return toast("Please enter a title.", "error");
  if (!subject) return toast("Please choose a subject.", "error");

  const data = {
    title, author: $("cs-b-author").value.trim(), description: $("cs-b-desc").value.trim(),
    categoryId: state.cat, subjectId, published: $("cs-b-published").checked,
    updatedAt: serverTimestamp(), updatedBy: user.uid
  };

  try {
    if (bookId) {
      await updateDoc(doc(db, XC.books, bookId), data);
    } else {
      data.chapterCount = 0; data.createdAt = serverTimestamp(); data.createdBy = user.uid;
      const ref = await addDoc(collection(db, XC.books), data);
      bookId = ref.id;
    }
    cache.books = {};
    toast("Textbook saved.", "success");
    logActivity(user.uid, role, "xc_book_save", title).catch(() => {});
    state.editingBook = bookId;
    renderBookEditor(bookId);
  } catch (e) { console.error(e); toast("Could not save the textbook.", "error"); }
}

function renderChapterManager(bookId, chapters) {
  const host = $("cs-chapters");
  host.innerHTML = `
    <div class="glass-card">
      <h3><i class="fa-solid fa-list-ol"></i> Chapters <small class="xc-muted">(${plural(chapters.length, "chapter")})</small></h3>
      <div class="xc-list" id="cs-ch-list">
        ${chapters.length ? chapters.map((c, i) => `
          <article class="xc-card">
            <div class="xc-card-main"><h4>${i + 1}. ${escapeHtml(c.title || "Untitled chapter")}</h4></div>
            <div class="xc-card-actions">
              <button type="button" class="btn-navy" data-edit-ch="${c.id}"><i class="fa-solid fa-pen"></i> Edit</button>
              <button type="button" class="btn-outline" data-del-ch="${c.id}" style="color:var(--danger);border-color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
            </div>
          </article>`).join("") : `<p class="xc-muted">No chapters yet — add the first one below.</p>`}
      </div>
      <div class="xc-intro-actions"><button type="button" class="btn-gold" id="cs-ch-add"><i class="fa-solid fa-plus"></i> Add chapter</button></div>
      <div id="cs-ch-form" class="xc-hidden"></div>
    </div>`;

  host.querySelectorAll("[data-edit-ch]").forEach((b) => b.onclick = () => renderChapterForm(bookId, chapters.find((c) => c.id === b.dataset.editCh)));
  host.querySelectorAll("[data-del-ch]").forEach((b) => b.onclick = () => deleteChapter(bookId, b.dataset.delCh));
  $("cs-ch-add").onclick = () => renderChapterForm(bookId, null);
}

async function renderChapterForm(bookId, chapter) {
  const form = $("cs-ch-form");
  form.classList.remove("xc-hidden");
  let content = "";
  if (chapter) {
    form.innerHTML = loadingHtml("Loading chapter content…");
    try {
      const snap = await getDoc(doc(db, XC.chapterBodies, chapter.id));
      content = snap.exists() ? (snap.data().content || "") : "";
    } catch (e) { console.error(e); }
  }

  form.innerHTML = `
    <hr>
    <h4>${chapter ? "Edit chapter" : "New chapter"}</h4>
    <div class="cs-grid">
      <div class="cs-field"><label>Chapter title</label><input type="text" id="cs-ch-title" value="${escapeHtml(chapter?.title || "")}"></div>
      <div class="cs-field"><label>Order</label><input type="number" id="cs-ch-order" value="${chapter?.order ?? 999}"></div>
    </div>
    <div class="cs-field"><label>Content (Markdown + LaTeX — use $...$ / $$...$$ for maths, &gt; [!NOTE] for callouts)</label>
      <textarea id="cs-ch-content" rows="14">${escapeHtml(content)}</textarea></div>
    <button type="button" class="xc-link" id="cs-ch-preview-btn"><i class="fa-solid fa-eye"></i> Preview rendered chapter</button>
    <div id="cs-ch-preview" class="tb-article xc-hidden" style="max-width:none;padding:16px;background:var(--bg);border-radius:var(--xc-radius-sm);"></div>
    <div class="xc-intro-actions">
      <button type="button" class="btn-gold" id="cs-ch-save"><i class="fa-solid fa-check"></i> Save chapter</button>
      <button type="button" class="btn-outline" id="cs-ch-cancel">Cancel</button>
    </div>`;

  $("cs-ch-cancel").onclick = () => form.classList.add("xc-hidden");
  $("cs-ch-preview-btn").onclick = () => {
    const box = $("cs-ch-preview");
    box.classList.remove("xc-hidden");
    box.innerHTML = engineOK ? renderRich($("cs-ch-content").value) : `<pre class="tb-plain">${escapeHtml($("cs-ch-content").value)}</pre>`;
  };
  $("cs-ch-save").onclick = () => saveChapter(bookId, chapter?.id || null);
}

async function saveChapter(bookId, chapterId) {
  const title = $("cs-ch-title").value.trim();
  if (!title) return toast("Please enter a chapter title.", "error");
  const order = parseInt($("cs-ch-order").value, 10) || 0;
  const content = $("cs-ch-content").value;

  try {
    if (chapterId) {
      await updateDoc(doc(db, XC.chapters, chapterId), { title, order, bookId });
      await setDoc(doc(db, XC.chapterBodies, chapterId), { content }, { merge: true });
    } else {
      const ref = await addDoc(collection(db, XC.chapters), { bookId, title, order, summary: "" });
      chapterId = ref.id;
      await setDoc(doc(db, XC.chapterBodies, chapterId), { content });
    }
    await syncBookChapterCount(bookId);
    cache.books = {};
    toast("Chapter saved.", "success");
    const chapters = await loadChapters(bookId);
    renderChapterManager(bookId, chapters);
  } catch (e) { console.error(e); toast("Could not save the chapter.", "error"); }
}

async function deleteChapter(bookId, chapterId) {
  if (!confirm("Delete this chapter?")) return;
  try {
    await deleteDoc(doc(db, XC.chapters, chapterId));
    await deleteDoc(doc(db, XC.chapterBodies, chapterId)).catch(() => {});
    await syncBookChapterCount(bookId);
    cache.books = {};
    toast("Chapter deleted.", "success");
    const chapters = await loadChapters(bookId);
    renderChapterManager(bookId, chapters);
  } catch (e) { console.error(e); toast("Could not delete the chapter.", "error"); }
}

/* ==========================================================================
   SECTION 4 — THEORY GRADING
   ========================================================================== */
async function renderGrading() {
  const body = $("cs-body");
  body.innerHTML = loadingHtml("Loading results awaiting grading…");
  let pending;
  try {
    const snap = await getDocs(query(collection(db, XC.results), where("needsManualGrading", "==", true)));
    pending = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.submittedAtISO || "").localeCompare(b.submittedAtISO || ""));
  } catch (e) { return showError(body, e, renderGrading); }

  if (!pending.length) {
    body.innerHTML = `<div class="glass-card xc-welcome"><i class="fa-solid fa-circle-check"></i><h3>All caught up</h3><p>No theory answers are waiting to be graded.</p></div>`;
    return;
  }

  body.innerHTML = `<p class="xc-muted" style="margin-bottom:12px;">${plural(pending.length, "result")} waiting for theory-question grading.</p>
    <div class="xc-list" id="cs-grading-list"></div>`;
  const list = $("cs-grading-list");
  pending.forEach((r) => list.appendChild(gradingCard(r)));
}

function gradingCard(r) {
  const el = document.createElement("article");
  el.className = "glass-card";
  el.style.padding = "20px";
  el.innerHTML = `
    <h4>${escapeHtml(r.examTitle || "Exam")} <small class="xc-muted">· ${escapeHtml(r.studentName || r.studentId || "Student")}</small></h4>
    <p class="xc-desc">Objective: ${r.objectiveScore}/${r.objectiveTotal} · Submitted ${escapeHtml(r.date || "")}</p>
    <div class="xc-review"></div>
    <div class="xc-intro-actions"><button type="button" class="btn-gold" data-save-grading><i class="fa-solid fa-check"></i> Save grading</button></div>`;

  const reviewHost = el.querySelector(".xc-review");
  (r.theoryAnswers || []).forEach((ta, i) => {
    const card = document.createElement("div");
    card.className = "xc-qcard review";
    card.innerHTML = `
      <div class="xc-qhead"><span class="xc-qnum">Theory question ${i + 1}</span><span class="xc-marks">${ta.marks} marks</span></div>
      <div class="xc-stem">${engineOK ? renderRich(ta.question || "") : `<p>${escapeHtml(ta.question || "")}</p>`}</div>
      <div class="xc-answer-box"><small>Student's answer</small>${escapeHtml(ta.text || "(no answer given)")}</div>
      <div class="cs-grid">
        <div class="cs-field"><label>Marks awarded (0–${ta.marks})</label><input type="number" min="0" max="${ta.marks}" step="0.5" class="cs-award" value="${ta.awarded ?? ""}"></div>
        <div class="cs-field cs-span2"><label>Feedback (optional)</label><input type="text" class="cs-feedback" value="${escapeHtml(ta.feedback || "")}"></div>
      </div>`;
    reviewHost.appendChild(card);
  });

  el.querySelector("[data-save-grading]").addEventListener("click", () => saveGrading(r, el));
  return el;
}

async function saveGrading(r, el) {
  const awardEls = el.querySelectorAll(".cs-award");
  const fbEls = el.querySelectorAll(".cs-feedback");
  const theoryAnswers = (r.theoryAnswers || []).map((ta, i) => {
    const raw = awardEls[i].value;
    const awarded = raw === "" ? null : Math.max(0, Math.min(ta.marks, parseFloat(raw) || 0));
    return { ...ta, awarded, feedback: fbEls[i].value.trim() };
  });

  const allGraded = theoryAnswers.every((ta) => typeof ta.awarded === "number");
  const data = { theoryAnswers, gradedAt: serverTimestamp(), gradedBy: user.uid };

  if (allGraded) {
    const theoryScore = theoryAnswers.reduce((s, ta) => s + ta.awarded, 0);
    const sum = summarize({ objectiveScore: r.objectiveScore, objectiveTotal: r.objectiveTotal, theoryScore, theoryTotal: r.theoryTotal, passMark: r.passMark ?? 50 });
    Object.assign(data, { theoryScore, score: sum.score, total: sum.total, percent: sum.percent, grade: sum.grade, passed: sum.passed, needsManualGrading: false });
  }

  try {
    await updateDoc(doc(db, XC.results, r.id), data);
    toast(allGraded ? "Grading complete — the student can now see their full result." : "Progress saved. Grade every question to finalise the result.", "success");
    logActivity(user.uid, role, "xc_grade_theory", `${r.examTitle} — ${r.studentName || r.studentId}`).catch(() => {});
    if (allGraded) { cache.grading = null; renderGrading(); }
  } catch (e) { console.error(e); toast("Could not save grading.", "error"); }
}
