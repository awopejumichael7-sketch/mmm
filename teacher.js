/* ==========================================================================
   TEACHER.JS — Teacher Dashboard
   ========================================================================== */
import { guardRoute, logout } from "./auth.js";
import {
  db, storage, COL, ICE_CONFIG, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp, onSnapshot, ref, uploadBytesResumable, getDownloadURL,
  logActivity
} from "./firebase-config.js";
import { toast, initTheme, toggleTheme, registerServiceWorker } from "./app-shell.js";
import { openDrivePicker, makeFilePublic, verifyPublicAccess, driveFileViewUrl, uploadFileToDrive, loadGoogleScripts } from "./drive-config.js";
import { renderWhiteboard, stopWhiteboard } from "./whiteboard.js";
import { isWebGPUSupported, isModelLoaded, loadModel, sendMessage, resetConversation, getHistory } from "./ai-assistant.js";

initTheme();
registerServiceWorker();
const main = document.getElementById("main-content");
document.getElementById("theme-btn").onclick = toggleTheme;
document.getElementById("logout-btn").onclick = logout;

let user, profile, myCourses = [], course, currentView = "overview";

guardRoute("teacher").then(async (u) => {
  user = u;
  const snap = await getDoc(doc(db, COL.teachers, u.uid));
  profile = snap.data();

  const courseIds = profile.courseIds || (profile.courseId ? [profile.courseId] : []); // backward-compatible
  myCourses = [];
  for (const id of courseIds) {
    const cSnap = await getDoc(doc(db, COL.courses, id));
    if (cSnap.exists()) myCourses.push({ id, ...cSnap.data() });
  }
  const savedId = localStorage.getItem("cacgw_teacher_selected_course");
  course = myCourses.find(c => c.id === savedId) || myCourses[0] || null;

  bindSidebar();
  renderOverview();
});

function bindSidebar() {
  document.querySelectorAll(".sidebar a").forEach(a => {
    a.addEventListener("click", () => {
      document.querySelectorAll(".sidebar a").forEach(x => x.classList.remove("active"));
      a.classList.add("active");
      if (currentView === "whiteboard" && a.dataset.view !== "whiteboard") stopWhiteboard();
      currentView = a.dataset.view;
      views()[currentView]();
    });
  });
}
function views() {
  return {
    overview: renderOverview, materials: renderMaterials, studio: renderStudio,
    live: renderLive, attendance: renderAttendance, examQuestions: renderExamQuestions,
    grading: renderGrading, progress: renderProgress, questions: renderQuestions, feedback: renderFeedback,
    whiteboard: renderWhiteboardView, ai: renderAI
  };
}

/* ---------- Whiteboard (free, shared live with students in this course) ---------- */
function renderWhiteboardView() {
  currentView = "whiteboard";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = courseSwitcherHTML() + `<div id="wb-host"></div>`;
  bindCourseSwitcher();
  renderWhiteboard(document.getElementById("wb-host"), course.id);
}

