/* ==========================================================================
   EXAM-CATALOG.JS — Exam Centre catalog (pure data + helpers, no Firebase)
   --------------------------------------------------------------------------
   Single source of truth for:
     • the student categories  (Year 5 … Year 12, JAMB, Post-UTME, Special)
     • the default subjects offered in each category
     • the Firestore collection names used by the Exam Centre
   Everything here is deliberately dependency-free so it can be unit-tested.

   The Exam Centre uses its OWN collections (prefixed "xc") and never reads
   or writes the original course-based collections (courses, results,
   examQuestions …), so the existing Bible-College features are unaffected.
   ========================================================================== */

/* ---------- Firestore collection names ---------- */
export const XC = {
  subjects: "xcSubjects",         // custom subjects added by staff (merged with defaults below)
  exams: "xcExams",               // one doc per exam
  questions: "xcQuestions",       // one doc per question (linked by examId)
  books: "xcBooks",               // one doc per textbook
  chapters: "xcChapters",         // chapter metadata (title/order/format) — small, fast to list
  chapterBodies: "xcChapterBodies", // chapter content, doc id === chapter id — fetched on open
  results: "xcResults"            // one doc per submitted attempt
};

/* ---------- Categories ----------
   Year numbering follows the Nigerian 6-3-3 structure:
   Year 5–6 = Primary 5–6, Year 7–9 = JSS 1–3, Year 10–12 = SS 1–3. */
export const CATEGORY_GROUPS = [
  { id: "primary",   label: "Primary" },
  { id: "junior",    label: "Junior Secondary" },
  { id: "senior",    label: "Senior Secondary" },
  { id: "entrance",  label: "University Entrance" },
  { id: "special",   label: "Special Exams" }
];

export const CATEGORIES = [
  { id: "year-5",  group: "primary", label: "Year 5",  sub: "Primary 5",  icon: "fa-seedling" },
  { id: "year-6",  group: "primary", label: "Year 6",  sub: "Primary 6",  icon: "fa-seedling" },
  { id: "year-7",  group: "junior",  label: "Year 7",  sub: "JSS 1",      icon: "fa-book-open-reader" },
  { id: "year-8",  group: "junior",  label: "Year 8",  sub: "JSS 2",      icon: "fa-book-open-reader" },
  { id: "year-9",  group: "junior",  label: "Year 9",  sub: "JSS 3",      icon: "fa-book-open-reader" },
  { id: "year-10", group: "senior",  label: "Year 10", sub: "SS 1",       icon: "fa-graduation-cap" },
  { id: "year-11", group: "senior",  label: "Year 11", sub: "SS 2",       icon: "fa-graduation-cap" },
  { id: "year-12", group: "senior",  label: "Year 12", sub: "SS 3",       icon: "fa-graduation-cap" },
  { id: "jamb",      group: "entrance", label: "JAMB Students",      sub: "UTME preparation",     icon: "fa-pen-ruler" },
  { id: "post-utme", group: "entrance", label: "Post-UTME Students", sub: "University screening", icon: "fa-building-columns" },
  { id: "special",   group: "special",  label: "Special Exams",      sub: "Common Entrance, BECE, WAEC, NECO & more", icon: "fa-award" }
];

export function getCategory(id) { return CATEGORIES.find(c => c.id === id) || null; }

/* ---------- Subject helper ---------- */
const S = (name, icon) => ({ id: slugify(name), name, icon });

/* Icons are Font Awesome 6 free-solid names (already loaded by every page). */
const ICONS = {
  math: "fa-square-root-variable", english: "fa-book", science: "fa-microscope", tech: "fa-gears",
  social: "fa-people-group", civic: "fa-scale-balanced", business: "fa-briefcase", computer: "fa-laptop-code",
  agric: "fa-seedling", home: "fa-utensils", crs: "fa-cross", irs: "fa-mosque", lang: "fa-language",
  physics: "fa-atom", chem: "fa-flask", bio: "fa-dna", econ: "fa-chart-line", gov: "fa-landmark",
  lit: "fa-feather-pointed", geo: "fa-earth-africa", commerce: "fa-store", acct: "fa-calculator",
  history: "fa-landmark-dome", reasoning: "fa-brain", news: "fa-newspaper", general: "fa-lightbulb",
  award: "fa-award", trophy: "fa-trophy", mock: "fa-stopwatch", scholar: "fa-medal"
};

const PRIMARY_SUBJECTS = [
  S("Mathematics", ICONS.math), S("English Language", ICONS.english), S("Basic Science", ICONS.science),
  S("Social Studies", ICONS.social), S("Civic Education", ICONS.civic), S("Computer Studies", ICONS.computer),
  S("Verbal Reasoning", ICONS.reasoning), S("Quantitative Reasoning", ICONS.reasoning),
  S("Christian Religious Studies", ICONS.crs), S("Islamic Religious Studies", ICONS.irs)
];

const JUNIOR_SUBJECTS = [
  S("Mathematics", ICONS.math), S("English Language", ICONS.english), S("Basic Science", ICONS.science),
  S("Basic Technology", ICONS.tech), S("Social Studies", ICONS.social), S("Civic Education", ICONS.civic),
  S("Business Studies", ICONS.business), S("Computer Studies", ICONS.computer),
  S("Agricultural Science", ICONS.agric), S("Home Economics", ICONS.home),
  S("Christian Religious Studies", ICONS.crs), S("Islamic Religious Studies", ICONS.irs),
  S("Yoruba", ICONS.lang), S("Igbo", ICONS.lang), S("Hausa", ICONS.lang)
];

