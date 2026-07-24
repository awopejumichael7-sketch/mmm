/* ==========================================================================
   WHITEBOARD.JS — Free, real-time collaborative whiteboard
   Shared by the Teacher Portal and Student Portal (one board per course).
   --------------------------------------------------------------------------
   Costs nothing extra: it reuses the Firestore project you already have on
   the free Spark plan. Each stroke a person draws is written once (on
   pointer-up, not per pixel) to `whiteboards/{courseId}/strokes/{strokeId}`,
   and everyone viewing that course's board is subscribed live via
   onSnapshot, exactly like the existing Live Class signaling in
   teacher.js / student.js. Writing once per stroke (instead of once per
   mouse-move) keeps Firestore usage — and therefore cost — minimal.
   ========================================================================== */
import {
  db, collection, doc, setDoc, deleteDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp
} from "./firebase-config.js";

const COLORS = ["#0b2545", "#d4af37", "#c0392b", "#1e8e5a", "#1c6fd8", "#111111"];

let unsubStrokes = null;
let strokesMap = new Map();     // strokeId -> stroke data
let canvas, ctx;
let drawing = false;
let currentColor = COLORS[0];
let currentWidth = 4;
let eraseMode = false;
let currentCourseId = null;
let resizeHandler = null;

/** Call this whenever the person navigates away from the Whiteboard view. */
export function stopWhiteboard() {
  if (unsubStrokes) { unsubStrokes(); unsubStrokes = null; }
  if (resizeHandler) { window.removeEventListener("resize", resizeHandler); resizeHandler = null; }
  strokesMap = new Map();
  currentCourseId = null;
  drawing = false;
}

/**
 * Render the whiteboard into `container` for the given course.
 * @param {HTMLElement} container - element to render into (e.g. #main-content)
 * @param {string} courseId
 */
export function renderWhiteboard(container, courseId) {
  stopWhiteboard(); // guard against a duplicate listener if re-entering the view
  currentCourseId = courseId;

  container.innerHTML = `
    <h2><i class="fa-solid fa-chalkboard"></i> Whiteboard</h2>
    <p style="color:var(--muted);">Shared live with everyone in this course — draw together in real time. Free: it runs on your existing Firebase project, no extra service.</p>
    <div class="glass-card" style="padding:14px;">
      <div class="wb-toolbar">
        ${COLORS.map(c => `<button class="wb-color${c === currentColor ? " active" : ""}" data-color="${c}" style="background:${c};"></button>`).join("")}
        <select id="wb-width" class="wb-select">
          <option value="2">Thin</option>
          <option value="4" selected>Medium</option>
          <option value="9">Thick</option>
        </select>
        <button class="btn-outline" id="wb-erase" type="button"><i class="fa-solid fa-eraser"></i> Eraser</button>
        <button class="btn-outline" id="wb-clear" type="button"><i class="fa-solid fa-trash"></i> Clear Board</button>
        <button class="btn-outline" id="wb-save" type="button"><i class="fa-solid fa-download"></i> Save as Image</button>
        <span style="flex:1;"></span>
        <span class="wb-live-dot" title="Synced live with everyone in this course"></span>
      </div>
      <canvas id="wb-canvas" class="wb-canvas"></canvas>
    </div>`;

  canvas = document.getElementById("wb-canvas");
  ctx = canvas.getContext("2d");
  fitCanvas();
  resizeHandler = () => fitCanvas();
  window.addEventListener("resize", resizeHandler);

  let pending = [];

  const start = (e) => { drawing = true; pending = [normPoint(e)]; };
  const move = (e) => {
    if (!drawing) return;
    const p = normPoint(e);
    pending.push(p);
    drawStrokeSegment(pending[pending.length - 2], p, currentColor, currentWidth, eraseMode);
  };
  const finish = async () => {
    if (!drawing) return;
    drawing = false;
    if (pending.length > 1) {
      const id = crypto.randomUUID();
      const strokeData = {
        points: pending, color: currentColor, width: currentWidth, erase: eraseMode,
        order: Date.now(), createdAt: serverTimestamp()
      };
      strokesMap.set(id, strokeData);
      try {
        await setDoc(doc(db, "whiteboards", currentCourseId, "strokes", id), strokeData);
      } catch (err) { console.warn("Whiteboard sync failed:", err); }
    }
    pending = [];
  };

  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointerleave", finish);

  document.querySelectorAll(".wb-color").forEach(b => {
    b.onclick = () => {
      currentColor = b.dataset.color;
      eraseMode = false;
      document.querySelectorAll(".wb-color").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("wb-erase").classList.remove("active");
    };
  });
  document.getElementById("wb-width").onchange = (e) => { currentWidth = Number(e.target.value); };
  document.getElementById("wb-erase").onclick = (e) => {
    eraseMode = !eraseMode;
    e.currentTarget.classList.toggle("active", eraseMode);
  };
  document.getElementById("wb-clear").onclick = async () => {
    if (!confirm("Clear the whiteboard for everyone in this course?")) return;
    const strokesCol = collection(db, "whiteboards", currentCourseId, "strokes");
    const snap = await getDocs(strokesCol);
    await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
    strokesMap.clear();
    redrawAll();
  };
  document.getElementById("wb-save").onclick = () => {
    const link = document.createElement("a");
    link.download = "whiteboard.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const strokesCol = collection(db, "whiteboards", courseId, "strokes");
  const q = query(strokesCol, orderBy("order"));
  unsubStrokes = onSnapshot(q, (snap) => {
    strokesMap.clear();
    snap.forEach(d => strokesMap.set(d.id, d.data()));
    redrawAll();
  }, (err) => console.warn("Whiteboard listener error:", err));
}

/* ---------- internal drawing helpers ---------- */
function normPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
}
function toPx(p) { return { x: p.x * canvas.width, y: p.y * canvas.height }; }
function drawStrokeSegment(p1, p2, color, width, erase) {
  if (!p1 || !p2 || !ctx) return;
  const a = toPx(p1), b = toPx(p2);
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
}
function redrawAll() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sorted = [...strokesMap.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const s of sorted) {
    for (let i = 1; i < s.points.length; i++) {
      drawStrokeSegment(s.points[i - 1], s.points[i], s.color, s.width, s.erase);
    }
  }
}
function fitCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = 500;
  redrawAll();
}
