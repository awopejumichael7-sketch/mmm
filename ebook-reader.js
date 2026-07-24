/* ==========================================================================
   EBOOK-READER.JS — advanced reader with translation, highlights, bookmarks
   Works for PDF (text extracted via pdf.js), and plain text/markdown files.
   Other file types fall back to a protected embedded viewer.
   ========================================================================== */
import { initTheme, toggleTheme, protectElement, toast } from "./app-shell.js";
import { fetchPublicDriveFile } from "./drive-config.js";

initTheme();
document.getElementById("dark-toggle").onclick = () => {
  toggleTheme();
  document.getElementById("reader-page").classList.toggle("dark-mode");
};

const params = new URLSearchParams(window.location.search);
const fileUrl = params.get("url");
const driveFileId = params.get("fileId");
const source = params.get("source"); // "drive" or absent (Storage/plain URL)
const title = params.get("title") || "Document";
document.title = title + " — Reader";
document.getElementById("doc-title").textContent = title;

const readerPage = document.getElementById("reader-page");
const tocBox = document.getElementById("toc-box");
protectElement(readerPage);

let pages = [];       // array of plain-text page content
let currentPage = 0;
let fontSize = 17;
const storageKey = "cacgw_reader_" + btoa(title).slice(0, 24);

init();

async function init() {
  if (!fileUrl && !(source === "drive" && driveFileId)) { readerPage.innerHTML = "<p>No document specified.</p>"; return; }
  try {
    if (source === "drive") {
      const blob = await fetchPublicDriveFile(driveFileId);
      if (blob.type.startsWith("text/")) {
        pages = chunkText(await blob.text());
      } else if (blob.type === "application/pdf" || !blob.type) {
        await loadPdf(await blob.arrayBuffer());
      } else {
        readerPage.innerHTML = `<p>This file type can't be read inline. <a href="https://drive.google.com/file/d/${driveFileId}/view" target="_blank">Open in Google Drive</a>.</p>`;
        return;
      }
    } else if (fileUrl.toLowerCase().includes(".pdf")) {
      await loadPdf(fileUrl);
    } else if (fileUrl.match(/\.(txt|md)(\?|$)/i)) {
      const res = await fetch(fileUrl);
      const text = await res.text();
      pages = chunkText(text);
    } else {
      // Fallback: protected embedded viewer for other formats (docx, etc.)
      readerPage.innerHTML = `<iframe src="${fileUrl}" style="width:100%;height:75vh;border:0;border-radius:10px;" sandbox="allow-scripts allow-same-origin"></iframe>`;
      return;
    }
    buildTOC();
    restoreProgress();
    renderPage();
  } catch (e) {
    console.error(e);
    const detail = e?.message || "The link may be invalid, or you may be offline.";
    readerPage.innerHTML = `<p><strong>Could not load this document.</strong><br>${escapeHtml(detail)}${fileUrl ? ` <a href="${fileUrl}" target="_blank">Try opening it directly</a>.` : ""}</p>`;
  }
}

/* ---------- PDF text extraction via pdf.js — accepts either a URL or raw bytes (for Drive) ---------- */
/* ---------- pdf.js is self-hosted (pdf.min.js / pdf.worker.min.js in this
   same folder) rather than loaded from a CDN — this was switched after some
   networks/browsers were found to block third-party CDN scripts entirely,
   which broke the reader even with a CDN fallback in place. Loading it as a
   same-origin classic script sidesteps that completely. ---------- */
let pdfjsLoadPromise = null;
function loadPdfJsScript() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsLoadPromise) return pdfjsLoadPromise;
  pdfjsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./pdf.min.js";
    script.onload = () => {
      if (window.pdfjsLib) resolve(window.pdfjsLib);
      else reject(new Error("The PDF reader library loaded but did not initialize correctly."));
    };
    script.onerror = () => reject(new Error("Could not load the PDF reader library (pdf.min.js). Make sure it was uploaded alongside the other site files."));
    document.head.appendChild(script);
  });
  return pdfjsLoadPromise;
}

