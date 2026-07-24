/* ==========================================================================
   STUDENT.JS — Student Dashboard (supports multiple enrolled courses)
   ========================================================================== */
import { guardRoute, logout } from "./auth.js";
import {
  db, COL, ICE_CONFIG, collection, doc, setDoc, getDoc, getDocs, addDoc, deleteDoc, query, where,
  onSnapshot, serverTimestamp, increment, logActivity
} from "./firebase-config.js";
import { toast, initTheme, toggleTheme, registerServiceWorker, protectElement, queueOfflineAction, initOfflineWatcher } from "./app-shell.js";
import { fetchPublicDriveFile } from "./drive-config.js";
import { renderWhiteboard, stopWhiteboard } from "./whiteboard.js";
import { renderCalculator } from "./calculator.js";
import { renderDictionary } from "./dictionary.js";

initTheme();
registerServiceWorker();
const main = document.getElementById("main-content");
document.getElementById("theme-btn").onclick = toggleTheme;
document.getElementById("logout-btn").onclick = logout;

let user, profile, myCourses = [], course, currentView = "overview";

guardRoute("student").then(async (u) => {
  user = u;
  const snap = await getDoc(doc(db, COL.students, u.uid));
  profile = snap.data();

  const courseIds = profile.courseIds || (profile.courseId ? [profile.courseId] : []); // backward-compatible
  myCourses = [];
  for (const id of courseIds) {
    const cSnap = await getDoc(doc(db, COL.courses, id));
    if (cSnap.exists()) myCourses.push({ id, ...cSnap.data() });
  }
  const savedId = localStorage.getItem("cacgw_selected_course");
  course = myCourses.find(c => c.id === savedId) || myCourses[0] || null;

  bindSidebar();
  renderOverview();
  markAttendance();
  initOfflineWatcher({
    attendance: async (payload) => { await addDoc(collection(db, COL.attendance), payload); }
  });
});

function bindSidebar() {
  document.querySelectorAll(".sidebar a").forEach(a => {
    a.addEventListener("click", () => {
      document.querySelectorAll(".sidebar a").forEach(x => x.classList.remove("active"));
      a.classList.add("active");
      if (currentView === "live" && a.dataset.view !== "live") leaveLive();
      if (currentView === "whiteboard" && a.dataset.view !== "whiteboard") stopWhiteboard();
      currentView = a.dataset.view;
      views()[currentView]();
    });
  });
}
function views() {
  return {
    overview: renderOverview, library: renderLibrary, media: renderMedia, live: renderLive,
    exams: renderExams, certificates: renderCertificates,
    questions: renderQuestions, feedback: renderFeedback,
    whiteboard: renderWhiteboardView, calculator: renderCalculatorView, dictionary: renderDictionaryView
  };
}

/* ---------- Whiteboard (free, shared live with the teacher & classmates) ---------- */
function renderWhiteboardView() {
  currentView = "whiteboard";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = courseSwitcherHTML() + `<div id="wb-host"></div>`;
  bindCourseSwitcher();
  renderWhiteboard(document.getElementById("wb-host"), course.id);
}

/* ---------- Scientific calculator (free, fully offline) ---------- */
function renderCalculatorView() {
  currentView = "calculator";
  renderCalculator(main);
}

/* ---------- Dictionary (free, keyless public API) ---------- */
function renderDictionaryView() {
  currentView = "dictionary";
  renderDictionary(main);
}

