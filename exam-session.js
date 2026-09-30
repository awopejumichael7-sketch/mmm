/* ==========================================================================
   EXAM-SESSION.JS — Exam Centre exam engine
   --------------------------------------------------------------------------
   • One question at a time with a question palette (CBT style)
   • Equations in questions/options/explanations rendered with KaTeX
   • Timer driven by an absolute end-time (refreshing cannot stretch it)
   • Progress, shuffled order and flags survive a refresh (resume)
   • Same secure-mode measures as the original exam page (fullscreen, copy /
     right-click / devtools shortcuts blocked, tab switches recorded), but
     configurable per exam so practice exams can run without them
   • Results saved to the Exam Centre's own collection (never the original
     `results` collection, so certificates are unaffected)
   Grading is done in the browser, exactly like the original exam engine.
   ========================================================================== */
import { db, collection, doc, getDoc, getDocs, query, where, logActivity } from "./xc-firebase.js";
import { XC, getCategory, escapeHtml, shuffle, summarize, plural } from "./exam-catalog.js";
import {
  guardRoles, loadSession, saveSession, clearSession, sessionKeyFor,
  newResultId, saveResult, flushPendingResults
} from "./xc-common.js";
import { loadMathEngine, renderRich } from "./math-render.js";
import { toast, protectElement } from "./app-shell.js";

const params = new URLSearchParams(window.location.search);
const examId = params.get("exam");
const reviewId = params.get("review");
const MAX_EXITS = 2;                       // same tolerance as the original exam page
const SYNC_QUEUE_KEY = "cacgw_sync_queue"; // the app-wide offline queue (see app-shell.js)

const $ = (id) => document.getElementById(id);
let user, profile, exam, questions = [], byId = {};
let session = null, ordered = [], idx = 0;
let running = false, submitting = false, timerId = null, engineOK = false, usedAttempts = 0, saveTimer = null;

const rich = (text, opts) => engineOK ? renderRich(text, opts) : escapeHtml(text).replace(/\n/g, "<br>");
const isSecure = () => exam.secureMode !== false;
const fsSupported = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);

/* ==========================================================================
   BOOT
   ========================================================================== */
(async function main() {
  if (!examId) return fatal("No exam was specified.");
  const ctx = await guardRoles(["student"]);
  user = ctx.user; profile = ctx.profile;
  try { await loadMathEngine(); engineOK = true; } catch (e) { console.error(e); }

  try {
    const snap = await getDoc(doc(db, XC.exams, examId));
    if (!snap.exists()) return fatal("This exam could not be found, or it is not available yet.");
    exam = { id: snap.id, ...snap.data() };
    const qs = await getDocs(query(collection(db, XC.questions), where("examId", "==", examId)));
    questions = qs.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
    byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  } catch (e) {
    console.error(e);
    return fatal("Could not load the exam. Please check your connection and try again.");
  }

  document.title = `${exam.title} — Exam Centre`;
  $("xc-title").textContent = exam.title;
  const cat = getCategory(exam.categoryId);
  $("xc-subtitle").textContent = [cat && cat.label, exam.subjectName].filter(Boolean).join(" · ") || "Exam Centre";

  if (reviewId) return showReviewById(reviewId);
  await showIntro();
})();

function fatal(message) {
  $("xc-intro").innerHTML = `<h3><i class="fa-solid fa-triangle-exclamation"></i> Unable to open exam</h3>
    <p>${escapeHtml(message)}</p><a class="btn-navy" href="student.html"><i class="fa-solid fa-arrow-left"></i> Back to dashboard</a>`;
}

/* ==========================================================================
   INTRO / RESUME / BLOCKED
   ========================================================================== */
async function countAttempts() {
  await flushPendingResults().catch(() => {});
  let used = 0, last = null;
  try {
    const snap = await getDocs(query(collection(db, XC.results), where("studentUid", "==", user.uid), where("examId", "==", examId)));
    snap.forEach((d) => { used++; const r = { id: d.id, ...d.data() }; if (!last || (r.attempt || 0) >= (last.attempt || 0)) last = r; });
  } catch (e) { console.warn("Could not count attempts", e); }
  // A result that is still waiting to upload (offline) also counts as an attempt.
  try {
    const q = JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || "[]");
    used += q.filter((i) => i.type === "xcResult" && i.payload && i.payload.examId === examId && i.payload.studentUid === user.uid).length;
  } catch (e) { /* ignore */ }
  return { used, last };
}