/* ---------- Free in-browser AI assistant (WebLLM — runs on-device, no API key, no cost) ---------- */
let aiBusy = false;
function renderAI() {
  currentView = "ai";
  const supported = isWebGPUSupported();
  const loaded = isModelLoaded();
  main.innerHTML = `
    <h2><i class="fa-solid fa-robot"></i> AI Assistant</h2>
    <p style="color:var(--muted);">Runs entirely in your browser — free, private, nothing leaves this device. First use downloads a small AI model (roughly 1&nbsp;GB), cached afterward so it only happens once.</p>
    ${!supported
      ? `<div class="glass-card"><p><i class="fa-solid fa-triangle-exclamation"></i> This browser doesn't support WebGPU, which the free in-browser AI needs. Try the latest Chrome or Edge on a desktop or laptop.</p></div>`
      : !loaded
        ? `<div class="glass-card">
             <button class="btn-gold" id="ai-load-btn" type="button"><i class="fa-solid fa-download"></i> Load AI Model (one-time download)</button>
             <div id="ai-progress" style="color:var(--muted);margin-top:12px;font-size:.85rem;"></div>
           </div>`
        : `<div class="glass-card">
             <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
               <button class="btn-outline" id="ai-reset-btn" type="button"><i class="fa-solid fa-rotate-left"></i> New Conversation</button>
             </div>
             <div id="ai-chat-log" class="ai-chat-log"></div>
             <div style="display:flex;gap:8px;margin-top:12px;">
               <input id="ai-input" type="text" placeholder="Ask for lesson ideas, quiz questions, explanations…" style="flex:1;padding:11px 14px;border-radius:10px;border:1.5px solid #d8dde8;">
               <button class="btn-navy" id="ai-send-btn" type="button"><i class="fa-solid fa-paper-plane"></i></button>
             </div>
           </div>`}`;

  if (!supported) return;

  if (!loaded) {
    document.getElementById("ai-load-btn").onclick = async () => {
      const btn = document.getElementById("ai-load-btn");
      const progress = document.getElementById("ai-progress");
      btn.disabled = true;
      try {
        await loadModel((report) => { progress.textContent = report.text || ""; });
        renderAI();
      } catch (e) {
        toast("Couldn't load the AI model. Your device or browser may not support it.", "error");
        btn.disabled = false;
      }
    };
    return;
  }

  renderAiLog();
  document.getElementById("ai-reset-btn").onclick = () => { resetConversation(); renderAI(); };
  const input = document.getElementById("ai-input");
  const send = async () => {
    const text = input.value.trim();
    if (!text || aiBusy) return;
    aiBusy = true;
    input.value = "";
    renderAiLog(text, "");
    try {
      await sendMessage(text, (partial) => renderAiLog(null, partial));
    } catch (e) {
      toast("AI assistant hit an error — try again.", "error");
    }
    aiBusy = false;
    renderAiLog();
  };
  document.getElementById("ai-send-btn").onclick = send;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}
function renderAiLog(pendingUser, pendingAssistant) {
  const log = document.getElementById("ai-chat-log");
  if (!log) return;
  const msgs = getHistory();
  let html = msgs.map(m => `<div class="ai-msg ai-msg-${m.role}"><strong>${m.role === "user" ? "You" : "AI"}:</strong> ${escapeAiHtml(m.content)}</div>`).join("");
  if (pendingUser) html += `<div class="ai-msg ai-msg-user"><strong>You:</strong> ${escapeAiHtml(pendingUser)}</div>`;
  if (pendingAssistant !== undefined && pendingAssistant !== null) html += `<div class="ai-msg ai-msg-assistant"><strong>AI:</strong> ${escapeAiHtml(pendingAssistant)}</div>`;
  log.innerHTML = html;
  log.scrollTop = log.scrollHeight;
}
function escapeAiHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Course switcher — shown at the top of every course-specific view ---------- */
function courseSwitcherHTML() {
  if (myCourses.length <= 1) return "";
  const opts = myCourses.map(c => `<option value="${c.id}" ${course && c.id === course.id ? "selected" : ""}>${c.code} — ${c.title}</option>`).join("");
  return `<div class="glass-card" style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <label style="font-weight:600;color:var(--muted);"><i class="fa-solid fa-chalkboard-user"></i> Viewing course:</label>
      <select id="teacher-course-switcher" style="padding:8px 12px;border-radius:10px;border:1px solid #d8dde8;">${opts}</select>
    </div>`;
}
function bindCourseSwitcher() {
  const sel = document.getElementById("teacher-course-switcher");
  if (!sel) return;
  sel.onchange = () => {
    course = myCourses.find(c => c.id === sel.value);
    localStorage.setItem("cacgw_teacher_selected_course", course.id);
    views()[currentView]();
  };
}

function renderOverview() {
  currentView = "overview";
  const courseList = myCourses.length
    ? myCourses.map(c => `<span class="badge active" style="margin-right:6px;">${c.code}</span>`).join("")
    : "None yet — contact your Administrator";
  main.innerHTML = `
    <h2>Welcome, ${profile.fullName}</h2>
    <p style="color:var(--muted);">Assigned to ${myCourses.length} course(s): ${courseList}</p>
    <div class="stat-grid">
      <div class="stat-card"><div class="num"><i class="fa-solid fa-id-badge"></i></div><div class="label">${profile.teacherId}</div></div>
      <div class="stat-card"><div class="num">${myCourses.length}</div><div class="label">Assigned Courses</div></div>
      <div class="stat-card"><div class="num">${course ? course.code : "—"}</div><div class="label">Currently Viewing</div></div>
    </div>
    <div class="glass-card">
      <h4>Quick Actions</h4>
      <button class="btn-navy" onclick="document.querySelector('[data-view=materials]').click()"><i class="fa-solid fa-cloud-arrow-up"></i> Upload Material</button>
      <button class="btn-gold" onclick="document.querySelector('[data-view=studio]').click()"><i class="fa-solid fa-video"></i> Open Studio</button>
    </div>`;
}

/* ---------- Upload materials (ebook, handbook, syllabus, assignment) ---------- */
function renderMaterials() {
  currentView = "materials";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  loadGoogleScripts().catch(() => {}); // warm up Drive sign-in in the background so it's instant when clicked
  main.innerHTML = `
    <h2><i class="fa-solid fa-cloud-arrow-up"></i> Upload Materials — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div class="glass-card">
      <form id="mat-form" class="row g-2">
        <div class="col-md-4 form-field"><label>Type</label>
          <select id="m-type">
            <option value="ebooks">Ebook</option>
            <option value="handbooks">Handbook</option>
            <option value="syllabus">Syllabus</option>
            <option value="notes">Lesson Notes</option>
            <option value="assignments">Assignment</option>
            <option value="audio">Audio Teaching</option>
            <option value="videos">Video</option>
          </select>
        </div>
        <div class="col-md-4 form-field"><label>Title</label><input required id="m-title" type="text"></div>

        <div class="col-12 form-field">
          <label>Save To</label><br>
          <label style="margin-right:16px;"><input type="radio" name="m-dest" value="storage" checked> Firebase Storage (upload from this device)</label>
          <label><input type="radio" name="m-dest" value="drive"> Google Drive (pick an existing file)</label>
        </div>
        <div class="col-md-8 form-field" id="m-storage-field"><label>File</label><input id="m-file" type="file"></div>
        <div class="col-md-8 form-field" id="m-drive-field" style="display:none;">
          <button type="button" class="btn-outline" id="m-drive-pick"><i class="fa-brands fa-google-drive"></i> Choose from Google Drive</button>
          <span id="m-drive-chosen" style="margin-left:10px;color:var(--muted);"></span>
        </div>

        <div class="col-12"><button class="btn-gold" type="submit"><i class="fa-solid fa-upload"></i> Save</button></div>
      </form>
      <div id="m-progress" style="margin-top:10px;"></div>
    </div>
    <div class="glass-card" style="margin-top:20px;">
      <h4>Existing Materials</h4>
      <div class="form-field" style="max-width:280px;"><label>Filter by Type</label>
        <select id="ml-type">
          <option value="ebooks">Ebooks</option>
          <option value="handbooks">Handbooks</option>
          <option value="syllabus">Syllabus</option>
          <option value="notes">Lesson Notes</option>
          <option value="assignments">Assignments</option>
          <option value="audio">Audio Teachings</option>
          <option value="videos">Videos</option>
        </select>
      </div>
      <div id="materials-list">Loading…</div>
    </div>`;

  bindCourseSwitcher();
  let pickedDriveFile = null;
  document.querySelectorAll('input[name="m-dest"]').forEach(r => r.onchange = () => {
    const isDrive = document.querySelector('input[name="m-dest"]:checked').value === "drive";
    document.getElementById("m-storage-field").style.display = isDrive ? "none" : "block";
    document.getElementById("m-drive-field").style.display = isDrive ? "block" : "none";
  });
  document.getElementById("m-drive-pick").onclick = async () => {
    try {
      const file = await openDrivePicker();
      if (file) { pickedDriveFile = file; document.getElementById("m-drive-chosen").textContent = `Selected: ${file.name}`; }
    } catch (err) { toast("Could not connect to Google Drive: " + err.message, "error"); }
  };

  document.getElementById("mat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const type = document.getElementById("m-type").value;
    const title = document.getElementById("m-title").value;
    const col = COL[type] || "materials";
    const targetCol = (type === "notes" || type === "assignments") ? "materials" : col;
    const dest = document.querySelector('input[name="m-dest"]:checked').value;
    const prog = document.getElementById("m-progress");

    if (dest === "storage") {
      const file = document.getElementById("m-file").files[0];
      if (!file) { toast("Choose a file first.", "error"); return; }
      const path = `${type}/${course.id}/${Date.now()}_${file.name}`;
      const sref = ref(storage, path);
      const task = uploadBytesResumable(sref, file);
      task.on("state_changed", (s) => {
        const pct = Math.round((s.bytesTransferred / s.totalBytes) * 100);
        prog.innerHTML = `<div class="skeleton" style="height:10px;width:${pct}%;"></div><small>${pct}%</small>`;
      }, (err) => toast(err.message, "error"), async () => {
        const url = await getDownloadURL(sref);
        await addDoc(collection(db, targetCol), {
          courseId: course.id, title, url, type, source: "storage", uploadedBy: user.uid, uploadedAt: serverTimestamp()
        });
        await logActivity(user.uid, "teacher", "upload_" + type, title);
        toast("Uploaded to Firebase Storage", "success");
        prog.innerHTML = ""; e.target.reset(); pickedDriveFile = null;
        document.getElementById("ml-type").value = type;
        loadMaterialsList();
      });
    } else {
      if (!pickedDriveFile) { toast("Choose a file from Google Drive first.", "error"); return; }
      prog.innerHTML = "Step 1 of 3: Making the file link-shareable…";
      try {
        await makeFilePublic(pickedDriveFile.id);
        prog.innerHTML = "Step 2 of 3: Confirming it's publicly reachable…";
        await verifyPublicAccess(pickedDriveFile.id);
        prog.innerHTML = "Step 3 of 3: Saving to the course…";
        await addDoc(collection(db, targetCol), {
          courseId: course.id, title, url: driveFileViewUrl(pickedDriveFile.id), driveFileId: pickedDriveFile.id,
          type, source: "drive", uploadedBy: user.uid, uploadedAt: serverTimestamp()
        });
        await logActivity(user.uid, "teacher", "link_drive_" + type, title);
        toast("Linked from Google Drive", "success");
        prog.innerHTML = ""; e.target.reset(); pickedDriveFile = null;
        document.getElementById("m-drive-chosen").textContent = "";
        document.getElementById("ml-type").value = type;
        loadMaterialsList();
      } catch (err) {
        toast(err.message, "error");
        prog.innerHTML = `<p style="color:var(--danger);border:1px solid var(--danger);border-radius:10px;padding:10px 14px;">
          <i class="fa-solid fa-triangle-exclamation"></i> ${err.message}</p>`;
      }
    }
  });

  document.getElementById("ml-type").onchange = loadMaterialsList;
  document.getElementById("ml-type").value = document.getElementById("m-type").value;
  loadMaterialsList();
}

async function loadMaterialsList() {
  const wrap = document.getElementById("materials-list");
  if (!wrap || !course) return;
  wrap.innerHTML = "Loading…";
  const type = document.getElementById("ml-type").value;
  const isShared = type === "notes" || type === "assignments";
  const targetCol = isShared ? "materials" : (COL[type] || "materials");
  let snap;
  try {
    snap = isShared
      ? await getDocs(query(collection(db, targetCol), where("courseId", "==", course.id), where("type", "==", type)))
      : await getDocs(query(collection(db, targetCol), where("courseId", "==", course.id)));
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--danger);">Could not load this list: ${err.message}</p>
      <button class="btn-outline" id="ml-retry">Retry</button>`;
    document.getElementById("ml-retry").onclick = loadMaterialsList;
    return;
  }
  if (snap.empty) { wrap.innerHTML = "<p>Nothing uploaded here yet for this type.</p>"; return; }
  let rows = "";
  snap.forEach(d => {
    const item = d.data();
    const badge = item.source === "drive"
      ? '<span class="badge active"><i class="fa-brands fa-google-drive"></i> Drive</span>'
      : '<span class="badge active">Firebase Storage</span>';
    rows += `<tr><td>${item.title}</td><td>${badge}</td>
      <td><a class="btn-outline" href="${item.url}" target="_blank" rel="noopener"><i class="fa-solid fa-eye"></i> Open</a>
      <button class="btn-danger" data-id="${d.id}" data-col="${targetCol}">Delete</button></td></tr>`;
  });
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>Title</th><th>Source</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll("button[data-id]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this item? This removes it from the course — it does not delete the underlying file from Firebase Storage or Google Drive itself.")) return;
    try {
      await deleteDoc(doc(db, b.dataset.col, b.dataset.id));
      await logActivity(user.uid, "teacher", "delete_material", b.dataset.id);
      toast("Deleted", "success");
      loadMaterialsList();
    } catch (err) {
      toast("Could not delete: " + err.message, "error");
    }
  });
}