async function loadPdf(urlOrBytes) {
  const pdfjsLib = await loadPdfJsScript();
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.js";
  const loadingTask = typeof urlOrBytes === "string" ? pdfjsLib.getDocument(urlOrBytes) : pdfjsLib.getDocument({ data: urlOrBytes });
  const doc = await loadingTask.promise;
  pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(it => it.str).join(" ");
    pages.push(text || "(No extractable text on this page — it may be an image scan.)");
  }
}

function chunkText(text, wordsPerPage = 550) {
  const words = text.split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i += wordsPerPage) out.push(words.slice(i, i + wordsPerPage).join(" "));
  return out.length ? out : ["(Empty document)"];
}

/* ---------- TOC ---------- */
function buildTOC() {
  if (pages.length <= 1) return;
  let html = `<h5><i class="fa-solid fa-list"></i> Table of Contents</h5><div style="display:flex;flex-wrap:wrap;gap:6px;">`;
  pages.forEach((_, i) => { html += `<button class="btn-outline" data-p="${i}" style="padding:6px 12px;">Page ${i + 1}</button>`; });
  html += `</div>`;
  tocBox.innerHTML = html;
  tocBox.style.display = "block";
  tocBox.querySelectorAll("button").forEach(b => b.onclick = () => { currentPage = Number(b.dataset.p); renderPage(); });
}

/* ---------- Render current page ---------- */
function renderPage() {
  const highlights = JSON.parse(localStorage.getItem(storageKey + "_hl") || "{}");
  let content = pages[currentPage] || "";
  const savedHl = highlights[currentPage];
  readerPage.innerHTML = `
    <div style="font-size:${fontSize}px;line-height:${document.getElementById("line-spacing").value};">
      ${savedHl ? applyHighlights(content, savedHl) : escapeHtml(content)}
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:20px;">
      <button class="btn-outline" id="prev-page" ${currentPage === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-left"></i> Previous</button>
      <span style="color:var(--muted);">Page ${currentPage + 1} of ${pages.length}</span>
      <button class="btn-outline" id="next-page" ${currentPage === pages.length - 1 ? "disabled" : ""}>Next <i class="fa-solid fa-arrow-right"></i></button>
    </div>`;
  document.getElementById("prev-page")?.addEventListener("click", () => { stopSpeech(); currentPage--; renderPage(); saveProgress(); });
  document.getElementById("next-page")?.addEventListener("click", () => { stopSpeech(); currentPage++; renderPage(); saveProgress(); });
  saveProgress();
}
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function applyHighlights(text, phrases) {
  let html = escapeHtml(text);
  phrases.forEach(p => { if (p) html = html.split(escapeHtml(p)).join(`<mark class="hl">${escapeHtml(p)}</mark>`); });
  return html;
}

/* ---------- Progress autosave ---------- */
function saveProgress() { localStorage.setItem(storageKey, String(currentPage)); }
function restoreProgress() {
  const saved = localStorage.getItem(storageKey);
  if (saved !== null) { currentPage = Math.min(Number(saved), pages.length - 1); toast("Resumed from your last position", "success"); }
}

/* ---------- Toolbar interactions ---------- */
document.getElementById("font-plus").onclick = () => { fontSize = Math.min(fontSize + 2, 30); renderPage(); };
document.getElementById("font-minus").onclick = () => { fontSize = Math.max(fontSize - 2, 12); renderPage(); };
document.getElementById("line-spacing").onchange = renderPage;

document.getElementById("bookmark-btn").onclick = () => {
  const bms = JSON.parse(localStorage.getItem(storageKey + "_bm") || "[]");
  if (!bms.includes(currentPage)) bms.push(currentPage);
  localStorage.setItem(storageKey + "_bm", JSON.stringify(bms));
  toast(`Bookmarked page ${currentPage + 1}`, "success");
};

document.getElementById("highlight-btn").onclick = () => {
  const sel = window.getSelection().toString().trim();
  if (!sel) { toast("Select some text first, then click highlight.", "error"); return; }
  const highlights = JSON.parse(localStorage.getItem(storageKey + "_hl") || "{}");
  highlights[currentPage] = highlights[currentPage] || [];
  highlights[currentPage].push(sel);
  localStorage.setItem(storageKey + "_hl", JSON.stringify(highlights));
  renderPage();
  toast("Text highlighted", "success");
};