async function showIntro() {
  const { used, last } = await countAttempts();
  usedAttempts = used;
  const max = Number(exam.maxAttempts ?? 1);
  session = loadSession(user.uid, examId);
  const resuming = !!session;
  const exhausted = max > 0 && used >= max && !resuming;
  const intro = $("xc-intro");

  if (!questions.length) {
    intro.innerHTML = `<h3>${escapeHtml(exam.title)}</h3><p>No questions have been added to this exam yet. Please check back later.</p>
      <a class="btn-navy" href="student.html"><i class="fa-solid fa-arrow-left"></i> Back to dashboard</a>`;
    return;
  }

  if (exhausted) {
    intro.innerHTML = `<h3><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> You've already taken this exam</h3>
      <p>This exam allows ${plural(max, "attempt")}${last ? `. Your recorded result: <strong>${last.score}/${last.total} (${last.percent}%) — Grade ${escapeHtml(last.grade)}</strong>${last.needsManualGrading ? "<br><small>Theory questions are still awaiting your teacher's marking.</small>" : ""}` : "."}</p>
      <div class="xc-intro-actions">
        ${last && exam.reviewMode !== "none" ? `<a class="btn-gold" href="exam-session.html?exam=${encodeURIComponent(examId)}&review=${encodeURIComponent(last.id)}"><i class="fa-solid fa-magnifying-glass-chart"></i> Review answers</a>` : ""}
        <a class="btn-navy" href="student.html"><i class="fa-solid fa-arrow-left"></i> Back to dashboard</a>
      </div>`;
    return;
  }

  const secure = isSecure();
  const objectiveN = questions.filter((q) => q.type !== "theory").length;
  const theoryN = questions.length - objectiveN;
  const attemptsLine = max === 0 ? "You may attempt this exam as many times as you like."
    : `This exam allows ${plural(max, "attempt")}; you have used ${used}.`;

  intro.innerHTML = `
    <h3><i class="fa-solid fa-file-pen"></i> ${escapeHtml(exam.title)}</h3>
    ${exam.description ? `<p class="xc-desc">${escapeHtml(exam.description)}</p>` : ""}
    <div class="xc-pills big">
      <span><i class="fa-regular fa-circle-question"></i> ${plural(questions.length, "question")}${theoryN ? ` (${objectiveN} objective, ${theoryN} theory)` : ""}</span>
      <span><i class="fa-regular fa-clock"></i> ${exam.durationMinutes || 30} minutes</span>
      <span><i class="fa-solid fa-bullseye"></i> Pass mark ${exam.passMark ?? 50}%</span>
      ${secure ? `<span class="secure"><i class="fa-solid fa-shield-halved"></i> Secure mode</span>` : `<span><i class="fa-solid fa-dumbbell"></i> Practice mode</span>`}
    </div>
    ${exam.instructions ? `<div class="xc-instructions">${rich(exam.instructions, { breaks: true })}</div>` : ""}
    <h4 style="margin-top:18px;"><i class="fa-solid fa-lock"></i> Before you begin</h4>
    <ul class="xc-rules">
      <li>You have <b>${exam.durationMinutes || 30} minutes</b>. The timer keeps running if you refresh or close this page.</li>
      <li>Move freely between questions, <b>flag</b> ones to revisit, and change answers until you submit.</li>
      <li>Your answers are saved on this device as you go, so an accidental refresh will not lose your work.</li>
      ${secure ? `<li>${fsSupported() ? "The exam runs in <b>fullscreen</b>; leaving fullscreen more than " + MAX_EXITS + " times submits your exam automatically." : "Fullscreen is not supported on this device, so the exam will run in the normal view."}</li>
      <li>Copying, right-click, printing and switching tabs are restricted and monitored.</li>` : ""}
      <li>${escapeHtml(attemptsLine)}</li>
    </ul>
    ${resuming ? `<div class="xc-banner"><i class="fa-solid fa-rotate-right"></i> You have an exam in progress. Resume to continue where you stopped.</div>` : ""}
    <div class="xc-intro-actions">
      <button class="btn-gold" id="begin-btn"><i class="fa-solid fa-play"></i> ${resuming ? "Resume exam" : secure && fsSupported() ? "Enter fullscreen & begin" : "Begin exam"}</button>
      <a class="btn-outline" href="student.html">Back</a>
    </div>`;

  $("begin-btn").onclick = () => begin(resuming);

  // Time ran out while the student was away: startRun()'s first tick() submits their saved answers.
  if (resuming && Date.now() >= session.endsAt) startRun(true);
}