/* ---------- Recording Studio: audio + video via MediaRecorder ---------- */
let mediaStream, mediaRecorder, chunks = [], recKind = "video";

function renderStudio() {
  currentView = "studio";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  loadGoogleScripts().catch(() => {}); // warm up Drive sign-in in the background so it's instant when clicked
  main.innerHTML = `
    <h2><i class="fa-solid fa-video"></i> Recording Studio — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div class="glass-card studio-wrap">
      <div style="flex:1;min-width:280px;">
        <div class="studio-preview"><video id="preview" autoplay muted playsinline></video></div>
        <div class="studio-controls">
          <button class="btn-navy" id="cam-on"><i class="fa-solid fa-camera"></i> Camera On</button>
          <button class="btn-outline" id="cam-off"><i class="fa-solid fa-camera-slash"></i> Camera Off</button>
          <button class="btn-navy" id="mic-on"><i class="fa-solid fa-microphone"></i> Mic On</button>
          <button class="btn-outline" id="mic-off"><i class="fa-solid fa-microphone-slash"></i> Mic Off</button>
        </div>
        <div class="studio-controls">
          <select id="rec-kind" class="form-select" style="width:auto;">
            <option value="video">Record Video Lesson</option>
            <option value="audio">Record Audio Teaching</option>
          </select>
          <select id="rec-dest" class="form-select" style="width:auto;">
            <option value="storage">Save to: Firebase Storage</option>
            <option value="drive">Save to: Google Drive</option>
          </select>
          <button class="btn-gold" id="rec-start"><i class="fa-solid fa-circle"></i> Start Recording</button>
          <button class="btn-outline" id="rec-pause" disabled>Pause</button>
          <button class="btn-outline" id="rec-resume" disabled>Resume</button>
          <button class="btn-danger" id="rec-stop" disabled>Stop & Save</button>
        </div>
        <p id="rec-status" style="margin-top:8px;color:var(--muted);"></p>
      </div>
    </div>
    <p style="color:var(--muted);font-size:.85rem;margin-top:10px;"><i class="fa-solid fa-circle-info"></i>
      Recordings save automatically when you click Stop — to Firebase Storage or your Google Drive, whichever you pick above. Students can only stream — downloading is disabled on their end.</p>`;

  bindCourseSwitcher();
  document.getElementById("cam-on").onclick = async () => {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("preview").srcObject = mediaStream;
  };
  document.getElementById("cam-off").onclick = () => {
    mediaStream?.getVideoTracks().forEach(t => t.stop());
  };
  document.getElementById("mic-on").onclick = async () => {
    if (!mediaStream) mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    else {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      audio.getAudioTracks().forEach(t => mediaStream.addTrack(t));
    }
    toast("Microphone enabled", "success");
  };
  document.getElementById("mic-off").onclick = () => {
    mediaStream?.getAudioTracks().forEach(t => t.stop());
  };
  document.getElementById("rec-kind").onchange = (e) => recKind = e.target.value;

  document.getElementById("rec-start").onclick = async () => {
    if (!mediaStream) {
      mediaStream = recKind === "audio"
        ? await navigator.mediaDevices.getUserMedia({ audio: true })
        : await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      document.getElementById("preview").srcObject = mediaStream;
    }
    chunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = saveRecording;
    mediaRecorder.start();
    document.getElementById("rec-status").innerHTML = `<span class="rec-dot"></span> Recording ${recKind}…`;
    toggleRecBtns(true);
  };
  document.getElementById("rec-pause").onclick = () => { mediaRecorder.pause(); document.getElementById("rec-status").textContent = "Paused"; };
  document.getElementById("rec-resume").onclick = () => { mediaRecorder.resume(); document.getElementById("rec-status").innerHTML = `<span class="rec-dot"></span> Recording…`; };
  document.getElementById("rec-stop").onclick = () => { mediaRecorder.stop(); toggleRecBtns(false); };
}

