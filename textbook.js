/* ==========================================================================
   TEXTBOOK.JS — Exam Centre textbook reader
   --------------------------------------------------------------------------
   Parallel to, and completely independent from, the original
   ebook-reader.html/ebook-reader.js (which still serves the Library's
   uploaded PDFs/handbooks/syllabus untouched). This reader is for textbooks
   authored inside the Exam Centre, with full Markdown + LaTeX/KaTeX
   rendering (equations, chemistry, tables, callouts) via math-render.js.

   Data model:
     xcBooks/{bookId}            → { title, author, description, subjectId,
                                      categoryId, chapterCount }
     xcChapters/{chapterId}      → { bookId, title, order, summary }  (small — listed up front)
     xcChapterBodies/{chapterId} → { content }                        (fetched only when a chapter opens)

   URL:  textbook.html?book=<bookId>[&ch=<chapterId>]
   ========================================================================== */
import { db, collection, doc, getDoc, getDocs, query, where, logActivity } from "./xc-firebase.js";
import { escapeHtml, plural } from "./exam-catalog.js";
import { guardRoles } from "./xc-common.js";
import { loadMathEngine, renderRich, isMathEngineReady } from "./math-render.js";
import { toast, protectElement, initTheme, toggleTheme } from "./app-shell.js";
import { loadingHtml, emptyStateHtml } from "./ui-states.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const bookId = params.get("book");

const FONT_KEY = "xc_tb_fontsize";
const FONT_MIN = 14, FONT_MAX = 26, FONT_DEFAULT = 18;

let user, role;
let book = null;
let chapters = [];          // [{id, title, order, summary}], sorted
let byId = {};
let bodyCache = {};         // chapterId -> rendered HTML (avoid re-fetching/re-rendering when paging back)
let currentChapterId = null;
let engineOK = false;
let sidebarOpen = false;
let progressSaveTimer = null;

const readKey = () => `xc_read_${user.uid}_${bookId}`;

/* ==========================================================================
   BOOT
   ========================================================================== */
(async function main() {
  initTheme();
  syncThemeIcon();
  wireChrome(); // header controls (theme/font/menu) don't depend on book data, so wire them before any early return

  if (!bookId) return fatal("No textbook was specified.");

  const ctx = await guardRoles(["student", "teacher", "admin"]);
  user = ctx.user; role = ctx.role;

  try { await loadMathEngine(); engineOK = isMathEngineReady(); } catch (e) { console.error("Math engine failed to load", e); }

  try {
    const snap = await getDoc(doc(db, "xcBooks", bookId));
    if (!snap.exists()) return fatal("This textbook could not be found, or it is not available yet.");
    book = { id: snap.id, ...snap.data() };
  } catch (e) {
    console.error(e);
    return fatal("Could not load this textbook. Please check your connection and try again.");
  }

  document.title = `${book.title} — Textbook`;
  $("tb-title").textContent = book.title;
  $("tb-side-title").textContent = book.title;
  $("tb-sub").textContent = book.author ? `by ${book.author}` : "Scholar's Camp · Textbook";

  try {
    const qs = await getDocs(query(collection(db, "xcChapters"), where("bookId", "==", bookId)));
    chapters = qs.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.title || "").localeCompare(String(b.title || "")));
    byId = Object.fromEntries(chapters.map((c) => [c.id, c]));
  } catch (e) {
    console.error(e);
    return fatal("Could not load the chapter list. Please check your connection and try again.");
  }

  renderToc();

  if (!chapters.length) {
    $("tb-article").innerHTML = emptyStateHtml("This textbook has no chapters published yet. Please check back soon.", "fa-book");
    $("tb-pager").innerHTML = "";
    return;
  }

  const requested = params.get("ch");
  const startId = (requested && byId[requested]) ? requested : resumeChapterId() || chapters[0].id;
  await openChapter(startId, { fromRestore: !requested });

  window.addEventListener("popstate", () => {
    const p = new URLSearchParams(window.location.search);
    const target = p.get("ch");
    if (target && byId[target] && target !== currentChapterId) openChapter(target, { pushState: false });
  });
})();