/* ==========================================================================
   START / RESUME
   ========================================================================== */
function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  $("warning-overlay").style.display = "none";
  if (!req) return Promise.resolve();
  return Promise.resolve(req.call(el)).catch(() => toast("Fullscreen was blocked — please allow it to continue.", "error"));
}

function begin(resuming) {
  if (isSecure()) enterFullscreen(); // must run inside the click handler to be allowed
  if (!resuming) {
    const base = shuffle_(questions.map((q) => q.id), exam.shuffleQuestions !== false);
    const optionOrder = {};
    questions.forEach((q) => {
      if (q.type === "theory") return;
      const keys = Object.keys(q.options || {}).filter((k) => q.options[k]).sort();
      optionOrder[q.id] = shuffle_(keys, exam.shuffleOptions !== false);
    });
    const now = Date.now();
    session = {
      v: 1, examId, attempt: usedAttempts + 1, startedAt: now,
      endsAt: now + (exam.durationMinutes || 30) * 60000,
      order: base, optionOrder, answers: {}, flags: {}, exits: 0, tabSwitches: 0
    };
    persistSession();
  }
  startRun(false);
}
const shuffle_ = (arr, doShuffle) => (doShuffle ? shuffle(arr) : arr.slice());

function startRun(quiet) {
  ordered = session.order.map((id) => byId[id]).filter(Boolean);
  if (!ordered.length) { clearSession(user.uid, examId); return fatal("This exam was changed while you were away. Please reload the page to start again."); }
  idx = 0;
  running = true;
  $("xc-intro").classList.add("xc-hidden");
  $("xc-run").classList.remove("xc-hidden");
  $("exam-timer").style.display = "block";
  protectElement($("xc-run"));
  renderQuestion();
  renderPalette();
  tick();
  timerId = setInterval(tick, 1000);
  if (!quiet) window.scrollTo({ top: 0 });
}

const persistSession = () => saveSession(user.uid, examId, session);

/* ==========================================================================
   TIMER
   ========================================================================== */
function tick() {
  if (!running) return;
  const left = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
  const h = Math.floor(left / 3600), m = String(Math.floor((left % 3600) / 60)).padStart(2, "0"), s = String(left % 60).padStart(2, "0");
  const el = $("exam-timer");
  el.textContent = h ? `${h}:${m}:${s}` : `${m}:${s}`;
  el.classList.toggle("low", left <= 300);
  if (left <= 0) submit(true, "Time is up — your exam was submitted automatically.");
}

/* ==========================================================================
   QUESTION VIEW
   ========================================================================== */
const answered = (q) => {
  const a = session.answers[q.id];
  return q.type === "theory" ? !!(a && String(a).trim()) : !!a;
};

