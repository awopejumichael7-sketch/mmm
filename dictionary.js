/* ==========================================================================
   DICTIONARY.JS — Free dictionary lookup (Student Portal)
   --------------------------------------------------------------------------
   Uses the free, keyless dictionaryapi.dev public API — no signup, no API
   key, no billing of any kind. If it's ever unreachable the view just shows
   a friendly error instead of breaking the page.
   ========================================================================== */

export function renderDictionary(container) {
  container.innerHTML = `
    <h2><i class="fa-solid fa-book"></i> Dictionary</h2>
    <p style="color:var(--muted);">Free word lookup — definitions, pronunciation, and examples.</p>
    <div class="glass-card">
      <div style="display:flex;gap:8px;">
        <input id="dict-input" type="text" placeholder="Type a word…" style="flex:1;padding:11px 14px;border-radius:10px;border:1.5px solid #d8dde8;">
        <button class="btn-navy" id="dict-search-btn" type="button"><i class="fa-solid fa-magnifying-glass"></i> Search</button>
      </div>
    </div>
    <div id="dict-results" style="margin-top:16px;"></div>`;

  const input = document.getElementById("dict-input");
  const go = () => lookup(input.value.trim());
  document.getElementById("dict-search-btn").onclick = go;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

async function lookup(word) {
  const results = document.getElementById("dict-results");
  if (!word) return;
  results.innerHTML = `<div class="skeleton" style="height:120px;"></div>`;
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) {
      results.innerHTML = `<div class="glass-card"><p><i class="fa-solid fa-circle-info"></i> No definition found for "<strong>${escapeHtml(word)}</strong>". Check the spelling and try again.</p></div>`;
      return;
    }
    const data = await res.json();
    results.innerHTML = data.map(entry => renderEntry(entry)).join("");
    results.querySelectorAll("[data-audio]").forEach(btn => {
      btn.onclick = () => new Audio(btn.dataset.audio).play().catch(() => {});
    });
  } catch (e) {
    results.innerHTML = `<div class="glass-card"><p><i class="fa-solid fa-triangle-exclamation"></i> Couldn't reach the dictionary service. Check your connection and try again.</p></div>`;
  }
}

function renderEntry(entry) {
  const phonetic = entry.phonetics?.find(p => p.text)?.text || entry.phonetic || "";
  const audio = entry.phonetics?.find(p => p.audio)?.audio || "";
  const meanings = (entry.meanings || []).map(m => `
    <div style="margin-top:10px;">
      <span class="badge active">${escapeHtml(m.partOfSpeech || "")}</span>
      <ol style="margin:8px 0 0 18px;padding:0;">
        ${(m.definitions || []).slice(0, 4).map(d => `
          <li style="margin-bottom:6px;">
            ${escapeHtml(d.definition)}
            ${d.example ? `<div style="color:var(--muted);font-size:.85rem;">"${escapeHtml(d.example)}"</div>` : ""}
          </li>`).join("")}
      </ol>
    </div>`).join("");

  return `
    <div class="glass-card" style="margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <h3 style="margin:0;">${escapeHtml(entry.word)}</h3>
        ${phonetic ? `<span style="color:var(--muted);">${escapeHtml(phonetic)}</span>` : ""}
        ${audio ? `<button class="icon-btn" style="background:var(--navy);" data-audio="${audio}" type="button"><i class="fa-solid fa-volume-high"></i></button>` : ""}
      </div>
      ${meanings}
    </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
