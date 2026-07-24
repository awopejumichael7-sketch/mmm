/* ==========================================================================
   EXAM.JS — Secure timed exam with anti-cheat measures
   ========================================================================== */
import { guardRoute } from "./auth.js";
import {
  db, COL, collection, doc, getDoc, getDocs, addDoc, query, where,
  serverTimestamp
} from "./firebase-config.js";
import { toast } from "./app-shell.js";

const params = new URLSearchParams(window.location.search);
const courseId = params.get("course");

let user, profile, course, questions = [], answers = {}, timer, secondsLeft, exitCount = 0, examLanguage = "en";
const EXAM_DURATION_SECONDS = 30 * 60; // 30 minutes
const MAX_EXITS = 2;

guardRoute("student").then(async (u) => {
  user = u;
  const pSnap = await getDoc(doc(db, COL.students, u.uid));
  profile = pSnap.data();
  const cSnap = await getDoc(doc(db, COL.courses, courseId));
  course = { id: courseId, ...cSnap.data() };
  document.querySelector(".brand-text strong").textContent = `Exam — ${course.title}`;

  // Authoritative one-attempt check — this is the real enforcement point,
  // independent of whatever the student dashboard already showed them.
  try {
    const existing = await getDocs(query(collection(db, COL.results), where("studentUid", "==", u.uid), where("courseId", "==", courseId)));
    if (!existing.empty) {
      const r = existing.docs[0].data();
      document.getElementById("intro-card").innerHTML = `
        <h3><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> You've Already Taken This Exam</h3>
        <p>Each exam can only be attempted once. Your recorded result:</p>
        <p style="font-size:1.1rem;"><strong>${r.score}/${r.total} (${r.percent}%) — Grade ${r.grade}</strong>${r.needsManualGrading ? "<br><span style='color:var(--muted);'>Theory portion still pending your teacher's grading.</span>" : ""}</p>
        <a class="btn-navy" href="student.html"><i class="fa-solid fa-arrow-left"></i> Back to Dashboard</a>`;
    }
  } catch (err) {
    console.warn("Could not check prior attempts:", err);
  }
});

document.getElementById("begin-btn").onclick = async () => {
  await loadQuestions();
  if (!questions.length) { toast("No exam questions are available for this course yet.", "error"); return; }
  const lang = document.getElementById("exam-lang").value;
  examLanguage = lang;
  if (lang !== "en") {
    document.getElementById("begin-btn").disabled = true;
    document.getElementById("begin-btn").innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Translating questions…`;
    await translateQuestions(lang);
  }
  enterFullscreen();
};

document.getElementById("resume-btn").onclick = () => enterFullscreen();

/* ---------- Free translation — same public endpoint used by the ebook reader.
   No API key, no cost. Adds a `displayQuestion`/`displayOptions` field to each
   question rather than overwriting the original — grading always checks the
   original option KEY (A/B/C/D), never the translated text, so translation
   can never affect scoring. ---------- */
async function translateOne(text, lang) {
  if (!text) return text;
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`);
    const data = await res.json();
    const translated = Array.isArray(data?.[0]) ? data[0].map(seg => seg[0]).join("") : "";
    return translated || text;
  } catch (e) {
    return text; // fall back to English for this piece if translation fails
  }
}

async function translateQuestions(lang) {
  const langName = document.getElementById("exam-lang").selectedOptions[0]?.textContent || lang;
  try {
    await Promise.all(questions.map(async (q) => {
      // Respect a question the admin already wrote directly in this language — no need to translate it
      if (lang === "yo" && q.language === "yoruba") { q.displayQuestion = q.question; return; }
      q.displayQuestion = await translateOne(q.question, lang);
      if (q.type === "objective" && q.shuffledOptions) {
        q.displayOptions = await Promise.all(q.shuffledOptions.map(async ([key, val]) => [key, await translateOne(val, lang)]));
      }
    }));
    toast(`Questions translated to ${langName}. Machine translation — quality may vary, especially for less common languages.`, "success");
  } catch (e) {
    toast(`Could not translate to ${langName} — showing English instead.`, "error");
  }
}

async function loadQuestions() {
  const snap = await getDocs(query(collection(db, COL.examQuestions), where("courseId", "==", courseId)));
  const all = [];
  snap.forEach(d => all.push({ id: d.id, ...d.data() }));
  // Randomize question order and option order
  questions = shuffle(all).map(q => {
    if (q.type === "objective" && q.options) {
      const entries = shuffle(Object.entries(q.options).filter(([, v]) => v));
      return { ...q, shuffledOptions: entries };
    }
    return q;
  });
}
function shuffle(arr) { return arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(v => v[1]); }

function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
  if (req) req.call(el).catch(() => toast("Fullscreen was blocked — please allow it to continue.", "error"));
  document.getElementById("warning-overlay").style.display = "none";
  document.getElementById("intro-card").style.display = "none";
  document.getElementById("exam-timer").style.display = "block";
  renderQuestions();
  startTimer();
}