function renderQuestion() {
  const q = ordered[idx];
  const a = session.answers[q.id];
  const flagged = !!session.flags[q.id];
  let inputs;

  if (q.type === "theory") {
    inputs = `<textarea id="theory-input" class="xc-theory" rows="9" placeholder="Type your answer here…" aria-label="Your answer">${escapeHtml(a || "")}</textarea>
      <p class="xc-hint"><i class="fa-solid fa-circle-info"></i> You can write equations between dollar signs, e.g. <code>$x^2 + 3x - 4 = 0$</code>. Your answer saves automatically.</p>`;
  } else {
    const keys = session.optionOrder[q.id] || Object.keys(q.options || {}).sort();
    inputs = `<div class="xc-options" role="radiogroup" aria-label="Answer options">` + keys.map((k, i) => `
      <label class="xc-option ${a === k ? "selected" : ""}">
        <input type="radio" name="opt" value="${escapeHtml(k)}" ${a === k ? "checked" : ""}>
        <span class="xc-letter">${String.fromCharCode(65 + i)}</span>
        <span class="xc-opt-text">${rich(q.options[k], { inline: true })}</span>
      </label>`).join("") + `</div>`;
  }

  $("xc-qpanel").innerHTML = `
    <div class="xc-qcard">
      <div class="xc-qhead">
        <span class="xc-qnum">Question ${idx + 1} <small>of ${ordered.length}</small></span>
        <span class="xc-marks">${plural(q.marks || 1, "mark")}${q.type === "theory" ? " · written" : ""}</span>
        <button type="button" class="xc-flag ${flagged ? "on" : ""}" id="flag-btn" aria-pressed="${flagged}"><i class="fa-${flagged ? "solid" : "regular"} fa-flag"></i> ${flagged ? "Flagged" : "Flag"}</button>
      </div>
      <div class="xc-stem">${rich(q.stem, { breaks: true })}</div>
      ${inputs}
      <div class="xc-qfoot">
        ${q.type !== "theory" ? `<button type="button" class="xc-link" id="clear-btn" ${a ? "" : "hidden"}>Clear answer</button>` : "<span></span>"}
        <div class="xc-nav">
          <button type="button" class="btn-outline" id="prev-btn" ${idx === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-left"></i> Previous</button>
          ${idx < ordered.length - 1
            ? `<button type="button" class="btn-navy" id="next-btn">Next <i class="fa-solid fa-arrow-right"></i></button>`
            : `<button type="button" class="btn-gold" id="finish-btn"><i class="fa-solid fa-flag-checkered"></i> Finish &amp; submit</button>`}
        </div>
      </div>
    </div>`;

  $("flag-btn").onclick = () => { session.flags[q.id] = !session.flags[q.id]; if (!session.flags[q.id]) delete session.flags[q.id]; persistSession(); renderQuestion(); renderPalette(); };
  $("prev-btn").onclick = () => go(idx - 1);
  if ($("next-btn")) $("next-btn").onclick = () => go(idx + 1);
  if ($("finish-btn")) $("finish-btn").onclick = askSubmit;
  if ($("clear-btn")) $("clear-btn").onclick = () => { delete session.answers[q.id]; persistSession(); renderQuestion(); renderPalette(); };

  document.querySelectorAll('input[name="opt"]').forEach((inp) => inp.onchange = () => {
    session.answers[q.id] = inp.value; persistSession();
    document.querySelectorAll(".xc-option").forEach((l) => l.classList.toggle("selected", l.contains(inp) && inp.checked));
    $("clear-btn").hidden = false;
    renderPalette();
  });
  const ta = $("theory-input");
  if (ta) ta.oninput = () => {
    session.answers[q.id] = ta.value;
    clearTimeout(saveTimer); saveTimer = setTimeout(persistSession, 400);
    renderPalette();
  };
}

function go(i) {
  if (i < 0 || i >= ordered.length) return;
  clearTimeout(saveTimer); persistSession();
  idx = i; renderQuestion(); renderPalette();
  $("xc-qpanel").scrollIntoView({ block: "start", behavior: "smooth" });
}

function renderPalette() {
  const done = ordered.filter(answered).length;
  const flags = ordered.filter((q) => session.flags[q.id]).length;
  $("xc-palette").innerHTML = `
    <div class="xc-palette-card">
      <h4><i class="fa-solid fa-table-cells"></i> Questions</h4>
      <div class="xc-pgrid">${ordered.map((q, i) => `
        <button type="button" class="xc-pbtn ${answered(q) ? "done" : ""} ${session.flags[q.id] ? "flag" : ""} ${i === idx ? "current" : ""}" data-i="${i}" aria-label="Question ${i + 1}${answered(q) ? ", answered" : ""}${session.flags[q.id] ? ", flagged" : ""}">${i + 1}</button>`).join("")}
      </div>
      <div class="xc-legend"><span><i class="dot done"></i> Answered</span><span><i class="dot"></i> Unanswered</span><span><i class="dot flag"></i> Flagged</span></div>
      <p class="xc-progress-text"><b>${done}</b> of ${ordered.length} answered${flags ? ` · <b>${flags}</b> flagged` : ""}</p>
      <button type="button" class="btn-gold xc-submit" id="submit-btn"><i class="fa-solid fa-paper-plane"></i> Submit exam</button>
    </div>`;
  $("xc-palette").querySelectorAll(".xc-pbtn").forEach((b) => b.onclick = () => go(Number(b.dataset.i)));
  $("submit-btn").onclick = askSubmit;
}

