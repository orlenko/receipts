// Turn an OCR text blob into structured receipt fields using regex + heuristics.
// Not expected to be great — classical extraction quality is exactly what this
// PoC is measuring against the LLM ground truth.

const MONTH_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_FR = { janvier: 1, 'février': 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, 'août': 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, 'décembre': 12, decembre: 12 };

// Money-looking number: 12.34, 1,234.56, 1 234.56, optional leading $.
const NUM_RE = /(?:\$\s?)?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{2}))/;
const NUM_RE_G = new RegExp(NUM_RE.source, 'g');

const DATE_PATTERNS = [
  // 2024-06-24 or 2024/06/24
  { re: /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/, parse: (m) => iso(+m[1], +m[2], +m[3]) },
  // 06/24/2024 or 24/06/2024 — if the first segment is > 12, treat as D/M/Y;
  // otherwise default to M/D/Y (most Canadian receipts printed in English follow the US convention).
  { re: /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](20\d{2})\b/, parse: (m) => {
      const a = +m[1], b = +m[2], y = +m[3];
      return a > 12 ? iso(y, b, a) : iso(y, a, b);
    } },
  // Jun 24, 2024 / June 24 2024
  { re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})[,\s]+(20\d{2})\b/i, parse: (m) => iso(+m[3], MONTH_EN[m[1].toLowerCase().slice(0, 3)], +m[2]) },
  // 24 Jun 2024
  { re: /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/i, parse: (m) => iso(+m[3], MONTH_EN[m[2].toLowerCase().slice(0, 3)], +m[1]) },
  // 24 juin 2024 (French)
  { re: /\b(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(20\d{2})\b/i, parse: (m) => iso(+m[3], MONTH_FR[m[2].toLowerCase()], +m[1]) },
];

function iso(y, m, d) {
  if (!y || !m || !d) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseNumber(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[$€£¥\s]/g, '').trim();
  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  let normalized = cleaned;
  if (hasDot && hasComma) {
    // Whichever appears last separates decimals.
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    const tail = cleaned.split(',').pop();
    normalized = tail.length === 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

// Find a number on the same line as a label (or the next line).
// Searches top-to-bottom; later matches win (receipts usually put the total near the bottom).
function numberAfterLabel(lines, labelRe) {
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(labelRe);
    if (!m) continue;
    const after = line.slice(m.index + m[0].length);
    const nm = after.match(NUM_RE);
    if (nm) { best = parseNumber(nm[1]); continue; }
    // Number might sit on the next line (tightly-wrapped receipts).
    if (i + 1 < lines.length) {
      const nm2 = lines[i + 1].match(NUM_RE);
      if (nm2) best = parseNumber(nm2[1]);
    }
  }
  return best;
}

export function extractFields(text) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // Brand: first non-noise line in the top few lines. Skip separators, phone-like patterns, tiny lines.
  let brand = '';
  for (const line of lines.slice(0, 6)) {
    if (/^[*=\-_.]+$/.test(line)) continue;
    if (/^\(?\d{3}\)?[\s\-.]\d{3}[\s\-.]\d{4}/.test(line)) continue; // phone
    if (/^\d+\s*$/.test(line)) continue;
    if (line.length < 3) continue;
    brand = line.replace(/[*#=_]+/g, '').trim();
    break;
  }

  // Date: try each pattern in order; first hit wins.
  let date = null;
  outer: for (const p of DATE_PATTERNS) {
    for (const line of lines) {
      const m = line.match(p.re);
      if (m) {
        const parsed = p.parse(m);
        if (parsed) { date = parsed; break outer; }
      }
    }
  }

  // Amount: prefer most-specific label, fall back progressively, then to "largest money-shaped number".
  let amount = numberAfterLabel(lines, /grand\s+total[\s:-]*\$?\s*/i);
  if (amount == null) amount = numberAfterLabel(lines, /total\s+(?:a\s+payer|à\s+payer|due)[\s:-]*\$?\s*/i);
  if (amount == null) amount = numberAfterLabel(lines, /amount\s+(?:due|paid)[\s:-]*\$?\s*/i);
  if (amount == null) amount = numberAfterLabel(lines, /\btotal[\s:-]*\$?\s*/i);
  if (amount == null) amount = numberAfterLabel(lines, /\bbalance[\s:-]*\$?\s*/i);
  if (amount == null) {
    // Fallback: largest money-shaped number on the receipt.
    const nums = [];
    for (const line of lines) {
      const matches = line.matchAll(NUM_RE_G);
      for (const mm of matches) {
        const v = parseNumber(mm[1]);
        if (v != null && v > 0 && v < 100000) nums.push(v);
      }
    }
    if (nums.length) amount = Math.max(...nums);
  }

  // Tax
  let tax = numberAfterLabel(lines, /(?:hst|gst|pst|qst|tps|tvq|tvh)[\s:\-]*(?:\d+(?:[.,]\d+)?%)?[\s:\-]*\$?\s*/i);
  if (tax == null) tax = numberAfterLabel(lines, /sales\s+tax[\s:-]*\$?\s*/i);
  if (tax == null) tax = numberAfterLabel(lines, /\bvat[\s:-]*\$?\s*/i);
  if (tax == null) tax = numberAfterLabel(lines, /^tax[\s:-]*\$?\s*/im);

  // Subtotal
  const subtotal = numberAfterLabel(lines, /(?:sub[\s-]?total|sous[\s-]?total)[\s:-]*\$?\s*/i);

  // Currency (very rough)
  let currency = '';
  const upper = text.toUpperCase();
  if (upper.includes('CAD')) currency = 'CAD';
  else if (upper.includes('USD')) currency = 'USD';
  else if (upper.includes('EUR') || text.includes('€')) currency = 'EUR';
  else if (text.includes('$')) currency = 'CAD'; // default in our sample population

  return { brand, vendor: brand, date, amount, tax, subtotal, currency };
}

// ── comparison ──────────────────────────────────────────────────────

export function compareFields(gt, local) {
  return {
    brand:  cmpBrand(gt.brand, local.brand),
    date:   cmpDate(gt.date, local.date),
    amount: cmpMoney(gt.amount, local.amount, 0.01, 0.05),
    tax:    cmpMoney(gt.tax,    local.tax,    0.01, 0.10),
  };
}

function cmpBrand(a, b) {
  const A = (a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const B = (b || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!A || !B) return 'na';
  if (A === B) return 'match';
  if (A.includes(B) || B.includes(A)) return 'partial';
  if (levenshtein(A, B) <= 3) return 'partial';
  // Split on whitespace: if any token (>=3 chars) is shared, call it a partial.
  const tokensA = A.split(' ').filter((t) => t.length >= 3);
  const tokensB = B.split(' ').filter((t) => t.length >= 3);
  if (tokensA.some((t) => tokensB.includes(t))) return 'partial';
  return 'miss';
}

function cmpDate(a, b) {
  if (!a || !b) return 'na';
  if (a === b) return 'match';
  return 'miss';
}

function cmpMoney(a, b, exactTol, fuzzyPct) {
  if (a == null || b == null) return 'na';
  const diff = Math.abs(a - b);
  if (diff < exactTol) return 'match';
  const denom = Math.max(Math.abs(a), 0.01);
  if (diff / denom < fuzzyPct) return 'partial';
  return 'miss';
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    }
  }
  return d[m][n];
}