function toggleRecBtns(recording) {
  document.getElementById("rec-start").disabled = recording;
  document.getElementById("rec-pause").disabled = !recording;
  document.getElementById("rec-resume").disabled = !recording;
  document.getElementById("rec-stop").disabled = !recording;
}

/* ---------- Shared helper: save a recorded blob to Storage or Drive, then
   list it for students. Used by both the Recording Studio and Live Class
   recording below, so there's a single, consistent save path. ---------- */
async function saveMediaBlob(blob, kind, dest, titlePrefix, statusEl, logTag) {
  const filename = `${Date.now()}_${kind === "audio" ? "audio" : "video"}.webm`;
  const title = `${titlePrefix} — ${new Date().toLocaleString()}`;

  if (dest === "storage") {
    const path = `${kind === "audio" ? "audio" : "videos"}/${course.id}/${filename}`;
    const sref = ref(storage, path);
    if (statusEl) statusEl.textContent = "Uploading to Firebase Storage…";
    const task = uploadBytesResumable(sref, blob);
    task.on("state_changed", (s) => {
      const pct = Math.round((s.bytesTransferred / s.totalBytes) * 100);
      if (statusEl) statusEl.textContent = `Uploading ${pct}%…`;
    }, (err) => toast(err.message, "error"), async () => {
      const url = await getDownloadURL(sref);
      await addDoc(collection(db, kind === "audio" ? COL.audio : COL.videos), {
        courseId: course.id, title, url, source: "storage", uploadedBy: user.uid, uploadedAt: serverTimestamp(), streamOnly: true
      });
      await logActivity(user.uid, "teacher", logTag + "_" + kind, course.id);
      if (statusEl) statusEl.textContent = "Saved and available to students!";
      toast("Recording saved to Firebase Storage", "success");
    });
  } else {
    if (statusEl) statusEl.textContent = "Uploading to Google Drive…";
    try {
      const fileId = await uploadFileToDrive(blob, filename, kind === "audio" ? "audio/webm" : "video/webm");
      await addDoc(collection(db, kind === "audio" ? COL.audio : COL.videos), {
        courseId: course.id, title, url: driveFileViewUrl(fileId), driveFileId: fileId,
        source: "drive", uploadedBy: user.uid, uploadedAt: serverTimestamp(), streamOnly: true
      });
      await logActivity(user.uid, "teacher", logTag + "_drive_" + kind, course.id);
      if (statusEl) statusEl.textContent = "Saved to Google Drive and available to students!";
      toast("Recording saved to Google Drive", "success");
    } catch (err) {
      if (statusEl) statusEl.textContent = "Could not save to Google Drive.";
      toast(err.message, "error");
    }
  }
}

async function saveRecording() {
  const blob = new Blob(chunks, { type: recKind === "audio" ? "audio/webm" : "video/webm" });
  const dest = document.getElementById("rec-dest")?.value || "storage";
  const statusEl = document.getElementById("rec-status");
  await saveMediaBlob(blob, recKind, dest, "Lesson", statusEl, "record");
}

/* ---------- Live Class: real-time WebRTC broadcast, nothing is recorded.
   Students may also turn on their own camera/mic — each student tile below
   shows their live feed the moment they enable it. ---------- */
let liveStream = null;
const livePeers = {};          // viewerUid -> RTCPeerConnection
const liveViewerInfo = {};     // viewerUid -> { studentName, studentId }
const liveRemoteStreams = {};  // viewerUid -> MediaStream (that student's camera/mic)
let unsubViewers = null;
let liveRecorder = null, liveRecChunks = [], liveRecKind = "video", liveRecDest = "storage", isLiveRecording = false;