document.getElementById("search-box").addEventListener("input", (e) => {
  const term = e.target.value.trim().toLowerCase();
  if (!term) return;
  const foundIdx = pages.findIndex(p => p.toLowerCase().includes(term));
  if (foundIdx >= 0 && foundIdx !== currentPage) { currentPage = foundIdx; renderPage(); toast(`Found on page ${foundIdx + 1}`, "success"); }
});

/* ---------- Listen: read the current page aloud, including translated text.
   Honestly checks whether this device actually has a voice for the selected
   language before speaking, rather than silently mispronouncing it. ---------- */
let currentUtterance = null;
let voicesCache = [];

function loadVoices() {
  return new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing.length) { voicesCache = existing; resolve(existing); return; }
    speechSynthesis.onvoiceschanged = () => {
      voicesCache = speechSynthesis.getVoices();
      resolve(voicesCache);
    };
    // Some browsers never fire onvoiceschanged if there are truly no voices — time out gracefully
    setTimeout(() => resolve(voicesCache), 1500);
  });
}
loadVoices();

function findVoiceForLang(langCode) {
  return voicesCache.find(v => v.lang.toLowerCase().startsWith(langCode.toLowerCase()));
}

document.getElementById("listen-btn").onclick = async () => {
  const btn = document.getElementById("listen-btn");
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    btn.innerHTML = `<i class="fa-solid fa-volume-high"></i> Listen`;
    return;
  }
  const textEl = readerPage.querySelector("div");
  const text = textEl ? textEl.textContent.trim() : "";
  if (!text) { toast("Nothing to read on this page.", "error"); return; }

  const langSelect = document.getElementById("translate-lang");
  const lang = langSelect.value || "en";
  if (!voicesCache.length) await loadVoices();
  const voice = findVoiceForLang(lang);

  if (lang !== "en" && !voice) {
    const langName = langSelect.selectedOptions[0]?.textContent || lang;
    toast(`This device doesn't have a ${langName} voice installed, so it can't read this aloud accurately. Try another device, or read the translated text on screen instead.`, "error");
    return;
  }

  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.lang = lang;
  if (voice) currentUtterance.voice = voice;
  currentUtterance.onend = () => { btn.innerHTML = `<i class="fa-solid fa-volume-high"></i> Listen`; };
  speechSynthesis.speak(currentUtterance);
  btn.innerHTML = `<i class="fa-solid fa-stop"></i> Stop`;
};
// Stop any speech in progress if the reader navigates to a different page/translation
function stopSpeech() {
  if (speechSynthesis.speaking) speechSynthesis.cancel();
  const btn = document.getElementById("listen-btn");
  if (btn) btn.innerHTML = `<i class="fa-solid fa-volume-high"></i> Listen`;
}

/* ---------- Free translation — uses the same public endpoint Google Translate's
   own web client uses. No API key or Google Cloud billing required. Chosen over
   MyMemory for meaningfully better quality on lower-resource languages like Yoruba. ---------- */
document.getElementById("translate-lang").addEventListener("change", async (e) => {
  stopSpeech();
  const lang = e.target.value;
  if (!lang) return;
  const text = pages[currentPage];
  if (!text) return;
  toast("Translating…", "info");
  try {
    const chunk = text.slice(0, 4500); // practical safe limit for this endpoint
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${lang}&dt=t&q=${encodeURIComponent(chunk)}`);
    const data = await res.json();
    const translated = Array.isArray(data?.[0]) ? data[0].map(seg => seg[0]).join("") : "";
    readerPage.querySelector("div").innerHTML = escapeHtml(translated || "(Translation unavailable right now)") + (text.length > 4500 ? "<p style='color:var(--muted);font-size:.8rem;'>(This page is long — translation may be truncated.)</p>" : "");
    toast("Translated!", "success");
  } catch (err) {
    toast("Translation failed — check your connection.", "error");
  }
});
