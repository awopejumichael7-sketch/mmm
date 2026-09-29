/* ==========================================================================
   MATH-RENDER.JS — Markdown + LaTeX → safe, beautifully typeset HTML
   --------------------------------------------------------------------------
   Used by the textbook reader, the exam pages and the Content Studio preview.

   Authors write ordinary Markdown and put equations in LaTeX:
       inline   $x^2 + y^2 = r^2$        or   \( ... \)
       display  $$ \frac{-b \pm \sqrt{b^2-4ac}}{2a} $$      or   \[ ... \]
       chemistry $\ce{2H2 + O2 -> 2H2O}$                     (mhchem)
   Money is safe: "₦5 and $10" is NOT treated as maths. Write \$ for a literal $.

   Pipeline (the order matters — see comments):
     1. protect code blocks/spans        → so "$" inside code is left alone
     2. extract maths into placeholders  → so Markdown can't mangle _ * \\ inside equations
     3. Markdown → HTML                  (marked)
     4. sanitise the HTML                (DOMPurify) — author text is NEVER trusted
     5. decorate (callouts, table scroll wrappers)
     6. inject KaTeX output into the placeholders  ← after sanitising, so KaTeX's
        own markup is kept intact while everything an author typed was cleaned.

   All libraries are self-hosted (no CDN dependency, works offline) as flat
   files alongside every other project file — see katex.min.js, katex.min.css,
   mhchem.min.js, marked.umd.js and purify.min.js in the project root.
   ========================================================================== */

const VENDOR = new URL("./", import.meta.url).href; // vendor scripts now sit flat alongside every other project file