function renderLive() {
  currentView = "live";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  const isLive = !!liveStream;
  main.innerHTML = `
    <h2><i class="fa-solid fa-tower-broadcast"></i> Live Class — ${course.title}</h2>
    ${isLive ? `<p style="color:var(--muted);font-size:.85rem;"><i class="fa-solid fa-lock"></i> Course switching is disabled while you're live — end this class first to switch courses.</p>` : courseSwitcherHTML()}
    <div class="glass-card studio-wrap">
      <div style="flex:1;min-width:280px;">
        <div class="studio-preview"><video id="live-preview" autoplay muted playsinline></video></div>
        <div class="studio-controls">
          <button class="btn-gold" id="go-live" ${isLive ? "disabled" : ""}><i class="fa-solid fa-tower-broadcast"></i> Go Live</button>
          <button class="btn-outline" id="live-cam-toggle" ${isLive ? "" : "disabled"}><i class="fa-solid fa-camera"></i> Toggle Camera</button>
          <button class="btn-outline" id="live-mic-toggle" ${isLive ? "" : "disabled"}><i class="fa-solid fa-microphone"></i> Toggle Mic</button>
          <button class="btn-danger" id="end-live" ${isLive ? "" : "disabled"}>End Live Class</button>
        </div>
        <p id="live-status" style="margin-top:8px;color:var(--muted);">${isLive ? `<span class="rec-dot"></span> LIVE — ${Object.keys(livePeers).length} student(s) connected` : ""}</p>

        <div class="studio-controls" style="margin-top:14px;border-top:1px solid #e5e9f2;padding-top:14px;">
          <select id="live-rec-kind" class="form-select" style="width:auto;" ${isLiveRecording ? "disabled" : ""}>
            <option value="video" ${(!isLiveRecording || liveRecKind === "video") ? "selected" : ""}>Record As: Video</option>
            <option value="audio" ${(isLiveRecording && liveRecKind === "audio") ? "selected" : ""}>Record As: Audio Only</option>
          </select>
          <select id="live-rec-dest" class="form-select" style="width:auto;" ${isLiveRecording ? "disabled" : ""}>
            <option value="storage" ${(!isLiveRecording || liveRecDest === "storage") ? "selected" : ""}>Save to: Firebase Storage</option>
            <option value="drive" ${(isLiveRecording && liveRecDest === "drive") ? "selected" : ""}>Save to: Google Drive</option>
          </select>
          <button class="btn-gold" id="live-rec-start" ${isLive && !isLiveRecording ? "" : "disabled"}><i class="fa-solid fa-circle"></i> Start Recording</button>
          <button class="btn-danger" id="live-rec-stop" ${isLiveRecording ? "" : "disabled"}>Stop & Save Recording</button>
        </div>
        <p id="live-rec-status" style="margin-top:8px;color:var(--muted);">${isLiveRecording ? `<span class="rec-dot"></span> Recording this session (${liveRecKind})…` : ""}</p>
      </div>
    </div>
    <h4 style="margin-top:20px;"><i class="fa-solid fa-users"></i> Students</h4>
    <div class="course-grid" id="student-tiles"></div>
    <p style="color:var(--muted);font-size:.85rem;margin-top:10px;">
      <i class="fa-solid fa-circle-info"></i> The live broadcast itself is never recorded automatically. If you'd like students to be able to watch or listen again afterward, use "Start Recording" above — it saves separately to Firebase Storage or Google Drive (your choice) and shows up for students under Audio & Video once you stop it.
    </p>`;

  if (isLive) {
    document.getElementById("live-preview").srcObject = liveStream;
    renderStudentTiles();
  } else {
    bindCourseSwitcher();
  }

  document.getElementById("go-live").onclick = startLive;
  document.getElementById("end-live").onclick = endLive;
  document.getElementById("live-cam-toggle").onclick = () => liveStream?.getVideoTracks().forEach(t => t.enabled = !t.enabled);
  document.getElementById("live-mic-toggle").onclick = () => liveStream?.getAudioTracks().forEach(t => t.enabled = !t.enabled);
  document.getElementById("live-rec-start").onclick = startLiveRecording;
  document.getElementById("live-rec-stop").onclick = stopLiveRecording;
}

/* ---------- Record the live session (separate from the broadcast itself) and
   save it for students to watch/listen to afterward. Records from the exact
   same camera/mic stream already being broadcast — nothing extra is captured. ---------- */
function startLiveRecording() {
  if (!liveStream || isLiveRecording) return;
  liveRecKind = document.getElementById("live-rec-kind").value;
  liveRecDest = document.getElementById("live-rec-dest").value;
  liveRecChunks = [];

  // For audio-only recording, record just the audio tracks; for video, record everything.
  const recordSource = liveRecKind === "audio"
    ? new MediaStream(liveStream.getAudioTracks())
    : liveStream;

  liveRecorder = new MediaRecorder(recordSource);
  liveRecorder.ondataavailable = (e) => e.data.size && liveRecChunks.push(e.data);
  liveRecorder.onstop = async () => {
    isLiveRecording = false;
    const blob = new Blob(liveRecChunks, { type: liveRecKind === "audio" ? "audio/webm" : "video/webm" });
    const statusEl = document.getElementById("live-rec-status");
    await saveMediaBlob(blob, liveRecKind, liveRecDest, "Live Class Recording", statusEl, "live_record");
    renderLive();
  };
  liveRecorder.start();
  isLiveRecording = true;
  toast(`Recording this live class (${liveRecKind}) — students will be able to watch it afterward once you stop.`, "success");
  renderLive();
}

function stopLiveRecording() {
  if (liveRecorder && isLiveRecording) liveRecorder.stop();
}

function renderStudentTiles() {
  const wrap = document.getElementById("student-tiles");
  if (!wrap) return;
  const ids = Object.keys(livePeers);
  if (!ids.length) { wrap.innerHTML = `<p style="color:var(--muted);">No students connected yet.</p>`; return; }
  wrap.innerHTML = ids.map(id => {
    const info = liveViewerInfo[id] || {};
    return `<div class="course-tile" style="background:#101a2c;padding:0;overflow:hidden;">
      <video id="tile-${id}" autoplay playsinline style="width:100%;height:100%;object-fit:cover;background:#000;"></video>
      <div style="position:absolute;bottom:8px;left:10px;font-size:.8rem;background:rgba(0,0,0,.5);padding:2px 8px;border-radius:6px;">
        ${info.studentName || "Student"} ${info.studentId ? "(" + info.studentId + ")" : ""}
      </div>
    </div>`;
  }).join("");
  ids.forEach(id => {
    const vid = document.getElementById(`tile-${id}`);
    if (vid && liveRemoteStreams[id]) vid.srcObject = liveRemoteStreams[id];
  });
}

async function startLive() {
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) { toast("Camera/microphone access is required to go live.", "error"); return; }

  await setDoc(doc(db, COL.liveSessions, course.id), {
    active: true, teacherUid: user.uid, courseTitle: course.title, startedAt: serverTimestamp()
  });

  const viewersCol = collection(db, COL.liveSessions, course.id, "viewers");
  unsubViewers = onSnapshot(viewersCol, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") handleNewViewer(change.doc.id, change.doc.data());
      if (change.type === "removed" && livePeers[change.doc.id]) {
        livePeers[change.doc.id].close();
        delete livePeers[change.doc.id];
        delete liveViewerInfo[change.doc.id];
        delete liveRemoteStreams[change.doc.id];
        updateLiveStatus();
        renderStudentTiles();
      }
    });
  });

  await logActivity(user.uid, "teacher", "start_live", course.id);
  toast("You're live!", "success");
  renderLive();
}

async function handleNewViewer(viewerId, data) {
  if (livePeers[viewerId] || !data.offer) return;
  const pc = new RTCPeerConnection(ICE_CONFIG);
  livePeers[viewerId] = pc;
  liveViewerInfo[viewerId] = { studentName: data.studentName, studentId: data.studentId };
  liveRemoteStreams[viewerId] = new MediaStream();

  liveStream.getTracks().forEach((track) => pc.addTrack(track, liveStream));

  // Receive that student's camera/mic if/when they turn it on
  pc.ontrack = (e) => {
    liveRemoteStreams[viewerId].addTrack(e.track);
    const vid = document.getElementById(`tile-${viewerId}`);
    if (vid) vid.srcObject = liveRemoteStreams[viewerId];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(collection(db, COL.liveSessions, course.id, "viewers", viewerId, "teacherCandidates"), e.candidate.toJSON());
  };
  pc.onconnectionstatechange = () => { if (["disconnected", "failed", "closed"].includes(pc.connectionState)) updateLiveStatus(); };

  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await updateDoc(doc(db, COL.liveSessions, course.id, "viewers", viewerId), { answer: { type: answer.type, sdp: answer.sdp } });

  onSnapshot(collection(db, COL.liveSessions, course.id, "viewers", viewerId, "studentCandidates"), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
    });
  });

  updateLiveStatus();
  renderStudentTiles();
}

function updateLiveStatus() {
  const el = document.getElementById("live-status");
  if (el) el.innerHTML = `<span class="rec-dot"></span> LIVE — ${Object.keys(livePeers).length} student(s) connected`;
}

async function endLive() {
  if (isLiveRecording && liveRecorder) {
    await new Promise((resolve) => {
      liveRecorder.addEventListener("stop", resolve, { once: true });
      liveRecorder.stop();
    });
  }

  Object.values(livePeers).forEach((pc) => pc.close());
  Object.keys(livePeers).forEach((k) => delete livePeers[k]);
  Object.keys(liveViewerInfo).forEach((k) => delete liveViewerInfo[k]);
  Object.keys(liveRemoteStreams).forEach((k) => delete liveRemoteStreams[k]);
  if (unsubViewers) { unsubViewers(); unsubViewers = null; }
  liveStream?.getTracks().forEach((t) => t.stop());
  liveStream = null;

  await updateDoc(doc(db, COL.liveSessions, course.id), { active: false, endedAt: serverTimestamp() });
  const viewersSnap = await getDocs(collection(db, COL.liveSessions, course.id, "viewers"));
  for (const v of viewersSnap.docs) await deleteDoc(v.ref); // best-effort cleanup of signaling docs

  await logActivity(user.uid, "teacher", "end_live", course.id);
  toast("Live class ended.", "success");
  renderLive();
}

/* ---------- Attendance ---------- */
async function renderAttendance() {
  currentView = "attendance";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-clipboard-check"></i> Attendance — ${course.title}</h2>${courseSwitcherHTML()}<div class="glass-card"><div id="att-list">Loading…</div></div>`;
  bindCourseSwitcher();
  const snap = await getDocs(query(collection(db, COL.attendance), where("courseId", "==", course.id)));
  let rows = "";
  snap.forEach(d => { const a = d.data(); rows += `<tr><td>${a.studentId}</td><td>${a.date}</td><td>${a.time}</td><td>${a.duration || "—"}</td></tr>`; });
  document.getElementById("att-list").innerHTML = snap.empty ? "<p>No attendance records yet.</p>" : `<table class="data-table"><thead><tr><th>Student</th><th>Date</th><th>Time</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- Student Questions ---------- */
async function renderQuestions() {
  currentView = "questions";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-comments"></i> Student Questions — ${course.title}</h2>${courseSwitcherHTML()}<div id="q-list">Loading…</div>`;
  bindCourseSwitcher();
  const snap = await getDocs(query(collection(db, COL.questions), where("courseId", "==", course.id)));
  const wrap = document.getElementById("q-list");
  if (snap.empty) { wrap.innerHTML = "<p>No questions yet.</p>"; return; }
  wrap.innerHTML = "";
  snap.forEach(d => {
    const q = d.data();
    const card = document.createElement("div");
    card.className = "glass-card";
    card.style.marginBottom = "12px";
    card.innerHTML = `<strong>${q.studentName || "Student"}:</strong> ${q.question}
      <div style="margin-top:8px;color:var(--muted);">${q.answer ? "<strong>Answer:</strong> " + q.answer : ""}</div>
      ${!q.answer ? `<div class="form-field" style="margin-top:10px;"><textarea rows="2" class="ans-box"></textarea><button class="btn-gold ans-btn" style="margin-top:6px;">Answer</button></div>` : ""}`;
    if (!q.answer) {
      card.querySelector(".ans-btn").onclick = async () => {
        const ans = card.querySelector(".ans-box").value;
        await updateDoc(doc(db, COL.questions, d.id), { answer: ans, answeredAt: serverTimestamp() });
        toast("Answer posted", "success");
        renderQuestions();
      };
    }
    wrap.appendChild(card);
  });
}