/* ---------- keyboard: A–E choose, ←/→ (or P/N) navigate, F flags ---------- */
document.addEventListener("keydown", (e) => {
  if (!running || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$("xc-confirm").classList.contains("xc-hidden")) { if (e.key === "Escape") closeConfirm(); return; }
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "textarea" || (tag === "input" && e.target.type !== "radio")) return;
  const q = ordered[idx];
  const k = e.key.toLowerCase();
  // Arrow keys belong to the radio group when an option has focus (native, accessible behaviour).
  const onRadio = tag === "input";
  if ((!onRadio && k === "arrowright") || k === "n") { go(idx + 1); }
  else if ((!onRadio && k === "arrowleft") || k === "p") { go(idx - 1); }
  else if (k === "f") { $("flag-btn").click(); }
  else if (q && q.type !== "theory" && k.length === 1 && k >= "a" && k <= "e") {
    const inputs = document.querySelectorAll('input[name="opt"]');
    const target = inputs[k.charCodeAt(0) - 97];
    if (target) { target.checked = true; target.dispatchEvent(new Event("change")); }
  }
});

/* ==========================================================================
   SUBMIT
   ========================================================================== */
function askSubmit() {
  const total = ordered.length, done = ordered.filter(answered).length;
  const flags = ordered.filter((q) => session.flags[q.id]).length;
  const unanswered = total - done;
  $("xc-confirm-text").innerHTML = `You have answered <b>${done}</b> of <b>${total}</b> questions.` +
    (unanswered ? ` <span class="xc-warn-text"><b>${unanswered}</b> ${unanswered === 1 ? "question is" : "questions are"} unanswered.</span>` : "") +
    (flags ? ` <b>${flags}</b> flagged.` : "") + `<br>This cannot be undone.`;
  $("xc-confirm").classList.remove("xc-hidden");
  $("xc-confirm-ok").focus();
}
function closeConfirm() { $("xc-confirm").classList.add("xc-hidden"); }
$("xc-confirm-cancel").onclick = closeConfirm;
$("xc-confirm-ok").onclick = () => { closeConfirm(); submit(false); };

async function submit(auto, reason) {
  if (submitting || !session) return;
  submitting = true; running = false;
  clearInterval(timerId); clearTimeout(saveTimer);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  $("warning-overlay").style.display = "none";
  closeConfirm();

  let objectiveScore = 0, objectiveTotal = 0, theoryTotal = 0;
  const answers = {}, theoryAnswers = [];
  ordered.forEach((q) => {
    const marks = Number(q.marks) || (q.type === "theory" ? 10 : 1);
    if (q.type === "theory") {
      theoryTotal += marks;
      theoryAnswers.push({ qid: q.id, question: q.stem, text: String(session.answers[q.id] || ""), marks, awarded: null, feedback: "" });
    } else {
      objectiveTotal += marks;
      const a = session.answers[q.id];
      if (a) answers[q.id] = a;
      if (a && a === q.correct) objectiveScore += marks;
    }
  });
  const sum = summarize({ objectiveScore, objectiveTotal, theoryScore: null, theoryTotal, passMark: exam.passMark ?? 50 });
  const now = new Date();

  const payload = {
    resultId: newResultId(user.uid, examId),
    studentUid: user.uid, studentId: profile.studentId || "", studentName: profile.fullName || "",
    examId, examTitle: exam.title, categoryId: exam.categoryId || "", subjectId: exam.subjectId || "", subjectName: exam.subjectName || "",
    attempt: session.attempt, passMark: exam.passMark ?? 50,
    objectiveScore, objectiveTotal, theoryScore: null, theoryTotal,
    score: sum.score, total: sum.total, percent: sum.percent, grade: sum.grade, passed: sum.passed,
    needsManualGrading: sum.needsManualGrading,
    answers, theoryAnswers, questionOrder: ordered.map((q) => q.id),
    autoSubmitted: !!auto, reason: reason || "",
    timeUsedSec: Math.min(Math.round((Date.now() - session.startedAt) / 1000), (exam.durationMinutes || 30) * 60),
    tabSwitches: session.tabSwitches || 0, fullscreenExits: session.exits || 0, secureMode: isSecure(),
    date: now.toLocaleDateString(), submittedAtISO: now.toISOString()
  };

  $("xc-run").classList.add("xc-hidden");
  $("exam-timer").style.display = "none";
  $("xc-result").classList.remove("xc-hidden");
  $("xc-result").innerHTML = `<div class="glass-card"><div class="ui-loading-state"><div class="ui-spinner"></div><p>Submitting your exam…</p></div></div>`;

  const state = await saveResult(payload); // "saved" | "queued"
  clearSession(user.uid, examId);
  logActivity(user.uid, "student", "xc_exam_submit", examId); // best-effort; never throws
  renderResult(payload, { auto, reason, state });
}