function fatal(message) {
  document.body.classList.add("tb-fatal");
  $("tb-article").innerHTML = `
    <div class="glass-card xc-error">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <h3>Unable to open textbook</h3>
      <p>${escapeHtml(message)}</p>
      <a class="btn-navy" href="student.html"><i class="fa-solid fa-arrow-left"></i> Back to dashboard</a>
    </div>`;
  $("tb-pager").innerHTML = "";
  $("tb-sidebar").innerHTML = "";
}

/* ==========================================================================
   CHROME: sidebar toggle, font size, theme, exit
   ========================================================================== */
function wireChrome() {
  $("tb-menu").addEventListener("click", () => setSidebar(!sidebarOpen));
  $("tb-backdrop").addEventListener("click", () => setSidebar(false));

  let fontSize = clampFont(parseInt(localStorage.getItem(FONT_KEY), 10) || FONT_DEFAULT);
  applyFont(fontSize);
  $("tb-font-up").addEventListener("click", () => { fontSize = clampFont(fontSize + 2); applyFont(fontSize); });
  $("tb-font-down").addEventListener("click", () => { fontSize = clampFont(fontSize - 2); applyFont(fontSize); });

  $("tb-theme").addEventListener("click", () => { toggleTheme(); syncThemeIcon(); });

  document.addEventListener("keydown", (e) => {
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") gotoAdjacent(1);
    else if (e.key === "ArrowLeft") gotoAdjacent(-1);
    else if (e.key === "Escape") setSidebar(false);
  });

  $("tb-main") && $("tb-main").addEventListener("scroll", onScroll);
  // The scrollable element may be the article's containing <main>; fall back to window scroll too.
  window.addEventListener("scroll", onScroll, { passive: true });
}

function setSidebar(open) {
  sidebarOpen = open;
  document.body.classList.toggle("tb-sidebar-open", open);
  $("tb-sidebar").classList.toggle("open", open);
  $("tb-backdrop").classList.toggle("show", open);
  $("tb-menu").setAttribute("aria-expanded", String(open));
}

function clampFont(n) { return Math.max(FONT_MIN, Math.min(FONT_MAX, n)); }
function applyFont(n) {
  document.documentElement.style.setProperty("--tb-font-size", `${n}px`);
  localStorage.setItem(FONT_KEY, String(n));
}

function syncThemeIcon() {
  const dark = document.body.getAttribute("data-theme") === "dark";
  const icon = $("tb-theme")?.querySelector("i");
  if (icon) icon.className = dark ? "fa-solid fa-sun" : "fa-solid fa-moon";
}

/* ==========================================================================
   TABLE OF CONTENTS
   ========================================================================== */
function renderToc() {
  const nav = $("tb-toc");
  nav.innerHTML = chapters.map((c, i) => `
    <a href="#" class="tb-toc-link" data-ch="${escapeHtml(c.id)}" role="link">
      <span class="tb-toc-num">${i + 1}</span>
      <span class="tb-toc-label">${escapeHtml(c.title || "Untitled chapter")}</span>
    </a>`).join("");
  nav.querySelectorAll(".tb-toc-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openChapter(a.dataset.ch);
      setSidebar(false);
    });
  });
}

function markActiveToc() {
  $("tb-toc").querySelectorAll(".tb-toc-link").forEach((a) => {
    a.classList.toggle("active", a.dataset.ch === currentChapterId);
  });
}

/* ==========================================================================
   OPENING A CHAPTER
   ========================================================================== */