/* ---------- Feedback ---------- */
async function renderFeedback() {
  currentView = "feedback";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-star"></i> Feedback — ${course.title}</h2>${courseSwitcherHTML()}<div class="glass-card"><div id="fb-list">Loading…</div></div>`;
  bindCourseSwitcher();
  const snap = await getDocs(query(collection(db, COL.feedback), where("courseId", "==", course.id)));
  let rows = "";
  snap.forEach(d => { const f = d.data(); rows += `<tr><td>${f.rating || "—"}★</td><td>${f.comment || ""}</td></tr>`; });
  document.getElementById("fb-list").innerHTML = snap.empty ? "<p>No feedback yet.</p>" : `<table class="data-table"><thead><tr><th>Rating</th><th>Comment</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ============================== EXAM QUESTIONS (teacher, own course only) ============================== */
async function renderExamQuestions() {
  currentView = "examQuestions";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = `
    <h2><i class="fa-solid fa-file-pen"></i> Exam Questions — ${course.title}</h2>
    ${courseSwitcherHTML()}
    <div class="glass-card">
      <form id="teq-form">
        <div class="row g-2">
          <div class="col-md-6 form-field"><label>Question Type</label>
            <select id="teq-type"><option value="objective">Objective</option><option value="theory">Theory</option></select></div>
          <div class="col-md-6 form-field"><label>Language</label>
            <select id="teq-lang"><option value="english">English</option><option value="yoruba">Yoruba</option></select></div>
        </div>
        <div class="form-field"><label>Question</label><textarea id="teq-question" required rows="2"></textarea></div>
        <div class="row g-2">
          <div class="col-md-3 form-field"><label>Option A</label><input id="teq-a" type="text"></div>
          <div class="col-md-3 form-field"><label>Option B</label><input id="teq-b" type="text"></div>
          <div class="col-md-3 form-field"><label>Option C</label><input id="teq-c" type="text"></div>
          <div class="col-md-3 form-field"><label>Option D</label><input id="teq-d" type="text"></div>
        </div>
        <div class="row g-2">
          <div class="col-md-6 form-field"><label>Correct Answer (A/B/C/D, ignored for theory)</label><input id="teq-correct" type="text" maxlength="1"></div>
          <div class="col-md-6 form-field"><label>Marks (theory questions only)</label><input id="teq-marks" type="number" min="1" value="10"></div>
        </div>
        <button class="btn-gold" type="submit"><i class="fa-solid fa-plus"></i> Add Question</button>
      </form>
    </div>
    <div class="glass-card" style="margin-top:20px;"><div id="teq-list">Loading…</div></div>`;
  bindCourseSwitcher();

  document.getElementById("teq-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = {
      courseId: course.id,
      type: document.getElementById("teq-type").value,
      language: document.getElementById("teq-lang").value,
      question: document.getElementById("teq-question").value,
      options: {
        A: document.getElementById("teq-a").value, B: document.getElementById("teq-b").value,
        C: document.getElementById("teq-c").value, D: document.getElementById("teq-d").value
      },
      correct: document.getElementById("teq-correct").value.toUpperCase(),
      marks: Number(document.getElementById("teq-marks").value) || 10,
      createdBy: user.uid, createdAt: serverTimestamp()
    };
    await addDoc(collection(db, COL.examQuestions), q);
    await logActivity(user.uid, "teacher", "add_exam_question", course.id);
    toast("Question added", "success");
    e.target.reset();
    loadTeacherExamList();
  });
  loadTeacherExamList();
}

async function loadTeacherExamList() {
  const wrap = document.getElementById("teq-list");
  const snap = await getDocs(query(collection(db, COL.examQuestions), where("courseId", "==", course.id)));
  if (snap.empty) { wrap.innerHTML = "<p>No exam questions yet for this course.</p>"; return; }
  let rows = "";
  snap.forEach(d => {
    const q = d.data();
    rows += `<tr><td>${q.question}</td><td>${q.type}</td><td>${q.language}</td><td>${q.type === "theory" ? (q.marks || 10) + " marks" : (q.correct || "—")}</td>
      <td><button class="btn-danger" data-id="${d.id}">Delete</button></td></tr>`;
  });
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>Question</th><th>Type</th><th>Lang</th><th>Answer / Marks</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll("button[data-id]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this question?")) return;
    await deleteDoc(doc(db, COL.examQuestions, b.dataset.id));
    await logActivity(user.uid, "teacher", "delete_exam_question", course.id);
    loadTeacherExamList();
  });
}

/* ============================== STUDENT PROGRESS (teacher, own course) ============================== */
async function renderProgress() {
  currentView = "progress";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-chart-line"></i> Student Progress — ${course.title}</h2>${courseSwitcherHTML()}<div class="glass-card"><div id="progress-list">Loading…</div></div>`;
  bindCourseSwitcher();
  const wrap = document.getElementById("progress-list");

  try {
    const [arraySnap, legacySnap, attSnap, resultsSnap] = await Promise.all([
      getDocs(query(collection(db, COL.students), where("courseIds", "array-contains", course.id))),
      getDocs(query(collection(db, COL.students), where("courseId", "==", course.id))),
      getDocs(query(collection(db, COL.attendance), where("courseId", "==", course.id))),
      getDocs(query(collection(db, COL.results), where("courseId", "==", course.id)))
    ]);
    const studentMap = {};
    arraySnap.forEach(d => studentMap[d.id] = d.data());
    legacySnap.forEach(d => { if (!studentMap[d.id]) studentMap[d.id] = d.data(); });

    const attCount = {};
    attSnap.forEach(d => { const a = d.data(); attCount[a.studentId] = (attCount[a.studentId] || 0) + 1; });

    const resultMap = {};
    resultsSnap.forEach(d => { const r = d.data(); resultMap[r.studentUid] = r; });

    const studentIds = Object.keys(studentMap);
    if (!studentIds.length) { wrap.innerHTML = "<p>No students enrolled in this course yet.</p>"; return; }

    let rows = "";
    studentIds.forEach(uid => {
      const s = studentMap[uid];
      const att = attCount[s.studentId] || 0;
      const r = resultMap[uid];
      const resultLabel = r
        ? `${r.score}/${r.total} (${r.percent}%) — Grade ${r.grade}${r.needsManualGrading ? ' <span class="badge inactive">Theory pending</span>' : ""}`
        : "Not attempted";
      const certLabel = r && !r.needsManualGrading && r.percent >= 50
        ? '<span class="badge active">Eligible</span>'
        : '<span class="badge inactive">Not yet</span>';
      rows += `<tr><td>${s.studentId}</td><td>${s.fullName}</td><td>${att}</td><td>${resultLabel}</td><td>${certLabel}</td></tr>`;
    });
    wrap.innerHTML = `<table class="data-table"><thead><tr><th>Student ID</th><th>Name</th><th>Attendance</th><th>Exam Result</th><th>Certificate</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--danger);">Could not load progress: ${err.message}</p>`;
  }
}