/* ==========================================================================
   RESULT + REVIEW
   ========================================================================== */
function renderResult(r, { auto, reason, state } = {}) {
  const canReview = exam.reviewMode !== "none";
  const mins = Math.floor((r.timeUsedSec || 0) / 60), secs = (r.timeUsedSec || 0) % 60;
  const max = Number(exam.maxAttempts ?? 1);
  const canRetry = max === 0 || (r.attempt || 1) < max;
  $("xc-result").classList.remove("xc-hidden");
  $("xc-intro").classList.add("xc-hidden");
  $("xc-result").innerHTML = `
    <div class="glass-card xc-result-card">
      ${state === "queued" ? `<div class="xc-banner warn"><i class="fa-solid fa-cloud-arrow-up"></i> You appear to be offline. Your result is safely stored on this device and will upload automatically when you're back online.</div>` : ""}
      ${auto ? `<div class="xc-banner warn">${escapeHtml(reason || "Your exam was submitted automatically.")}</div>` : ""}
      <div class="xc-score-ring" style="--p:${r.percent}"><div><b>${r.percent}%</b><small>${r.needsManualGrading ? "objective" : "score"}</small></div></div>
      <h3>${r.needsManualGrading ? "Exam submitted" : r.passed ? "Well done — you passed!" : "Exam completed"}</h3>
      <p class="xc-result-line"><b>${r.score} / ${r.total}</b> marks · Grade <b>${escapeHtml(r.grade)}</b> · pass mark ${r.passMark ?? 50}%</p>
      ${r.needsManualGrading ? `<p class="xc-muted"><i class="fa-solid fa-hourglass-half"></i> Your written (theory) answers will be marked by your teacher. Your final score will update after marking.</p>` : ""}
      <div class="xc-pills big center">
        <span><i class="fa-regular fa-clock"></i> ${mins}m ${secs}s used</span>
        <span><i class="fa-solid fa-check"></i> ${Object.keys(r.answers || {}).length + (r.theoryAnswers || []).filter((t) => (t.text || "").trim()).length} answered</span>
        ${r.secureMode && r.tabSwitches ? `<span><i class="fa-solid fa-eye-slash"></i> ${plural(r.tabSwitches, "tab switch", "tab switches")}</span>` : ""}
      </div>
      <div class="xc-intro-actions center">
        ${canReview ? `<button class="btn-gold" id="review-btn"><i class="fa-solid fa-magnifying-glass-chart"></i> Review answers</button>` : ""}
        ${canRetry ? `<a class="btn-outline" href="exam-session.html?exam=${encodeURIComponent(examId)}"><i class="fa-solid fa-rotate-right"></i> Try again</a>` : ""}
        <a class="btn-navy" href="student.html"><i class="fa-solid fa-arrow-left"></i> Back to dashboard</a>
      </div>
    </div>
    <div id="xc-review"></div>`;
  const rb = $("review-btn");
  if (rb) rb.onclick = () => { $("xc-review").innerHTML = reviewHtml(r); rb.disabled = true; $("xc-review").scrollIntoView({ behavior: "smooth" }); };
}

function reviewHtml(r) {
  const order = (r.questionOrder || questions.map((q) => q.id)).map((id) => byId[id]).filter(Boolean);
  const taById = Object.fromEntries((r.theoryAnswers || []).map((t) => [t.qid, t]));
  return `<div class="xc-review"><h3><i class="fa-solid fa-magnifying-glass-chart"></i> Review</h3>` + order.map((q, i) => {
    let body, verdict = "";
    if (q.type === "theory") {
      const t = taById[q.id];
      const graded = t && typeof t.awarded === "number";
      verdict = graded ? `<span class="xc-verdict ${t.awarded >= (t.marks || 1) / 2 ? "ok" : "bad"}">${t.awarded} / ${t.marks}</span>` : `<span class="xc-verdict pending">Awaiting marking</span>`;
      body = `<div class="xc-answer-box"><small>Your answer</small>${t && (t.text || "").trim() ? rich(t.text, { breaks: true }) : "<em>No answer given.</em>"}</div>
        ${t && t.feedback ? `<div class="xc-callout xc-callout-note"><div class="xc-callout-title">Teacher's feedback</div>${rich(t.feedback, { breaks: true })}</div>` : ""}`;
    } else {
      const mine = (r.answers || {})[q.id];
      const ok = mine === q.correct;
      verdict = mine ? `<span class="xc-verdict ${ok ? "ok" : "bad"}">${ok ? "Correct" : "Incorrect"}</span>` : `<span class="xc-verdict pending">Not answered</span>`;
      body = `<div class="xc-options review">` + Object.keys(q.options || {}).filter((k) => q.options[k]).sort().map((k) => `
        <div class="xc-option ${k === q.correct ? "correct" : ""} ${k === mine && !ok ? "wrong" : ""}">
          <span class="xc-letter">${escapeHtml(k)}</span><span class="xc-opt-text">${rich(q.options[k], { inline: true })}</span>
          ${k === q.correct ? `<i class="fa-solid fa-circle-check mark"></i>` : k === mine ? `<i class="fa-solid fa-circle-xmark mark"></i>` : ""}
        </div>`).join("") + `</div>`;
    }
    return `<article class="xc-qcard review">
        <div class="xc-qhead"><span class="xc-qnum">Question ${i + 1}</span>${verdict}</div>
        <div class="xc-stem">${rich(q.stem, { breaks: true })}</div>${body}
        ${q.explanation ? `<div class="xc-callout xc-callout-key"><div class="xc-callout-title">${q.type === "theory" ? "Marking guide / model answer" : "Explanation"}</div>${rich(q.explanation, { breaks: true })}</div>` : ""}
      </article>`;
  }).join("") + `</div>`;
}

async function showReviewById(id) {
  try {
    const snap = await getDoc(doc(db, XC.results, id));
    if (!snap.exists() || snap.data().studentUid !== user.uid || snap.data().examId !== examId) return fatal("That result could not be found.");
    const r = { id: snap.id, ...snap.data() };
    if (exam.reviewMode === "none") return fatal("Answer review is not available for this exam.");
    renderResult(r, {});
    $("review-btn")?.click();
  } catch (e) { console.error(e); fatal("Could not load your result. Please try again."); }
}

/* ==========================================================================
   SECURE MODE (mirrors the original exam page's measures)
   ========================================================================== */
$("resume-btn").onclick = () => enterFullscreen();

document.addEventListener("fullscreenchange", () => {
  if (!running || !isSecure() || document.fullscreenElement) return;
  session.exits = (session.exits || 0) + 1; persistSession();
  if (session.exits > MAX_EXITS) { submit(true, "Auto-submitted: exited fullscreen too many times."); return; }
  $("warning-overlay").style.display = "flex";
  $("warning-text").textContent = `You exited fullscreen (${session.exits}/${MAX_EXITS}). Return now or your exam will auto-submit.`;
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running && isSecure()) {
    session.tabSwitches = (session.tabSwitches || 0) + 1; persistSession();
    toast("Tab-switch detected and logged.", "error");
  }
});
document.addEventListener("contextmenu", (e) => { if (running && isSecure()) e.preventDefault(); });
document.addEventListener("copy", (e) => { if (running && isSecure() && !/textarea/i.test(e.target.tagName)) e.preventDefault(); });
document.addEventListener("keydown", (e) => {
  if (!running || !isSecure()) return;
  const blocked = e.key === "F12" || (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key)) || (e.ctrlKey && ["u", "p", "s"].includes(e.key.toLowerCase()));
  if (blocked) { e.preventDefault(); toast("This action is disabled during the exam.", "error"); }
});

// Warn before accidentally closing/reloading mid-exam (progress is saved either way).
window.addEventListener("beforeunload", (e) => { if (running) { persistSession(); e.preventDefault(); e.returnValue = ""; } });

// If the same exam is submitted in another tab, stop this one so it can't create a second attempt.
window.addEventListener("storage", (e) => {
  if (running && user && e.key === sessionKeyFor(user.uid, examId) && e.newValue === null) { running = false; window.location.reload(); }
});
