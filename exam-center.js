/* ==========================================================================
   EXAM-CENTER.JS — the student-facing Exam Centre
   --------------------------------------------------------------------------
   Category (Year 5–12 · JAMB · Post-UTME · Special)  →  Subject  →  Exams + Textbook
   Rendered inside the student dashboard's main panel by student.js.
   Every exam and textbook is a plain link that opens in its own page.
   ========================================================================== */
import { db, collection, getDocs, query, where } from "./xc-firebase.js";
import {
  CATEGORIES, CATEGORY_GROUPS, XC, getCategory, subjectsFor, escapeHtml, plural, colorFor
} from "./exam-catalog.js";
import { ensureStyles, loadSession, flushPendingResults } from "./xc-common.js";
import { loadingHtml, emptyStateHtml } from "./ui-states.js";

const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

export async function renderExamCentre(host, { user }) {
  ensureStyles();
  flushPendingResults().catch(() => {}); // deliver any result that was queued while offline

  const myClassKey = `xc_my_class_${user.uid}`;
  const lastKey = `xc_last_${user.uid}`;
  const store = {
    exams: {}, books: {},            // cached per category
    customSubjects: null,            // loaded once
    results: null                    // this student's results, loaded once per visit
  };

  host.innerHTML = `<div class="xc-hub" id="xc-root">
      <div class="xc-hero">
        <div>
          <h2><i class="fa-solid fa-graduation-cap"></i> Exam Centre</h2>
          <p>Choose your class or exam type, pick a subject, then take an exam or open the textbook.</p>
        </div>
      </div>
      <div id="xc-cats"></div>
      <div id="xc-body">${loadingHtml("Loading…")}</div>
    </div>`;
  const root = host.querySelector("#xc-root");
  const $ = (sel) => root.querySelector(sel);
  const alive = () => root.isConnected; // false once the student opens another dashboard view

  let state = { cat: null, sub: null, tab: "exams" };
  try {
    const saved = JSON.parse(localStorage.getItem(lastKey) || "null");
    const mine = localStorage.getItem(myClassKey);
    if (saved && getCategory(saved.cat)) state = { cat: saved.cat, sub: saved.sub || null, tab: saved.tab || "exams" };
    else if (mine && getCategory(mine)) state.cat = mine;
  } catch (e) { /* ignore corrupt saved state */ }

  const persist = () => { try { localStorage.setItem(lastKey, JSON.stringify(state)); } catch (e) {} };

  /* ---------- data ---------- */
  async function ensureResults() {
    if (store.results) return store.results;
    const byExam = {};
    try {
      const snap = await getDocs(query(collection(db, XC.results), where("studentUid", "==", user.uid)));
      snap.forEach((d) => { (byExam[d.data().examId] ||= []).push({ id: d.id, ...d.data() }); });
    } catch (e) { console.warn("Could not load results", e); }
    Object.values(byExam).forEach((list) => list.sort((a, b) => (a.attempt || 0) - (b.attempt || 0)));
    return (store.results = byExam);
  }
  async function ensureCustomSubjects() {
    if (store.customSubjects) return store.customSubjects;
    try {
      const snap = await getDocs(collection(db, XC.subjects));
      store.customSubjects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) { store.customSubjects = []; }
    return store.customSubjects;
  }
  async function ensureCategory(catId) {
    if (store.exams[catId] && store.books[catId]) return;
    const [ex, bk] = await Promise.all([
      getDocs(query(collection(db, XC.exams), where("categoryId", "==", catId), where("published", "==", true))),
      getDocs(query(collection(db, XC.books), where("categoryId", "==", catId), where("published", "==", true)))
    ]);
    store.exams[catId] = ex.docs.map((d) => ({ id: d.id, ...d.data() }));
    store.books[catId] = bk.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  /* ---------- category picker ---------- */
  function renderCategoryPicker() {
    const mine = localStorage.getItem(myClassKey);
    $("#xc-cats").innerHTML = `<nav class="xc-cats" aria-label="Choose your class or exam type">` +
      CATEGORY_GROUPS.map((g) => {
        const chips = CATEGORIES.filter((c) => c.group === g.id).map((c) => `
          <button type="button" class="xc-chip ${state.cat === c.id ? "active" : ""}" data-cat="${c.id}" title="${escapeHtml(c.sub)}">
            <i class="fa-solid ${c.icon}"></i>
            <span><b>${escapeHtml(c.label)}</b><small>${escapeHtml(c.sub)}</small></span>
            ${mine === c.id ? `<i class="fa-solid fa-star xc-mine" title="Your class"></i>` : ""}
          </button>`).join("");
        return `<div class="xc-cat-group"><div class="xc-cat-group-label">${escapeHtml(g.label)}</div><div class="xc-chips">${chips}</div></div>`;
      }).join("") + `</nav>`;
    root.querySelectorAll(".xc-chip").forEach((b) => b.onclick = () => { state = { cat: b.dataset.cat, sub: null, tab: "exams" }; persist(); renderAll(); });
  }

  /* ---------- views ---------- */
  async function renderHome() {
    const body = $("#xc-body");
    body.innerHTML = `<div class="glass-card xc-welcome">
        <i class="fa-solid fa-hand-pointer"></i>
        <h3>Select your class or exam type above</h3>
        <p>Year 5 – Year 12, JAMB, Post-UTME and Special Exams each have their own subjects, exams and textbooks.</p>
      </div><div id="xc-recent"></div>`;
    renderRecent(await ensureResults());
  }

  function renderRecent(byExam) {
    if (!alive()) return;
    const all = Object.values(byExam).flat().sort((a, b) => (b.submittedAtISO || "").localeCompare(a.submittedAtISO || "")).slice(0, 5);
    const el = $("#xc-recent");
    if (!el || !all.length) return;
    el.innerHTML = `<div class="glass-card" style="margin-top:16px;"><h4><i class="fa-solid fa-clock-rotate-left"></i> Your recent results</h4>
      <div class="xc-table-scroll"><table class="data-table"><thead><tr><th>Exam</th><th>Score</th><th>%</th><th>Grade</th><th>Date</th></tr></thead><tbody>
      ${all.map((r) => `<tr><td>${escapeHtml(r.examTitle)}</td><td>${r.score}/${r.total}</td><td>${r.percent}%${r.needsManualGrading ? " <small>(theory pending)</small>" : ""}</td><td>${escapeHtml(r.grade)}</td><td>${escapeHtml(r.date || "")}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  }

  async function renderCategory() {
    const cat = getCategory(state.cat);
    const body = $("#xc-body");
    body.innerHTML = loadingHtml("Loading subjects…");
    try { await Promise.all([ensureCategory(cat.id), ensureCustomSubjects(), ensureResults()]); }
    catch (e) { if (alive()) showError(body, e, renderAll); return; }
    if (!alive()) return;

    const mine = localStorage.getItem(myClassKey) === cat.id;
    const exams = store.exams[cat.id], books = store.books[cat.id];
    const subjects = subjectsFor(cat.id, store.customSubjects).map((s) => ({
      ...s,
      exams: exams.filter((e) => e.subjectId === s.id).length,
      books: books.filter((b) => b.subjectId === s.id).length
    }));
    // Subjects that actually have content come first; the rest keep their catalog order.
    subjects.sort((a, b) => ((b.exams + b.books > 0) - (a.exams + a.books > 0)));

    body.innerHTML = `
      <div class="xc-cat-head">
        <div><h3>${escapeHtml(cat.label)} <small>· ${escapeHtml(cat.sub)}</small></h3>
          <p>${plural(exams.length, "exam")} and ${plural(books.length, "textbook")} available.</p></div>
        <div class="xc-cat-tools">
          <input id="xc-subject-search" type="search" placeholder="Search subjects…" aria-label="Search subjects">
          <button type="button" class="btn-outline" id="xc-set-mine"><i class="fa-${mine ? "solid" : "regular"} fa-star"></i> ${mine ? "This is my class" : "Set as my class"}</button>
        </div>
      </div>
      <div class="xc-subject-grid" id="xc-subject-grid">
        ${subjects.map((s) => `
          <button type="button" class="xc-subject-card ${s.exams + s.books ? "" : "empty"}" data-sub="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name.toLowerCase())}" style="--c:${colorFor(s.id)}">
            <span class="xc-subject-icon"><i class="fa-solid ${escapeHtml(s.icon)}"></i></span>
            <span class="xc-subject-name">${escapeHtml(s.name)}</span>
            <span class="xc-subject-count">${s.exams + s.books
              ? `${plural(s.exams, "exam")} · ${plural(s.books, "textbook")}`
              : "Coming soon"}</span>
          </button>`).join("")}
      </div>
      <div id="xc-no-match" class="xc-hidden">${emptyStateHtml("No subject matches your search.", "fa-magnifying-glass")}</div>`;

    $("#xc-set-mine").onclick = () => { localStorage.setItem(myClassKey, cat.id); renderCategoryPicker(); renderCategory(); };
    $("#xc-subject-search").oninput = (e) => {
      const term = e.target.value.trim().toLowerCase();
      let shown = 0;
      root.querySelectorAll(".xc-subject-card").forEach((c) => { const ok = !term || c.dataset.name.includes(term); c.style.display = ok ? "" : "none"; if (ok) shown++; });
      $("#xc-no-match").classList.toggle("xc-hidden", shown > 0);
    };
    root.querySelectorAll(".xc-subject-card").forEach((c) => c.onclick = () => { state.sub = c.dataset.sub; state.tab = "exams"; persist(); renderSubject(); });
  }

  function statusFor(exam, results) {
    const mine = results[exam.id] || [];
    const max = Number(exam.maxAttempts ?? 1);
    const session = loadSession(user.uid, exam.id);
    const exhausted = max > 0 && mine.length >= max && !session;
    const last = mine[mine.length - 1] || null;
    const best = mine.reduce((m, r) => Math.max(m, r.percent || 0), 0);
    return { mine, max, session, exhausted, last, best };
  }

  async function renderSubject() {
    const cat = getCategory(state.cat);
    const body = $("#xc-body");
    body.innerHTML = loadingHtml("Loading…");
    try { await Promise.all([ensureCategory(cat.id), ensureCustomSubjects(), ensureResults()]); }
    catch (e) { if (alive()) showError(body, e, renderAll); return; }
    if (!alive()) return;

    const subject = subjectsFor(cat.id, store.customSubjects).find((s) => s.id === state.sub);
    if (!subject) { state.sub = null; persist(); return renderCategory(); }
    const exams = store.exams[cat.id].filter((e) => e.subjectId === subject.id).sort((a, b) => natural(a.title, b.title));
    const books = store.books[cat.id].filter((b) => b.subjectId === subject.id).sort((a, b) => natural(a.title, b.title));
    const results = store.results;
    if (state.tab === "textbook" && !books.length && exams.length) state.tab = "exams";

    body.innerHTML = `
      <button type="button" class="xc-back" id="xc-back"><i class="fa-solid fa-arrow-left"></i> ${escapeHtml(cat.label)} subjects</button>
      <div class="xc-subject-head" style="--c:${colorFor(subject.id)}">
        <span class="xc-subject-icon lg"><i class="fa-solid ${escapeHtml(subject.icon)}"></i></span>
        <div><h3>${escapeHtml(subject.name)}</h3><p>${escapeHtml(cat.label)} · ${escapeHtml(cat.sub)}</p></div>
      </div>
      <div class="tab-strip xc-tabs" role="tablist">
        <button type="button" role="tab" data-tab="exams" class="${state.tab === "exams" ? "active" : ""}"><i class="fa-solid fa-file-pen"></i> Exams (${exams.length})</button>
        <button type="button" role="tab" data-tab="textbook" class="${state.tab === "textbook" ? "active" : ""}"><i class="fa-solid fa-book-open"></i> Textbook (${books.length})</button>
      </div>
      <div id="xc-tab-body"></div>`;

    $("#xc-back").onclick = () => { state.sub = null; persist(); renderCategory(); };
    root.querySelectorAll(".xc-tabs button").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; persist(); renderSubject(); });
    $("#xc-tab-body").innerHTML = state.tab === "exams" ? examsHtml(exams, results) : booksHtml(books);
  }

  function examsHtml(exams, results) {
    if (!exams.length) return emptyStateHtml("No exams have been published for this subject yet. Check back soon.", "fa-file-circle-question");
    return `<div class="xc-list">${exams.map((e) => {
      const st = statusFor(e, results);
      const href = `exam-session.html?exam=${encodeURIComponent(e.id)}`;
      const attempts = st.max === 0 ? "Unlimited attempts" : plural(st.max, "attempt");
      let action;
      if (st.session) action = `<a class="btn-gold" href="${href}"><i class="fa-solid fa-play"></i> Resume exam</a>`;
      else if (st.exhausted) action = `<span class="xc-note"><i class="fa-solid fa-lock"></i> Attempt used</span>`;
      else action = `<a class="btn-gold" href="${href}"><i class="fa-solid fa-play"></i> ${st.mine.length ? "Try again" : "Start exam"}</a>`;
      const review = st.last ? `<a class="btn-outline" href="${href}&review=${encodeURIComponent(st.last.id)}"><i class="fa-solid fa-magnifying-glass-chart"></i> Review</a>` : "";
      const lastLine = st.last
        ? `<div class="xc-last ${st.last.passed ? "pass" : "fail"}">
             <i class="fa-solid ${st.last.needsManualGrading ? "fa-hourglass-half" : st.last.passed ? "fa-circle-check" : "fa-circle-xmark"}"></i>
             Last result: <b>${st.last.percent}%</b> · Grade ${escapeHtml(st.last.grade)}${st.last.needsManualGrading ? " · theory awaiting marking" : ""}
             ${st.mine.length > 1 ? ` · best ${st.best}%` : ""}
           </div>` : "";
      return `<article class="xc-card xc-exam">
          <div class="xc-card-main">
            <h4>${escapeHtml(e.title)}</h4>
            ${e.description ? `<p class="xc-desc">${escapeHtml(e.description)}</p>` : ""}
            <div class="xc-pills">
              <span><i class="fa-regular fa-circle-question"></i> ${plural(e.questionCount || 0, "question")}</span>
              <span><i class="fa-regular fa-clock"></i> ${e.durationMinutes || 30} min</span>
              <span><i class="fa-solid fa-bullseye"></i> Pass ${e.passMark ?? 50}%</span>
              <span><i class="fa-solid fa-rotate-right"></i> ${attempts}</span>
              ${e.secureMode !== false ? `<span class="secure"><i class="fa-solid fa-shield-halved"></i> Secure mode</span>` : ""}
            </div>
            ${lastLine}
          </div>
          <div class="xc-card-actions">${action}${review}</div>
        </article>`;
    }).join("")}</div>`;
  }

  function booksHtml(books) {
    if (!books.length) return emptyStateHtml("No textbook has been published for this subject yet.", "fa-book-open");
    return `<div class="xc-list">${books.map((b) => {
      let cont = "";
      try {
        const r = JSON.parse(localStorage.getItem(`xc_read_${user.uid}_${b.id}`) || "null");
        if (r && r.ch) cont = `<a class="btn-outline" href="textbook.html?book=${encodeURIComponent(b.id)}&ch=${encodeURIComponent(r.ch)}"><i class="fa-solid fa-bookmark"></i> Continue${r.title ? `: ${escapeHtml(String(r.title).slice(0, 32))}` : ""}</a>`;
      } catch (e) {}
      return `<article class="xc-card xc-book">
          <div class="xc-cover" style="--c:${colorFor(b.id)}"><i class="fa-solid fa-book"></i></div>
          <div class="xc-card-main">
            <h4>${escapeHtml(b.title)}</h4>
            ${b.author ? `<p class="xc-author">${escapeHtml(b.author)}</p>` : ""}
            ${b.description ? `<p class="xc-desc">${escapeHtml(b.description)}</p>` : ""}
            <div class="xc-pills"><span><i class="fa-solid fa-list-ol"></i> ${plural(b.chapterCount || 0, "chapter")}</span>
              <span><i class="fa-solid fa-square-root-variable"></i> Equations typeset</span></div>
          </div>
          <div class="xc-card-actions"><a class="btn-gold" href="textbook.html?book=${encodeURIComponent(b.id)}"><i class="fa-solid fa-book-open"></i> Open textbook</a>${cont}</div>
        </article>`;
    }).join("")}</div>`;
  }

  function showError(el, err, retry) {
    console.error(err);
    el.innerHTML = `<div class="glass-card xc-error"><i class="fa-solid fa-triangle-exclamation"></i>
      <p>Could not load this section. Please check your connection and try again.</p>
      <button type="button" class="btn-navy" id="xc-retry">Try again</button></div>`;
    el.querySelector("#xc-retry").onclick = retry;
  }

  /* ---------- router ---------- */
  async function renderAll() {
    if (!alive()) return;
    renderCategoryPicker();
    if (!state.cat) return renderHome();
    if (state.sub) return renderSubject();
    return renderCategory();
  }
  await renderAll();
}