async function openChapter(chapterId, { pushState = true, fromRestore = false } = {}) {
  const chapter = byId[chapterId];
  if (!chapter) return;
  currentChapterId = chapterId;
  markActiveToc();
  renderPager();

  const url = `textbook.html?book=${encodeURIComponent(bookId)}&ch=${encodeURIComponent(chapterId)}`;
  if (pushState) history.pushState({}, "", url);

  $("tb-sub").textContent = [chapter.title, book.author ? `by ${book.author}` : ""].filter(Boolean).join(" — ");
  const article = $("tb-article");

  if (bodyCache[chapterId] !== undefined) {
    article.innerHTML = bodyCache[chapterId];
    protectElement(article);
    afterRender(fromRestore);
    return;
  }

  article.innerHTML = loadingHtml("Loading chapter…");
  try {
    const snap = await getDoc(doc(db, "xcChapterBodies", chapterId));
    const content = snap.exists() ? (snap.data().content || "") : "";
    const html = content.trim()
      ? (engineOK ? renderRich(content) : `<pre class="tb-plain">${escapeHtml(content)}</pre>`)
      : emptyStateHtml("This chapter has no content yet.", "fa-file-lines");
    bodyCache[chapterId] = html;
    article.innerHTML = html;
    protectElement(article);
    afterRender(fromRestore);
    logActivity(user.uid, role, "textbook_chapter_open", `${book.title} — ${chapter.title}`).catch(() => {});
  } catch (e) {
    console.error(e);
    article.innerHTML = `<div class="glass-card xc-error"><i class="fa-solid fa-triangle-exclamation"></i>
      <p>Could not load this chapter. Please check your connection.</p>
      <button type="button" class="btn-navy" id="tb-retry"><i class="fa-solid fa-rotate-right"></i> Try again</button></div>`;
    $("tb-retry")?.addEventListener("click", () => openChapter(chapterId, { pushState: false }));
  }
}

function afterRender(fromRestore) {
  $("tb-main")?.scrollTo({ top: 0 });
  window.scrollTo({ top: 0 });
  if (fromRestore) {
    const saved = readSavedPosition();
    if (saved && saved.ch === currentChapterId && typeof saved.scroll === "number") {
      // Best-effort: restore roughly how far down the chapter the student had reached.
      requestAnimationFrame(() => {
        const el = $("tb-main") || document.scrollingElement;
        if (el) el.scrollTop = saved.scroll * (el.scrollHeight - el.clientHeight);
        updateProgressBar();
        saveReadingPosition(); // save AFTER restoring, not before — otherwise this would overwrite
      });               //   the just-read saved position with scroll:0 before it's ever applied
      return;
    }
  }
  updateProgressBar();
  saveReadingPosition();
}

/* ==========================================================================
   PAGER (previous / next chapter)
   ========================================================================== */
function renderPager() {
  const i = chapters.findIndex((c) => c.id === currentChapterId);
  const prev = chapters[i - 1], next = chapters[i + 1];
  $("tb-pager").innerHTML = `
    <button type="button" class="btn-outline" id="tb-prev" ${prev ? "" : "disabled"}>
      <i class="fa-solid fa-arrow-left"></i> ${prev ? escapeHtml(prev.title) : "Start of book"}
    </button>
    <span class="tb-pager-pos">${plural(chapters.length, "chapter")} · ${i + 1} of ${chapters.length}</span>
    <button type="button" class="btn-gold" id="tb-next" ${next ? "" : "disabled"}>
      ${next ? escapeHtml(next.title) : "End of book"} <i class="fa-solid fa-arrow-right"></i>
    </button>`;
  $("tb-prev")?.addEventListener("click", () => prev && openChapter(prev.id));
  $("tb-next")?.addEventListener("click", () => next && openChapter(next.id));
}

function gotoAdjacent(dir) {
  const i = chapters.findIndex((c) => c.id === currentChapterId);
  const target = chapters[i + dir];
  if (target) openChapter(target.id);
}

/* ==========================================================================
   PROGRESS BAR + READING-POSITION PERSISTENCE
   ========================================================================== */
function scrollFraction() {
  const el = $("tb-main") || document.scrollingElement;
  if (!el) return 0;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
}

function updateProgressBar() {
  const bar = $("tb-progress-bar");
  if (bar) bar.style.width = `${Math.round(scrollFraction() * 100)}%`;
}

function onScroll() {
  updateProgressBar();
  clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(saveReadingPosition, 600);
}

function readSavedPosition() {
  try { return JSON.parse(localStorage.getItem(readKey()) || "null"); } catch (e) { return null; }
}

function saveReadingPosition() {
  if (!currentChapterId) return;
  const chapter = byId[currentChapterId];
  try {
    localStorage.setItem(readKey(), JSON.stringify({
      ch: currentChapterId,
      title: chapter ? chapter.title : "",
      scroll: scrollFraction(),
      updatedAt: Date.now()
    }));
  } catch (e) { /* storage full/blocked — reading still works, just won't resume */ }
}

function resumeChapterId() {
  const saved = readSavedPosition();
  return saved && byId[saved.ch] ? saved.ch : null;
}