/* ---------- Lazy engine loader (loads once, shared by every caller) ---------- */
let enginePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}. Make sure it was uploaded alongside the other project files.`));
    document.head.appendChild(s);
  });
}
function loadCss(href) {
  if (document.querySelector("link[data-xc-katex]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href; l.dataset.xcKatex = "1";
  document.head.appendChild(l);
}

export function loadMathEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      loadCss(VENDOR + "katex.min.css");
      await loadScript(VENDOR + "katex.min.js");
      // mhchem extends KaTeX, so it must load after it; the others are independent.
      await Promise.all([
        loadScript(VENDOR + "mhchem.min.js"),
        loadScript(VENDOR + "marked.umd.js"),
        loadScript(VENDOR + "purify.min.js")
      ]);
      configureLibraries();
      return true;
    })().catch((err) => { enginePromise = null; throw err; }); // allow retry after a failed load
  }
  return enginePromise;
}

/* ---------- Configuration ---------- */
const MACROS = {
  "\\R": "\\mathbb{R}", "\\N": "\\mathbb{N}", "\\Z": "\\mathbb{Z}", "\\Q": "\\mathbb{Q}", "\\C": "\\mathbb{C}",
  "\\degree": "^{\\circ}"
};

const CALLOUTS = {
  NOTE: "Note", TIP: "Tip", KEY: "Key Point", IMPORTANT: "Important", WARNING: "Warning",
  DEFINITION: "Definition", THEOREM: "Theorem", FORMULA: "Formula", EXAMPLE: "Worked Example",
  PROOF: "Proof", SUMMARY: "Summary", EXERCISE: "Exercise"
};

let mdBlock = null, mdBreaks = null;

function configureLibraries() {
  mdBlock = new window.marked.Marked({ gfm: true, breaks: false });
  mdBreaks = new window.marked.Marked({ gfm: true, breaks: true });

  // Links open safely in a new tab; images are lazy and leak no referrer.
  window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "IMG") {
      node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
  });
}

const SANITIZE = {
  // No style tags/attributes (UI-redress), no form controls, no embeds (DOMPurify already blocks script/iframe/object).
  FORBID_TAGS: ["style", "form", "button", "input", "textarea", "select", "option", "link", "meta", "base"],
  FORBID_ATTR: ["style", "srcset", "formaction"],
  RETURN_DOM_FRAGMENT: true
};

/* ---------- Private-use characters used as placeholders (stripped from input first) ---------- */
const MATH_OPEN = "\uE000", MATH_CLOSE = "\uE001", CODE_OPEN = "\uE002", CODE_CLOSE = "\uE003", DOLLAR = "\uE004";

function extractMath(src, store) {
  src = src.replace(/[\uE000-\uE004]/g, ""); // never let authored text impersonate a placeholder

  // 1. Protect code so nothing inside it is treated as maths.
  const codes = [];
  src = src.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|``[^`\n]+``|`[^`\n]+`)/g, (m) => {
    codes.push(m);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });

  // 2. Escaped dollar → literal "$".
  src = src.replace(/\\\$/g, DOLLAR);

  const put = (tex, display) => {
    store.push({ tex: tex.replace(new RegExp(DOLLAR, "g"), "\\$").trim(), display });
    return `${MATH_OPEN}${store.length - 1}${MATH_CLOSE}`;
  };

  // 3. Display maths first (so "$$" isn't half-eaten by the inline rule).
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => put(t, true));
  src = src.replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(t, true));
  // 4. Inline maths.
  src = src.replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(t, false));
  //    Currency-safe "$…$": the opening $ must be followed by a non-space, the closing $ must not
  //    follow a space and must not be followed by a digit ("$5 and $10" is money, not maths).
  src = src.replace(/(^|[^\\$\w])\$(?![\s$])((?:[^$\n\\]|\\.)+?)(?<![\s\\])\$(?!\d)/g,
    (_, pre, t) => pre + put(t, false));

  // 5. Put code back for the Markdown parser.
  src = src.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"), (_, i) => codes[+i]);
  return src;
}

function renderTex(tex, display) {
  try {
    return window.katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,        // show the (red) source instead of breaking the whole page
      errorColor: "#c0392b",
      output: "htmlAndMathml",    // MathML alongside the visuals for screen readers
      strict: "ignore",
      trust: false,               // no \href / \includegraphics from authors
      maxExpand: 1000,            // guards against macro-expansion bombs
      macros: { ...MACROS }       // fresh copy each call: KaTeX mutates it for \gdef
    });
  } catch (e) {
    const span = document.createElement("span");
    span.className = "xc-math-error";
    span.textContent = tex;
    return span.outerHTML;
  }
}

/* ---------- Callouts + table wrappers (operate on the already-sanitised DOM) ---------- */
function decorate(fragment) {
  fragment.querySelectorAll("blockquote").forEach((bq) => {
    const p = bq.querySelector(":scope > p");
    if (!p || bq.firstElementChild !== p) return;
    const m = p.innerHTML.match(/^\s*\[!([A-Za-z]+)\][ \t]*(?:<br\s*\/?>|\n)?/);
    if (!m) return;
    const kind = m[1].toUpperCase();
    if (!CALLOUTS[kind]) return;
    p.innerHTML = p.innerHTML.slice(m[0].length);
    if (!p.textContent.trim() && !p.querySelector("img")) p.remove();
    const box = document.createElement("div");
    box.className = `xc-callout xc-callout-${kind.toLowerCase()}`;
    const title = document.createElement("div");
    title.className = "xc-callout-title";
    title.textContent = CALLOUTS[kind];
    box.appendChild(title);
    while (bq.firstChild) box.appendChild(bq.firstChild);
    bq.replaceWith(box);
  });
  fragment.querySelectorAll("table").forEach((t) => {
    const wrap = document.createElement("div");
    wrap.className = "xc-table-wrap"; // wide tables scroll sideways on phones instead of breaking the layout
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });
}

/* ==========================================================================
   PUBLIC API
   ========================================================================== */
export function isMathEngineReady() { return !!(mdBlock && window.katex && window.DOMPurify); }

/**
 * Render Markdown+LaTeX to safe HTML.  The engine must be loaded first: `await loadMathEngine()`.
 * @param {string} source
 * @param {{inline?: boolean, breaks?: boolean}} [opts]
 *   inline — no wrapping <p> (for exam options, headings, table cells)
 *   breaks — single newlines become <br> (natural for text typed into a textarea)
 */
export function renderRich(source, { inline = false, breaks = false } = {}) {
  if (!isMathEngineReady()) throw new Error("Math engine not loaded — call loadMathEngine() first.");
  const store = [];
  const text = extractMath(String(source ?? ""), store);
  const parser = breaks ? mdBreaks : mdBlock;
  const rawHtml = inline ? parser.parseInline(text) : parser.parse(text);

  const fragment = window.DOMPurify.sanitize(rawHtml, SANITIZE);
  if (!inline) decorate(fragment);

  const holder = document.createElement("div");
  holder.appendChild(fragment);
  return holder.innerHTML
    .replace(new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, "g"), (_, i) => (store[+i] ? renderTex(store[+i].tex, store[+i].display) : ""))
    .replace(new RegExp(DOLLAR, "g"), "$");
}

/** Convenience: load the engine (if needed) and render into an element. */
export async function renderInto(el, source, opts) {
  await loadMathEngine();
  el.innerHTML = renderRich(source, opts);
  return el;
}

/** Render several fields at once (question stems, options…) after a single engine load. */
export async function withMath(fn) { await loadMathEngine(); return fn(renderRich); }