const SENIOR_SUBJECTS = [
  S("Mathematics", ICONS.math), S("English Language", ICONS.english), S("Further Mathematics", ICONS.math),
  S("Physics", ICONS.physics), S("Chemistry", ICONS.chem), S("Biology", ICONS.bio),
  S("Economics", ICONS.econ), S("Government", ICONS.gov), S("Literature in English", ICONS.lit),
  S("Geography", ICONS.geo), S("Commerce", ICONS.commerce), S("Financial Accounting", ICONS.acct),
  S("Agricultural Science", ICONS.agric), S("Computer Studies", ICONS.computer), S("Civic Education", ICONS.civic),
  S("History", ICONS.history), S("Christian Religious Studies", ICONS.crs), S("Islamic Religious Studies", ICONS.irs),
  S("Yoruba", ICONS.lang), S("Igbo", ICONS.lang), S("Hausa", ICONS.lang)
];

const JAMB_SUBJECTS = [
  S("Use of English", ICONS.english), S("Mathematics", ICONS.math), S("Physics", ICONS.physics),
  S("Chemistry", ICONS.chem), S("Biology", ICONS.bio), S("Economics", ICONS.econ),
  S("Government", ICONS.gov), S("Literature in English", ICONS.lit), S("Geography", ICONS.geo),
  S("Commerce", ICONS.commerce), S("Principles of Accounts", ICONS.acct), S("Agricultural Science", ICONS.agric),
  S("History", ICONS.history), S("Christian Religious Studies", ICONS.crs), S("Islamic Religious Studies", ICONS.irs)
];

const POST_UTME_SUBJECTS = [
  S("Use of English", ICONS.english), S("Mathematics", ICONS.math), S("General Studies", ICONS.general),
  S("Current Affairs", ICONS.news), S("Physics", ICONS.physics), S("Chemistry", ICONS.chem),
  S("Biology", ICONS.bio), S("Economics", ICONS.econ), S("Government", ICONS.gov),
  S("Literature in English", ICONS.lit), S("Commerce", ICONS.commerce), S("Accounting", ICONS.acct),
  S("Aptitude Test", ICONS.reasoning)
];

const SPECIAL_SUBJECTS = [
  S("Common Entrance", ICONS.award), S("BECE (Junior WAEC)", ICONS.award), S("WAEC (SSCE)", ICONS.award),
  S("NECO (SSCE)", ICONS.award), S("Scholarship Exams", ICONS.scholar), S("Aptitude & Reasoning", ICONS.reasoning),
  S("Mock Examinations", ICONS.mock)
];

export const DEFAULT_SUBJECTS = {
  "year-5": PRIMARY_SUBJECTS, "year-6": PRIMARY_SUBJECTS,
  "year-7": JUNIOR_SUBJECTS, "year-8": JUNIOR_SUBJECTS, "year-9": JUNIOR_SUBJECTS,
  "year-10": SENIOR_SUBJECTS, "year-11": SENIOR_SUBJECTS, "year-12": SENIOR_SUBJECTS,
  "jamb": JAMB_SUBJECTS, "post-utme": POST_UTME_SUBJECTS, "special": SPECIAL_SUBJECTS
};

/** Default subjects merged with any custom ones staff added (custom = [{id,name,icon?,categoryId}]). */
export function subjectsFor(categoryId, customSubjects = []) {
  const base = (DEFAULT_SUBJECTS[categoryId] || []).map(s => ({ ...s, custom: false }));
  const seen = new Set(base.map(s => s.id));
  const extra = customSubjects
    .filter(s => s.categoryId === categoryId && s.id && !seen.has(s.id))
    .map(s => ({ id: s.id, name: s.name, icon: s.icon || "fa-book", custom: true }));
  return [...base, ...extra];
}

/* ---------- Shared utilities ---------- */
export function slugify(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Same grade bands the original exam engine uses, so grades mean the same thing everywhere. */
export function gradeFor(percent) {
  return percent >= 70 ? "A" : percent >= 60 ? "B" : percent >= 50 ? "C" : percent >= 40 ? "D" : "F";
}

/** Fisher–Yates (unbiased, unlike sort(() => Math.random() - .5)). */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function plural(n, one, many = one + "s") { return `${n} ${n === 1 ? one : many}`; }

/** Stable, pleasant colour per subject (same subject → same colour everywhere). */
const PALETTE = ["#0c4f36", "#1e3a8a", "#0f766e", "#7c2d12", "#4c1d95", "#831843", "#134e4a", "#3730a3", "#78350f", "#1e293b", "#166534", "#9a3412"];
export function colorFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Compute a full scoring summary from objective/theory marks (used at submit AND when a teacher grades). */
export function summarize({ objectiveScore, objectiveTotal, theoryScore, theoryTotal, passMark = 50 }) {
  const hasTheory = theoryTotal > 0;
  const graded = !hasTheory || typeof theoryScore === "number";
  const score = objectiveScore + (graded && hasTheory ? theoryScore : 0);
  const total = objectiveTotal + (graded && hasTheory ? theoryTotal : 0);
  const percent = total ? Math.round((score / total) * 100) : 0;
  return { score, total, percent, grade: gradeFor(percent), passed: percent >= passMark, needsManualGrading: hasTheory && !graded };
}
