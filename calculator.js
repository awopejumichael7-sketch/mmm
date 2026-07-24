/* ==========================================================================
   CALCULATOR.JS — Free scientific calculator (Student Portal)
   --------------------------------------------------------------------------
   100% client-side: no network calls, no dependencies, no cost of any kind.
   Uses a small hand-written expression parser (not eval()) so it's safe to
   run on arbitrary typed input.
   ========================================================================== */

const BUTTONS = [
  ["sin", "cos", "tan", "AC"],
  ["asin", "acos", "atan", "DEL"],
  ["log", "ln", "√", "^"],
  ["(", ")", "π", "e"],
  ["7", "8", "9", "÷"],
  ["4", "5", "6", "×"],
  ["1", "2", "3", "−"],
  ["0", ".", "%", "+"]
];

let expr = "";
let degMode = true;

export function renderCalculator(container) {
  expr = "";
  container.innerHTML = `
    <h2><i class="fa-solid fa-calculator"></i> Scientific Calculator</h2>
    <p style="color:var(--muted);">Free, works fully offline once the page has loaded.</p>
    <div class="glass-card calc-wrap">
      <div class="calc-topbar">
        <button class="btn-outline" id="calc-deg-toggle" type="button">${degMode ? "DEG" : "RAD"}</button>
      </div>
      <input id="calc-display" class="calc-display" type="text" readonly value="0">
      <div class="calc-grid" id="calc-grid"></div>
    </div>`;

  const grid = document.getElementById("calc-grid");
  BUTTONS.flat().forEach(label => {
    const btn = document.createElement("button");
    btn.className = "calc-btn" + (["AC", "DEL", "="].includes(label) ? " calc-btn-func" : /[0-9.]/.test(label) ? "" : " calc-btn-op");
    btn.textContent = label;
    btn.type = "button";
    btn.onclick = () => handlePress(label);
    grid.appendChild(btn);
  });
  const eq = document.createElement("button");
  eq.className = "calc-btn calc-btn-eq";
  eq.textContent = "=";
  eq.type = "button";
  eq.onclick = () => handlePress("=");
  grid.appendChild(eq);

  document.getElementById("calc-deg-toggle").onclick = (e) => {
    degMode = !degMode;
    e.currentTarget.textContent = degMode ? "DEG" : "RAD";
  };

  updateDisplay();
}

function handlePress(label) {
  const display = document.getElementById("calc-display");
  if (label === "AC") { expr = ""; }
  else if (label === "DEL") { expr = expr.slice(0, -1); }
  else if (label === "=") {
    try {
      const result = evaluateExpression(expr);
      expr = String(round(result));
    } catch (e) { expr = "Error"; }
  } else if (["sin", "cos", "tan", "asin", "acos", "atan", "log", "ln", "√"].includes(label)) {
    expr += label + "(";
  } else if (label === "π") { expr += "pi"; }
  else if (label === "e") { expr += "e"; }
  else if (label === "×") { expr += "*"; }
  else if (label === "÷") { expr += "/"; }
  else if (label === "−") { expr += "-"; }
  else { expr += label; }
  updateDisplay(display);
}

function updateDisplay() {
  const display = document.getElementById("calc-display");
  if (display) display.value = expr === "" ? "0" : expr;
}

function round(n) { return Math.round(n * 1e10) / 1e10; }

/* ---------- Safe recursive-descent expression parser ---------- */
function evaluateExpression(input) {
  const tokens = tokenize(input);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parseExpr() {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const rhs = parseFactor();
      v = op === "*" ? v * rhs : op === "/" ? v / rhs : v % rhs;
    }
    return v;
  }
  function parseFactor() {
    let v = parseUnary();
    while (peek() === "^") {
      next();
      const rhs = parseUnary();
      v = Math.pow(v, rhs);
    }
    return v;
  }
  function parseUnary() {
    if (peek() === "-") { next(); return -parseUnary(); }
    return parseAtom();
  }
  const FUNCS = {
    sin: (x) => Math.sin(toRad(x)), cos: (x) => Math.cos(toRad(x)), tan: (x) => Math.tan(toRad(x)),
    asin: (x) => fromRad(Math.asin(x)), acos: (x) => fromRad(Math.acos(x)), atan: (x) => fromRad(Math.atan(x)),
    log: (x) => Math.log10(x), ln: (x) => Math.log(x), "√": (x) => Math.sqrt(x)
  };
  function parseAtom() {
    const t = peek();
    if (t === "(") {
      next();
      const v = parseExpr();
      if (peek() === ")") next();
      return v;
    }
    if (FUNCS[t]) {
      next();
      if (peek() === "(") next();
      const v = parseExpr();
      if (peek() === ")") next();
      return FUNCS[t](v);
    }
    if (t === "pi") { next(); return Math.PI; }
    if (t === "e") { next(); return Math.E; }
    if (typeof t === "number") { next(); return t; }
    throw new Error("Unexpected token: " + t);
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error("Trailing tokens");
  return result;
}
function toRad(x) { return degMode ? (x * Math.PI) / 180 : x; }
function fromRad(x) { return degMode ? (x * 180) / Math.PI : x; }

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const words = ["sin", "cos", "tan", "asin", "acos", "atan", "log", "ln", "pi"];
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let num = "";
      while (i < input.length && /[0-9.]/.test(input[i])) { num += input[i]; i++; }
      tokens.push(parseFloat(num));
      continue;
    }
    if (c === "√") { tokens.push("√"); i++; continue; }
    if (/[a-z]/i.test(c)) {
      let word = "";
      while (i < input.length && /[a-z]/i.test(input[i])) { word += input[i]; i++; }
      if (word === "e") { tokens.push("e"); }
      else if (words.includes(word)) { tokens.push(word); }
      else { throw new Error("Unknown token: " + word); }
      continue;
    }
    if ("+-*/%^()".includes(c)) { tokens.push(c); i++; continue; }
    throw new Error("Unexpected character: " + c);
  }
  return tokens;
}