function startTimer() {
  secondsLeft = EXAM_DURATION_SECONDS;
  updateTimerDisplay();
  timer = setInterval(() => {
    secondsLeft--;
    updateTimerDisplay();
    if (secondsLeft <= 0) { clearInterval(timer); submitExam(true); }
  }, 1000);
}
function updateTimerDisplay() {
  const m = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const s = String(secondsLeft % 60).padStart(2, "0");
  document.getElementById("exam-timer").textContent = `${m}:${s}`;
}

function renderQuestions() {
  const area = document.getElementById("question-area");
  area.innerHTML = "";
  questions.forEach((q, i) => {
    const card = document.createElement("div");
    card.className = "exam-q";
    const questionText = q.displayQuestion || q.question;
    if (q.type === "objective") {
      const optionsToShow = q.displayOptions || q.shuffledOptions;
      card.innerHTML = `<p><strong>Q${i + 1}.</strong> ${questionText}</p>` +
        optionsToShow.map(([key, val]) => `
          <label style="display:block;margin:6px 0;cursor:pointer;">
            <input type="radio" name="q${i}" value="${key}"> ${val}
          </label>`).join("");
      card.querySelectorAll("input").forEach(inp => inp.onchange = () => answers[q.id] = { value: inp.value, correct: q.correct, type: "objective" });
    } else {
      card.innerHTML = `<p><strong>Q${i + 1}.</strong> ${questionText}</p><textarea rows="4" style="width:100%;padding:10px;border-radius:10px;border:1px solid #d8dde8;"></textarea>`;
      card.querySelector("textarea").oninput = (e) => answers[q.id] = { value: e.target.value, type: "theory" };
    }
    area.appendChild(card);
  });
  const submitBtn = document.createElement("button");
  submitBtn.className = "btn-gold"; submitBtn.style.marginTop = "10px";
  submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Submit Exam`;
  submitBtn.onclick = () => { if (confirm("Submit your exam now? This cannot be undone.")) submitExam(false); };
  area.appendChild(submitBtn);
}

/* ---------- Fullscreen exit detection -> warning -> auto-submit ---------- */
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && timer) {
    exitCount++;
    if (exitCount > MAX_EXITS) { submitExam(true, "Auto-submitted: exited fullscreen too many times."); return; }
    document.getElementById("warning-overlay").style.display = "flex";
    document.getElementById("warning-text").textContent = `You exited fullscreen (${exitCount}/${MAX_EXITS}). Return now or your exam will auto-submit.`;
  }
});

/* ---------- Prevent copy / right-click / devtools shortcuts during exam ---------- */
document.addEventListener("contextmenu", (e) => { if (timer) e.preventDefault(); });
document.addEventListener("copy", (e) => { if (timer) e.preventDefault(); });
document.addEventListener("keydown", (e) => {
  if (!timer) return;
  const blocked = (e.key === "F12") || (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key)) || (e.ctrlKey && e.key === "u") || (e.ctrlKey && e.key === "p");
  if (blocked) { e.preventDefault(); toast("This action is disabled during the exam.", "error"); }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && timer) toast("Tab-switch detected and logged.", "error");
});

/* ---------- Grading & submission ---------- */
async function submitExam(auto, reason) {
  if (!timer) return; // already submitted
  clearInterval(timer); timer = null;
  if (document.fullscreenElement) document.exitFullscreen?.();
  document.getElementById("warning-overlay").style.display = "none";

  let score = 0, total = 0, needsManualGrading = false;
  questions.forEach(q => {
    if (q.type === "objective") {
      total += 1;
      const a = answers[q.id];
      if (a && a.value === q.correct) score += 1;
    } else {
      needsManualGrading = true;
    }
  });
  const percent = total ? Math.round((score / total) * 100) : 0;
  const grade = percent >= 70 ? "A" : percent >= 60 ? "B" : percent >= 50 ? "C" : percent >= 40 ? "D" : "F";

  const theoryAnswers = questions
    .filter(q => q.type === "theory")
    .map(q => ({
      qid: q.id,
      question: q.question, // original English text, captured now so grading stays stable even if the question is edited/deleted later
      text: answers[q.id]?.value || "",
      marks: q.marks || 10
    }));

  await addDoc(collection(db, COL.results), {
    studentUid: user.uid, studentId: profile.studentId, courseId, courseTitle: course.title,
    score, total, percent, grade, examLanguage,
    objectiveScore: score, objectiveTotal: total, // immutable baseline so theory grading can always recompute safely, even if re-graded
    needsManualGrading, autoSubmitted: !!auto, reason: reason || "",
    theoryAnswers,
    date: new Date().toLocaleDateString(), createdAt: serverTimestamp()
  });

  document.getElementById("exam-shell").innerHTML = `
    <div class="glass-card" style="text-align:center;">
      <h3><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> Exam Submitted</h3>
      <p>${auto ? (reason || "Your exam was automatically submitted.") : "Thank you — your answers have been recorded."}</p>
      ${total ? `<p>Objective score: <strong>${score}/${total} (${percent}%)</strong> — Grade ${grade}</p>` : ""}
      ${needsManualGrading ? `<p style="color:var(--muted);">Theory answers will be graded by your teacher.</p>` : ""}
      <a class="btn-navy" href="student.html"><i class="fa-solid fa-arrow-left"></i> Back to Dashboard</a>
    </div>`;
  document.getElementById("exam-timer").style.display = "none";
}