/* ---------- Course switcher — shown at the top of every course-specific view ---------- */
function courseSwitcherHTML() {
  if (myCourses.length <= 1) return "";
  const opts = myCourses.map(c => `<option value="${c.id}" ${course && c.id === course.id ? "selected" : ""}>${c.code} — ${c.title}</option>`).join("");
  return `<div class="glass-card" style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <label style="font-weight:600;color:var(--muted);"><i class="fa-solid fa-graduation-cap"></i> Viewing course:</label>
      <select id="course-switcher" style="padding:8px 12px;border-radius:10px;border:1px solid #d8dde8;">${opts}</select>
    </div>`;
}
function bindCourseSwitcher() {
  const sel = document.getElementById("course-switcher");
  if (!sel) return;
  sel.onchange = async () => {
    if (currentView === "live" && studentPc) await leaveLive();
    course = myCourses.find(c => c.id === sel.value);
    localStorage.setItem("cacgw_selected_course", course.id);
    views()[currentView]();
  };
}

/* ---------- Auto attendance on login (works offline via queue) ---------- */
async function markAttendance() {
  if (!course) return;
  const now = new Date();
  const payload = {
    studentId: profile.studentId, courseId: course.id,
    date: now.toISOString().slice(0, 10), time: now.toLocaleTimeString(),
    device: navigator.userAgent, browser: navigator.userAgentData?.brands?.[0]?.brand || "Browser",
    createdAt: new Date().toISOString()
  };
  if (navigator.onLine) {
    try { await addDoc(collection(db, COL.attendance), payload); } catch (e) { queueOfflineAction({ type: "attendance", payload }); }
  } else {
    queueOfflineAction({ type: "attendance", payload });
  }
}

function renderOverview() {
  currentView = "overview";
  const courseList = myCourses.length
    ? myCourses.map(c => `<span class="badge active" style="margin-right:6px;">${c.code}</span>`).join("")
    : "None yet — contact your Administrator";
  main.innerHTML = `
    <h2>Welcome, ${profile.fullName}</h2>
    <p style="color:var(--muted);">Enrolled in ${myCourses.length} course(s): ${courseList}</p>
    <div class="stat-grid">
      <div class="stat-card"><div class="num"><i class="fa-solid fa-id-card"></i></div><div class="label">${profile.studentId}</div></div>
      <div class="stat-card"><div class="num">${myCourses.length}</div><div class="label">Enrolled Courses</div></div>
      <div class="stat-card"><div class="num">${course ? course.code : "—"}</div><div class="label">Currently Viewing</div></div>
    </div>
    <div class="glass-card">
      <h4>Quick Links</h4>
      <button class="btn-navy" onclick="document.querySelector('[data-view=library]').click()"><i class="fa-solid fa-book-open"></i> Open Library</button>
      <button class="btn-gold" onclick="document.querySelector('[data-view=exams]').click()"><i class="fa-solid fa-file-pen"></i> View Exams</button>
    </div>`;
}