/* ============================== GRADE THEORY ANSWERS (teacher, own course) ============================== */
const GRADING_LANGUAGES = [
  ["", "🌐 Translate answer…"], ["en", "English"], ["yo", "Yoruba"], ["fr", "French"], ["es", "Spanish"],
  ["pt", "Portuguese"], ["ar", "Arabic"], ["zh", "Chinese"], ["de", "German"], ["it", "Italian"],
  ["ru", "Russian"], ["hi", "Hindi"], ["sw", "Swahili"]
];

async function renderGrading() {
  currentView = "grading";
  if (!course) { main.innerHTML = "<p>No course assigned yet.</p>"; return; }
  main.innerHTML = `<h2><i class="fa-solid fa-marker"></i> Grade Theory Answers — ${course.title}</h2>${courseSwitcherHTML()}<div id="grading-list">Loading…</div>`;
  bindCourseSwitcher();
  const wrap = document.getElementById("grading-list");

  let snap;
  try {
    snap = await getDocs(query(collection(db, COL.results), where("courseId", "==", course.id)));
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--danger);">Could not load results: ${err.message}</p>`;
    return;
  }
  const withTheory = [];
  snap.forEach(d => { const r = d.data(); if (r.theoryAnswers && r.theoryAnswers.length) withTheory.push({ id: d.id, ...r }); });

  if (!withTheory.length) { wrap.innerHTML = "<p>No theory answers to grade yet for this course.</p>"; return; }

  wrap.innerHTML = "";
  withTheory.forEach((r) => renderGradingCard(r, wrap));
}

