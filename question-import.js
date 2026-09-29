/* ==========================================================================
   QUESTION-IMPORT.JS — bulk question parser for the Content Studio
   --------------------------------------------------------------------------
   Lets staff paste a whole question bank (typed in Word/Notepad) instead of
   filling in a form per question. Pure functions, no dependencies.

   FORMAT (blank lines are ignored; every field is optional except Q + answer):

       Q: What is $\frac{1}{2} + \frac{1}{3}$?
       A) $\frac{2}{5}$
       B) $\frac{5}{6}$
       C) $\frac{1}{5}$
       D) $\frac{2}{6}$
       ANSWER: B
       MARKS: 2
       EXPLANATION: The LCM of 2 and 3 is 6, so $\frac{3}{6}+\frac{2}{6}=\frac{5}{6}$.

       Q: [THEORY] Prove that the sum of two even numbers is even.
       MARKS: 5
       EXPLANATION: Let the numbers be $2a$ and $2b$ …

   • A question starts at a line beginning "Q:" / "Q1." / "Question 3:".
   • Options are A–E (also "A." or "(A)").  ANSWER is one letter.
   • A question with no options (or tagged [THEORY]) is a written (theory) question.
   • Stems, options and explanations may continue over several lines.
   • Default marks: 1 for objective, 10 for theory.
   ========================================================================== */

const START = /^\s*Q(?:uestion)?\s*\d*\s*[:.)]\s*(.*)$/i;
const OPTION = /^\s*\(?([A-Ea-e])[.)]\s+(.*)$/;
const ANSWER = /^\s*(?:ANSWER|ANS|CORRECT(?:\s+ANSWER)?)\s*[:=]\s*\(?([A-Ea-e])\)?\s*\.?\s*$/i;
const MARKS = /^\s*MARKS?\s*[:=]\s*(\d+(?:\.\d+)?)\s*$/i;
const EXPLANATION = /^\s*(?:EXPLANATION|SOLUTION|MARKING\s+GUIDE|GUIDE)\s*[:=]\s*(.*)$/i;

export const DEFAULT_OBJECTIVE_MARKS = 1;
export const DEFAULT_THEORY_MARKS = 10;

/**
 * @param {string} text
 * @returns {{questions: Array<{type:string, stem:string, options:Object, correct:string, marks:number, explanation:string}>,
 *            errors: Array<{n:number, message:string, preview:string}>, found:number}}
 */
export function parseQuestions(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const errors = [];
  let cur = null, section = null, blockNo = 0;

  const preview = (b) => (b.stem || "").split("\n")[0].slice(0, 70);
  const fail = (b, message) => errors.push({ n: b.n, message, preview: preview(b) });

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    let m;

    if ((m = line.match(START))) {
      cur = { n: ++blockNo, stem: m[1], options: {}, answer: "", marks: null, explanation: "", stray: [] };
      blocks.push(cur); section = "stem";
      continue;
    }
    if (!cur) {
      if (line.trim()) errors.push({ n: 0, message: "Text found before the first question (each question must start with “Q:”).", preview: line.slice(0, 70) });
      continue;
    }
    if ((m = line.match(ANSWER))) { cur.answer = m[1].toUpperCase(); section = "answer"; continue; }
    if ((m = line.match(MARKS))) { cur.marks = parseFloat(m[1]); section = "marks"; continue; }
    if ((m = line.match(EXPLANATION))) { cur.explanation = m[1]; section = "explanation"; continue; }
    if ((section === "stem" || section.length === 1) && (m = line.match(OPTION))) {
      section = m[1].toUpperCase();
      cur.options[section] = m[2];
      continue;
    }

    // Continuation line for whatever we're currently building.
    if (!line.trim()) { if (section === "stem" || section === "explanation" || section.length === 1) append(cur, section, ""); continue; }
    if (section === "answer" || section === "marks") { cur.stray.push(line.trim()); continue; }
    append(cur, section, line);
  }

  const questions = [];
  for (const b of blocks) {
    const stem = b.stem.replace(/\n{3,}/g, "\n\n").trim();
    const options = {};
    for (const [k, v] of Object.entries(b.options)) { const t = v.trim(); if (t) options[k] = t; }
    const optionKeys = Object.keys(options);
    const tagged = /^\s*\[THEORY\]\s*/i.test(stem);
    const isTheory = tagged || (optionKeys.length === 0 && !b.answer);
    const cleanStem = stem.replace(/^\s*\[THEORY\]\s*/i, "").trim();

    if (!cleanStem) { fail(b, "The question text is empty."); continue; }
    if (b.stray.length) { fail(b, `Unrecognised line after ANSWER/MARKS: “${b.stray[0].slice(0, 50)}”. Put explanations after “EXPLANATION:”.`); continue; }
    if (b.marks !== null && !(b.marks > 0)) { fail(b, "MARKS must be greater than 0."); continue; }

    if (isTheory) {
      questions.push({ type: "theory", stem: cleanStem, options: {}, correct: "", marks: b.marks ?? DEFAULT_THEORY_MARKS, explanation: b.explanation.trim() });
      continue;
    }
    if (optionKeys.length < 2) { fail(b, "An objective question needs at least two options (A, B, …). For a written question add “[THEORY]”."); continue; }
    if (!b.answer) { fail(b, "Missing “ANSWER: X” line."); continue; }
    if (!options[b.answer]) { fail(b, `ANSWER is ${b.answer}, but there is no option ${b.answer}.`); continue; }
    questions.push({ type: "objective", stem: cleanStem, options, correct: b.answer, marks: b.marks ?? DEFAULT_OBJECTIVE_MARKS, explanation: b.explanation.trim() });
  }
  return { questions, errors, found: blocks.length };
}

function append(cur, section, line) {
  if (section === "stem") cur.stem += "\n" + line;
  else if (section === "explanation") cur.explanation += "\n" + line;
  else if (section && section.length === 1) cur.options[section] += "\n" + line;
}