/* ---------- Library: ebook / handbook / syllabus ---------- */
async function renderLibrary() {
  currentView = "library";
  if (!course) { main.innerHTML = "<p>You are not enrolled in a course yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-book-open"></i> Library — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div id="lib-tabs" class="tab-strip">
    <button data-t="ebooks" class="active">Ebooks</button><button data-t="handbooks">Handbook</button><button data-t="syllabus">Syllabus</button>
    <button data-t="materials">Lesson Notes & Assignments</button></div><div id="lib-list">Loading…</div>`;
  bindCourseSwitcher();

  const load = async (type) => {
    const wrap = document.getElementById("lib-list");
    wrap.innerHTML = "Loading…";
    const colName = type === "materials" ? "materials" : type;
    let snap;
    try { snap = await getDocs(query(collection(db, colName), where("courseId", "==", course.id))); }
    catch (e) { wrap.innerHTML = "<p>Could not load — check your connection.</p>"; return; }
    if (snap.empty) { wrap.innerHTML = "<p>Nothing uploaded here yet.</p>"; return; }
    wrap.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      const card = document.createElement("div");
      card.className = "glass-card";
      card.style.marginBottom = "10px";
      const readerParams = item.source === "drive"
        ? `ebook-reader.html?source=drive&fileId=${encodeURIComponent(item.driveFileId)}&title=${encodeURIComponent(item.title)}`
        : `ebook-reader.html?url=${encodeURIComponent(item.url)}&title=${encodeURIComponent(item.title)}`;
      card.innerHTML = `<strong>${item.title}</strong> ${item.source === "drive" ? '<span class="badge active"><i class="fa-brands fa-google-drive"></i> Drive</span>' : ""}
        <div style="margin-top:8px;">
          ${type === "ebooks" || type === "handbooks"
            ? `<button class="btn-gold" onclick="window.open('${readerParams}','_blank')"><i class="fa-solid fa-book"></i> Read</button>`
            : `<a class="btn-outline" href="${item.url}" target="_blank" rel="noopener"><i class="fa-solid fa-eye"></i> View</a>`}
        </div>`;
      wrap.appendChild(card);
    });
  };
  document.querySelectorAll("#lib-tabs button").forEach(b => {
    b.onclick = () => { document.querySelectorAll("#lib-tabs button").forEach(x => x.classList.remove("active")); b.classList.add("active"); load(b.dataset.t); };
  });
  load("ebooks");
}

/* ---------- Media: stream-only audio/video, no download, no right-click ---------- */
async function renderMedia() {
  currentView = "media";
  if (!course) { main.innerHTML = "<p>You are not enrolled in a course yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-photo-film"></i> Audio & Video — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div id="media-tabs" class="tab-strip"><button data-t="audio" class="active">Audio Teachings</button><button data-t="videos">Videos</button></div>
    <div id="media-list">Loading…</div>`;
  bindCourseSwitcher();
  const load = async (type) => {
    const wrap = document.getElementById("media-list");
    wrap.innerHTML = "Loading…";
    const snap = await getDocs(query(collection(db, COL[type]), where("courseId", "==", course.id)));
    if (snap.empty) { wrap.innerHTML = "<p>Nothing here yet.</p>"; return; }
    wrap.innerHTML = "";
    snap.forEach(async (d) => {
      const item = d.data();
      const card = document.createElement("div");
      card.className = "glass-card"; card.style.marginBottom = "12px";
      card.innerHTML = `<strong>${item.title}</strong> ${item.source === "drive" ? '<span class="badge active"><i class="fa-brands fa-google-drive"></i> Drive</span>' : ""}<br>
        <div class="media-slot" style="margin-top:8px;color:var(--muted);">Loading media…</div>`;
      protectElement(card);
      wrap.appendChild(card);
      const slot = card.querySelector(".media-slot");
      try {
        let src = item.url;
        if (item.source === "drive") {
          const blob = await fetchPublicDriveFile(item.driveFileId);
          src = URL.createObjectURL(blob);
        }
        slot.outerHTML = type === "audio"
          ? `<audio controls controlsList="nodownload noplaybackrate" src="${src}" style="width:100%;margin-top:8px;"></audio>`
          : `<video controls controlsList="nodownload noplaybackrate" src="${src}" style="width:100%;margin-top:8px;border-radius:10px;"></video>`;
      } catch (err) {
        slot.textContent = "Could not load this media: " + (err?.message || "unknown error.");
      }
    });
  };
  document.querySelectorAll("#media-tabs button").forEach(b => {
    b.onclick = () => { document.querySelectorAll("#media-tabs button").forEach(x => x.classList.remove("active")); b.classList.add("active"); load(b.dataset.t); };
  });
  load("audio");
}

/* ---------- Live Class: join teacher's real-time broadcast (not recorded).
   Students can also turn on their own camera/mic so the teacher can see/hear
   them — the connection is bidirectional, negotiated as sendrecv from the
   student's side, with tracks attached only once the student opts in. ---------- */
let studentPc = null, teacherCandidatesUnsub = null, answerUnsub = null, sessionUnsub = null;
let studentLocalStream = null, videoTransceiver = null, audioTransceiver = null;

async function renderLive() {
  currentView = "live";
  if (!course) { main.innerHTML = "<p>You are not enrolled in a course yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-tower-broadcast"></i> Live Class — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div class="glass-card" id="live-wrap"><p>Checking for a live session…</p></div>`;
  bindCourseSwitcher();

  if (sessionUnsub) { sessionUnsub(); sessionUnsub = null; }
  const sessionRef = doc(db, COL.liveSessions, course.id);
  sessionUnsub = onSnapshot(sessionRef, (snap) => {
    const wrap = document.getElementById("live-wrap");
    if (!wrap) return;
    const isActive = snap.exists() && snap.data().active;
    if (!isActive) {
      if (studentPc) leaveLive();
      wrap.innerHTML = `<p><i class="fa-solid fa-circle-info"></i> No live class is running right now. Check back when your teacher goes live — this page updates automatically.</p>`;
      return;
    }
    if (!studentPc) {
      wrap.innerHTML = `<p><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> Your teacher is live now!</p>
        <button class="btn-gold" id="join-live"><i class="fa-solid fa-video"></i> Join Live Class</button>`;
      document.getElementById("join-live").onclick = () => joinLive();
    }
  });
}

async function joinLive() {
  const wrap = document.getElementById("live-wrap");
  wrap.innerHTML = `
    <div class="tab-strip" id="live-tabs">
      <button data-t="class" class="active"><i class="fa-solid fa-video"></i> Class</button>
      <button data-t="whiteboard"><i class="fa-solid fa-chalkboard"></i> Whiteboard</button>
      <button data-t="calculator"><i class="fa-solid fa-calculator"></i> Calculator</button>
      <button data-t="dictionary"><i class="fa-solid fa-book"></i> Dictionary</button>
    </div>
    <div id="live-panel-class">
      <div class="studio-preview"><video id="live-video" autoplay playsinline></video></div>
      <p style="color:var(--muted);font-size:.85rem;margin:8px 0;">Teacher's broadcast — this is live and is not being recorded.</p>
      <div class="studio-controls">
        <button class="btn-navy" id="my-cam-toggle"><i class="fa-solid fa-camera"></i> Turn On My Camera</button>
        <button class="btn-navy" id="my-mic-toggle"><i class="fa-solid fa-microphone"></i> Turn On My Mic</button>
        <button class="btn-danger" id="leave-live">Leave Live Class</button>
      </div>
      <div id="my-preview-wrap" style="margin-top:12px;display:none;max-width:220px;">
        <div class="studio-preview"><video id="my-preview" autoplay muted playsinline></video></div>
        <small style="color:var(--muted);">Your camera — visible to your teacher</small>
      </div>
    </div>
    <div id="live-panel-whiteboard" style="display:none;">
      <p style="color:var(--muted);font-size:.85rem;"><i class="fa-solid fa-circle-info"></i> Draw here together with your teacher and classmates in real time.</p>
      <div id="live-wb-host"></div>
    </div>
    <div id="live-panel-calculator" style="display:none;"></div>
    <div id="live-panel-dictionary" style="display:none;"></div>`;
  protectElement(document.getElementById("live-panel-class"));
  document.getElementById("leave-live").onclick = leaveLive;
  document.getElementById("my-cam-toggle").onclick = toggleMyCamera;
  document.getElementById("my-mic-toggle").onclick = toggleMyMic;

  const liveTabInited = { whiteboard: false, calculator: false, dictionary: false };
  document.querySelectorAll("#live-tabs button").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#live-tabs button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      const t = b.dataset.t;
      ["class", "whiteboard", "calculator", "dictionary"].forEach(name => {
        document.getElementById(`live-panel-${name}`).style.display = name === t ? "" : "none";
      });
      if (t === "whiteboard" && !liveTabInited.whiteboard) {
        renderWhiteboard(document.getElementById("live-wb-host"), course.id);
        liveTabInited.whiteboard = true;
      }
      if (t === "calculator" && !liveTabInited.calculator) {
        renderCalculator(document.getElementById("live-panel-calculator"));
        liveTabInited.calculator = true;
      }
      if (t === "dictionary" && !liveTabInited.dictionary) {
        renderDictionary(document.getElementById("live-panel-dictionary"));
        liveTabInited.dictionary = true;
      }
    };
  });

  studentPc = new RTCPeerConnection(ICE_CONFIG);
  // sendrecv from the start (with no track yet) so the student can start
  // sending camera/mic later without needing to renegotiate the connection.
  videoTransceiver = studentPc.addTransceiver("video", { direction: "sendrecv" });
  audioTransceiver = studentPc.addTransceiver("audio", { direction: "sendrecv" });

  const remoteStream = new MediaStream();
  studentPc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    const vid = document.getElementById("live-video");
    if (vid) vid.srcObject = remoteStream;
  };

  const viewerDocRef = doc(db, COL.liveSessions, course.id, "viewers", user.uid);
  studentPc.onicecandidate = (e) => {
    if (e.candidate) addDoc(collection(db, COL.liveSessions, course.id, "viewers", user.uid, "studentCandidates"), e.candidate.toJSON());
  };

  const offer = await studentPc.createOffer();
  await studentPc.setLocalDescription(offer);
  await setDoc(viewerDocRef, {
    offer: { type: offer.type, sdp: offer.sdp },
    studentName: profile.fullName, studentId: profile.studentId,
    joinedAt: serverTimestamp()
  });

  answerUnsub = onSnapshot(viewerDocRef, async (snap) => {
    const data = snap.data();
    if (data?.answer && studentPc && !studentPc.currentRemoteDescription) {
      await studentPc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });
  teacherCandidatesUnsub = onSnapshot(collection(db, COL.liveSessions, course.id, "viewers", user.uid, "teacherCandidates"), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added" && studentPc) studentPc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
    });
  });

  await logActivity(user.uid, "student", "join_live", course.id);
}

async function ensureLocalStream() {
  if (!studentLocalStream) {
    studentLocalStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("my-preview").srcObject = studentLocalStream;
    document.getElementById("my-preview-wrap").style.display = "block";
  }
  return studentLocalStream;
}

async function toggleMyCamera() {
  const btn = document.getElementById("my-cam-toggle");
  try {
    const stream = await ensureLocalStream();
    const track = stream.getVideoTracks()[0];
    if (!videoTransceiver.sender.track) {
      await videoTransceiver.sender.replaceTrack(track);
      btn.innerHTML = `<i class="fa-solid fa-video-slash"></i> Turn Off My Camera`;
      toast("Your camera is now visible to your teacher", "success");
    } else {
      await videoTransceiver.sender.replaceTrack(null);
      btn.innerHTML = `<i class="fa-solid fa-camera"></i> Turn On My Camera`;
      toast("Camera turned off", "success");
    }
  } catch (err) { toast("Could not access your camera.", "error"); }
}

async function toggleMyMic() {
  const btn = document.getElementById("my-mic-toggle");
  try {
    const stream = await ensureLocalStream();
    const track = stream.getAudioTracks()[0];
    if (!audioTransceiver.sender.track) {
      await audioTransceiver.sender.replaceTrack(track);
      btn.innerHTML = `<i class="fa-solid fa-microphone-slash"></i> Turn Off My Mic`;
      toast("Your microphone is now on", "success");
    } else {
      await audioTransceiver.sender.replaceTrack(null);
      btn.innerHTML = `<i class="fa-solid fa-microphone"></i> Turn On My Mic`;
      toast("Microphone turned off", "success");
    }
  } catch (err) { toast("Could not access your microphone.", "error"); }
}

async function leaveLive() {
  if (studentPc) { studentPc.close(); studentPc = null; }
  if (teacherCandidatesUnsub) { teacherCandidatesUnsub(); teacherCandidatesUnsub = null; }
  if (answerUnsub) { answerUnsub(); answerUnsub = null; }
  studentLocalStream?.getTracks().forEach((t) => t.stop());
  studentLocalStream = null; videoTransceiver = null; audioTransceiver = null;
  stopWhiteboard();
  if (course) {
    try { await deleteDoc(doc(db, COL.liveSessions, course.id, "viewers", user.uid)); } catch (e) { /* already gone */ }
  }
  const wrap = document.getElementById("live-wrap");
  if (wrap) wrap.innerHTML = `<p>You left the live class.</p>`;
}

/* ---------- Exams & Results ---------- */
async function renderExams() {
  currentView = "exams";
  if (!course) { main.innerHTML = "<p>You are not enrolled in a course yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-file-pen"></i> Exams — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div class="glass-card" id="exam-start-card">
      <p>Your exam will open in secure fullscreen mode. Ensure you have a stable connection before starting.</p>
      <button class="btn-gold" id="start-exam"><i class="fa-solid fa-lock"></i> Start Exam</button>
    </div>
    <div class="glass-card" style="margin-top:20px;"><h4>Your Results</h4><div id="results-list">Loading…</div></div>`;
  bindCourseSwitcher();
  document.getElementById("start-exam").onclick = () => {
    window.location.href = `exam.html?course=${course.id}`;
  };
  const snap = await getDocs(query(collection(db, COL.results), where("studentUid", "==", user.uid), where("courseId", "==", course.id)));
  if (!snap.empty) {
    document.getElementById("exam-start-card").innerHTML = `
      <p><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> You've already attempted this exam. Each exam can only be taken once — see your result below.</p>`;
  }
  let rows = "";
  snap.forEach(d => { const r = d.data(); rows += `<tr><td>${r.score}/${r.total}</td><td>${r.percent}%</td><td>${r.grade}</td><td>${r.date || ""}</td></tr>`; });
  document.getElementById("results-list").innerHTML = snap.empty ? "<p>No results yet.</p>" : `<table class="data-table"><thead><tr><th>Score</th><th>%</th><th>Grade</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- Certificates (across all enrolled courses, no switcher needed) ---------- */
async function renderCertificates() {
  currentView = "certificates";
  main.innerHTML = `<h2><i class="fa-solid fa-certificate"></i> Certificates</h2><div class="glass-card"><div id="cert-list">Checking eligibility…</div></div>`;
  const snap = await getDocs(query(collection(db, COL.results), where("studentUid", "==", user.uid)));
  const wrap = document.getElementById("cert-list");
  const passed = [];
  snap.forEach(d => { const r = d.data(); if (r.percent >= 50) passed.push(r); });
  if (!passed.length) { wrap.innerHTML = "<p>Complete and pass a course exam (50%+) to unlock your certificate.</p>"; return; }
  wrap.innerHTML = "";
  passed.forEach(r => {
    const btn = document.createElement("button");
    btn.className = "btn-gold"; btn.style.marginRight = "8px"; btn.style.marginBottom = "8px";
    btn.innerHTML = `<i class="fa-solid fa-download"></i> ${r.courseTitle || r.courseId} Certificate`;
    btn.onclick = () => generateCertificate(r);
    wrap.appendChild(btn);
  });
}

async function generateCertificate(result) {
  const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/+esm");
  const pdf = new jsPDF({ orientation: "landscape" });
  const verifyCode = `${profile.studentId}-${result.courseId}-${Date.now().toString(36)}`.toUpperCase();

  pdf.setFillColor(11, 37, 69); pdf.rect(0, 0, 297, 210, "F");
  pdf.setDrawColor(212, 175, 55); pdf.setLineWidth(2); pdf.rect(8, 8, 281, 194);
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("times", "bold"); pdf.setFontSize(22);
  pdf.text("CAC Good Works Assembly Believers Bible College", 148, 40, { align: "center" });
  pdf.setFontSize(16); pdf.text("Certificate of Completion", 148, 55, { align: "center" });
  pdf.setFontSize(13); pdf.text("This certifies that", 148, 80, { align: "center" });
  pdf.setFont("times", "bolditalic"); pdf.setFontSize(26); pdf.setTextColor(212, 175, 55);
  pdf.text(profile.fullName, 148, 100, { align: "center" });
  pdf.setFont("times", "normal"); pdf.setFontSize(13); pdf.setTextColor(255, 255, 255);
  pdf.text(`has successfully completed the course`, 148, 115, { align: "center" });
  pdf.setFont("times", "bold"); pdf.text(`${result.courseTitle || result.courseId}`, 148, 125, { align: "center" });
  pdf.setFont("times", "normal");
  pdf.text(`with a grade of ${result.grade} (${result.percent}%)`, 148, 135, { align: "center" });
  pdf.text(`Date: ${new Date().toLocaleDateString()}`, 40, 175);
  pdf.text(`Verification Code: ${verifyCode}`, 148, 190, { align: "center" });
  pdf.text("Registrar", 250, 175);
  pdf.save(`Certificate-${profile.studentId}.pdf`);
  await logActivity(user.uid, "student", "download_certificate", verifyCode);
  toast("Certificate downloaded", "success");
}

/* ---------- Ask a Question ---------- */
async function renderQuestions() {
  currentView = "questions";
  if (!course) { main.innerHTML = "<p>You are not enrolled in a course yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-comments"></i> Ask a Question — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div class="glass-card">
      <form id="q-form"><div class="form-field"><label>Your question</label><textarea id="q-text" rows="3" required></textarea></div>
      <button class="btn-gold" type="submit"><i class="fa-solid fa-paper-plane"></i> Submit</button></form>
    </div>
    <div class="glass-card" style="margin-top:20px;"><h4>Your Questions (this course)</h4><div id="my-q">Loading…</div></div>`;
  bindCourseSwitcher();
  document.getElementById("q-form").onsubmit = async (e) => {
    e.preventDefault();
    await addDoc(collection(db, COL.questions), {
      courseId: course.id, studentUid: user.uid, studentName: profile.fullName,
      question: document.getElementById("q-text").value, createdAt: serverTimestamp()
    });
    toast("Question submitted", "success"); e.target.reset(); loadMyQuestions();
  };
  loadMyQuestions();
}
async function loadMyQuestions() {
  const snap = await getDocs(query(collection(db, COL.questions), where("studentUid", "==", user.uid), where("courseId", "==", course.id)));
  let rows = "";
  snap.forEach(d => { const q = d.data(); rows += `<tr><td>${q.question}</td><td>${q.answer || "Awaiting answer"}</td></tr>`; });
  document.getElementById("my-q").innerHTML = snap.empty ? "<p>No questions yet.</p>" : `<table class="data-table"><thead><tr><th>Question</th><th>Answer</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- Feedback ---------- */
function renderFeedback() {
  currentView = "feedback";
  if (!course) { main.innerHTML = "<p>You are not enrolled in a course yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-star"></i> Feedback — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div class="glass-card">
      <form id="fb-form">
        <div class="form-field"><label>Rating (1-5)</label><input type="number" min="1" max="5" id="fb-rating" required></div>
        <div class="form-field"><label>Comments / Suggestions</label><textarea id="fb-comment" rows="3"></textarea></div>
        <button class="btn-gold" type="submit"><i class="fa-solid fa-paper-plane"></i> Submit Feedback</button>
      </form>
    </div>`;
  bindCourseSwitcher();
  document.getElementById("fb-form").onsubmit = async (e) => {
    e.preventDefault();
    await addDoc(collection(db, COL.feedback), {
      courseId: course.id, studentUid: user.uid,
      rating: Number(document.getElementById("fb-rating").value),
      comment: document.getElementById("fb-comment").value,
      createdAt: serverTimestamp()
    });
    toast("Thank you for your feedback!", "success"); e.target.reset();
  };
}