function renderGradingCard(r, wrap) {
  const gradedBefore = {};
  (r.theoryGrades || []).forEach(g => gradedBefore[g.qid] = g);

  const card = document.createElement("div");
  card.className = "glass-card";
  card.style.marginBottom = "16px";

  const langOptions = GRADING_LANGUAGES.map(([code, label]) => `<option value="${code}">${label}</option>`).join("");
  let qHtml = "";
  r.theoryAnswers.forEach((ta, idx) => {
    const prevGrade = gradedBefore[ta.qid];
    qHtml += `
      <div style="border-top:1px solid #e5e9f2;padding-top:12px;margin-top:12px;">
        <p><strong>Q${idx + 1} (${ta.marks || 10} marks):</strong> ${ta.question || "(question no longer available)"}</p>
        <div style="background:#f8f9fd;border-radius:10px;padding:12px;margin-bottom:8px;">
          <strong>Student's Answer:</strong>
          <p class="answer-text" data-idx="${idx}">${ta.text || "(no answer given)"}</p>
          <select class="translate-select" data-idx="${idx}" style="padding:6px 10px;border-radius:8px;border:1px solid #d8dde8;">${langOptions}</select>
        </div>
        <div class="row g-2">
          <div class="col-md-4 form-field">
            <label>Marks (out of ${ta.marks || 10})</label>
            <input type="number" min="0" max="${ta.marks || 10}" class="marks-input" data-qid="${ta.qid}" value="${prevGrade ? prevGrade.marks : ""}">
          </div>
          <div class="col-md-8 form-field">
            <label>Feedback (optional)</label>
            <textarea class="feedback-input" data-qid="${ta.qid}" rows="1">${prevGrade ? (prevGrade.feedback || "") : ""}</textarea>
          </div>
        </div>
      </div>`;
  });

  card.innerHTML = `
    <h4>${r.studentId} ${r.needsManualGrading ? '<span class="badge inactive">Pending</span>' : '<span class="badge active">Graded</span>'}</h4>
    ${qHtml}
    <button class="btn-gold save-grades-btn" style="margin-top:14px;">Save Grades</button>`;
  wrap.appendChild(card);

  // Per-answer translation, purely for the teacher's own understanding while grading
  card.querySelectorAll(".translate-select").forEach((sel) => {
    sel.onchange = async () => {
      const idx = Number(sel.dataset.idx);
      const ta = r.theoryAnswers[idx];
      const lang = sel.value;
      if (!lang || !ta.text) return;
      const target = card.querySelector(`.answer-text[data-idx="${idx}"]`);
      toast("Translating…", "info");
      try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(ta.text.slice(0, 4500))}`);
        const data = await res.json();
        const translated = Array.isArray(data?.[0]) ? data[0].map(seg => seg[0]).join("") : "";
        target.textContent = translated || ta.text;
        toast("Translated", "success");
      } catch (e) { toast("Translation failed — check your connection.", "error"); }
    };
  });

  card.querySelector(".save-grades-btn").onclick = async () => {
    const marksInputs = card.querySelectorAll(".marks-input");
    const theoryGrades = [];
    let valid = true;
    marksInputs.forEach((inp) => {
      const qid = inp.dataset.qid;
      const ta = r.theoryAnswers.find((t) => t.qid === qid);
      const max = ta ? (ta.marks || 10) : 10;
      const val = inp.value === "" ? 0 : Number(inp.value);
      if (isNaN(val) || val < 0 || val > max) { valid = false; inp.style.borderColor = "var(--danger)"; }
      else { inp.style.borderColor = ""; }
      const fb = card.querySelector(`.feedback-input[data-qid="${qid}"]`)?.value || "";
      theoryGrades.push({ qid, marks: val, feedback: fb });
    });
    if (!valid) { toast("Please enter valid marks within range for each question.", "error"); return; }

    // Recompute from the immutable objective baseline so re-grading is always safe, never compounding
    const objectiveScore = r.objectiveScore ?? r.score ?? 0;
    const objectiveTotal = r.objectiveTotal ?? r.total ?? 0;
    const theorySum = theoryGrades.reduce((sum, g) => sum + g.marks, 0);
    const theoryMax = r.theoryAnswers.reduce((sum, t) => sum + (t.marks || 10), 0);
    const combinedScore = objectiveScore + theorySum;
    const combinedTotal = objectiveTotal + theoryMax;
    const percent = combinedTotal ? Math.round((combinedScore / combinedTotal) * 100) : 0;
    const grade = percent >= 70 ? "A" : percent >= 60 ? "B" : percent >= 50 ? "C" : percent >= 40 ? "D" : "F";

    await updateDoc(doc(db, COL.results, r.id), {
      theoryGrades, score: combinedScore, total: combinedTotal, percent, grade,
      needsManualGrading: false, gradedBy: user.uid, gradedAt: serverTimestamp()
    });
    await logActivity(user.uid, "teacher", "grade_theory", `${r.studentId} - ${course.id}`);
    toast("Grades saved", "success");
    renderGrading();
  };
}
