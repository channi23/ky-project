import type { ParsedReceipt, ReceiptItem, TotalsCheck } from "./types";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `id${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*";

function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) || []).length;
}

/* ------------------------------------------------------------------ */
/* Amounts (Indian number format, OCR digit confusions)                */
/* ------------------------------------------------------------------ */

function fixOcrDigits(t: string): string {
  if (/^[\dOoIl|SB.,\-]+$/.test(t) && /\d/.test(t)) {
    return t.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/S/g, "5").replace(/B/g, "8");
  }
  return t;
}

/**
 * Parses an amount such as "1,23,456.00", "Rs.120/-", "120,50" or "(-)0.20".
 * Returns null when the text is not a number.
 */
export function parseAmount(raw: string): number | null {
  let t = raw.trim();
  t = t.replace(/^(?:₹|rs\.?|inr)\s*/i, "").replace(/\/-$/, "").replace(/[()]/g, "");
  let neg = false;
  if (t.startsWith("-")) {
    neg = true;
    t = t.slice(1);
  } else if (t.startsWith("+")) {
    t = t.slice(1);
  }
  if (t.startsWith("-")) {
    neg = !neg;
    t = t.slice(1);
  }
  t = fixOcrDigits(t);
  if (/^\d+,\d{2}$/.test(t)) {
    // "120,50": a valid Indian thousands group has 3 digits, so this is a decimal comma.
    t = t.replace(",", ".");
  } else {
    t = t.replace(/,/g, "");
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function isNumericToken(tok: string): boolean {
  return /\d/.test(fixOcrDigits(tok.replace(/[()]/g, ""))) && parseAmount(tok) !== null;
}

const UNIT = "(?:kgs?|gms?|g|mg|ltrs?|l|ml|pcs?|nos?|dz|doz|pkts?|box|bags?|units?)";
const UNIT_ONLY = new RegExp(`^${UNIT}\\.?$`, "i");
const QTY_UNIT = new RegExp(`^(\\d+(?:\\.\\d+)?)${UNIT}\\.?$`, "i");

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

function makeIso(d: number, m: number, y: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Finds the first valid date in the text and returns it as YYYY-MM-DD (Indian DD/MM order). */
export function parseDate(text: string): string | null {
  const t = text.replace(/(?<=\d[/\-.]?)[Oo](?=\d|[/\-.])/g, "0");

  const numeric = /(?<![\d.])(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4}|\d{2})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = numeric.exec(t)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    const iso = makeIso(a, b, y) ?? (b > 12 && a <= 12 ? makeIso(b, a, y) : null);
    if (iso) return iso;
  }

  const dayMonth = new RegExp(
    `(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.,]*${MONTH_RE}\\.?[\\s\\-/.,]*(\\d{4}|\\d{2})(?!\\d)`,
    "gi",
  );
  while ((m = dayMonth.exec(t)) !== null) {
    const iso = makeIso(parseInt(m[1], 10), MONTHS[m[2].toLowerCase()], parseInt(m[3], 10));
    if (iso) return iso;
  }

  const monthDay = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
  while ((m = monthDay.exec(t)) !== null) {
    const iso = makeIso(parseInt(m[2], 10), MONTHS[m[1].toLowerCase()], parseInt(m[3], 10));
    if (iso) return iso;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Line classification                                                 */
/* ------------------------------------------------------------------ */

function normalizeLine(raw: string): string {
  return raw
    .replace(/[\u200b\u00a0\t]/g, " ")
    .replace(/[|¦]/g, " ")
    .replace(/₹/g, " ")
    .replace(/\b(?:rs|inr)\b\.?\s*/gi, " ")
    .replace(/(\d)\s*\/-/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

type Kind =
  | "skip" | "cgst" | "sgst" | "igst" | "gst"
  | "subtotal" | "grand" | "total" | "adjust" | "payment" | "candidate";

interface Classified {
  kind: Kind;
  amount: number | null;
}

const SKIP_RE =
  /^(tax\s*invoice|invoice\s*(no|number|date)|bill\s*(no|number|date)|inv\.?\s*(no|date)|gstin|gst\s*(no|in|number|reg)|phone|ph\b|mob(ile)?\b|tel\b|email|e-mail|www|http|thank|visit|terms|cashier|table\b|token|order\s*(no|id)|fssai|dl\s*no|pan\b|cust(omer)?\b|time\b|date\b|dated\b)/i;
const PAYMENT_RE =
  /^(cash|change|balance|tendered|tender|paid|card|upi|gpay|google\s*pay|phonepe|paytm|received|amount\s*paid|payment|credit|debit|advance)\b/i;
const ADJUST_RE = /^(round(ing)?\s*off|r\.?\s*off|discount|disc\b|less\b|special\s*discount|bill\s*discount)/i;
const SUBTOTAL_RE = /sub\s*-?\s*total|taxable|net\s*sale|total\s*before/i;
const GRAND_RE =
  /grand\s*total|net\s*(amount|payable|total)|amount\s*payable|bill\s*(amount|total|value)|invoice\s*(total|value|amount)|total\s*(payable|due|amount|value)|payable\s*amount|net\s*pay/i;

function amountFromLine(line: string): number | null {
  const stripped = line.replace(/\d+(?:\.\d+)?\s*%/g, " ");
  const tokens = stripped.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (isNumericToken(tokens[i])) {
      const tok = tokens[i];
      // join a detached sign such as "- 0.20"
      const v = parseAmount(tok);
      if (v === null) continue;
      if (i > 0 && /^[-(]+\)?$/.test(tokens[i - 1]) && v > 0) return -v;
      return v;
    }
  }
  return null;
}

function classify(line: string): Classified {
  const l = line.toLowerCase();
  const l2 = l.replace(/\([^)]*\)/g, " ");

  if (SKIP_RE.test(l) || /tax\s*invoice/.test(l)) return { kind: "skip", amount: null };

  const amount = amountFromLine(line);

  const tax =
    /\b(cgst|c\.g\.s\.t|central\s*gst)\b/.test(l2) ? "cgst"
    : /\b(sgst|utgst|s\.g\.s\.t|state\s*gst)\b/.test(l2) ? "sgst"
    : /\bigst\b/.test(l2) ? "igst"
    : /\b(gst|tax|vat|cess)\b/.test(l2) && !/taxable/.test(l2) ? "gst"
    : null;
  if (tax) return { kind: amount === null ? "skip" : tax, amount };

  if (ADJUST_RE.test(l)) {
    if (amount === null) return { kind: "skip", amount: null };
    const isDiscount = /^(discount|disc\b|less\b|special\s*discount|bill\s*discount)/.test(l);
    return { kind: "adjust", amount: isDiscount ? -Math.abs(amount) : amount };
  }
  if (PAYMENT_RE.test(l)) return { kind: "payment", amount };
  if (SUBTOTAL_RE.test(l2)) return { kind: amount === null ? "skip" : "subtotal", amount };
  if (GRAND_RE.test(l2)) return { kind: amount === null ? "skip" : "grand", amount };
  if (/\btotal\b/.test(l2) && !/(qty|quantity|items?|pcs|units?|savings?|saved|discount)/.test(l2)) {
    return { kind: amount === null ? "skip" : "total", amount };
  }
  return { kind: "candidate", amount };
}

/* ------------------------------------------------------------------ */
/* Item lines                                                          */
/* ------------------------------------------------------------------ */

const NON_ITEM_START =
  /^(cash|change|balance|tendered|paid|card|upi|round|discount|disc|savings|you\s*saved|total|sub\s*total|net|grand|cgst|sgst|igst|gst|tax|taxable|amount|qty|items?|mrp|received|due|payment)\b/i;
const NON_ITEM_EXACT = /^(invoice|bill|receipt|memo|cash\s*memo|estimate|order|token|table|no|date|time)$/i;
const HEADER_WORDS =
  /\b(item|items|description|particulars|product|qty|quantity|rate|price|amount|amt|mrp|hsn|unit|sr|s\.?\s*no)\b/gi;

interface NumEntry {
  value: number;
  hasUnit: boolean;
  tokens: string[];
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.02);
}

function cleanName(s: string): string {
  return s
    .replace(/^[\s.,:;\-_=*#)(\]\[]+/, "")
    .replace(/[\s.,:;\-_=*#@)(\]\[]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseItemLine(line: string): Omit<ReceiptItem, "id"> | null {
  let s = line;
  let leadingQty: number | null = null;
  let serialDropped = false;

  const dotted = s.match(/^\s*(\d{1,3})\s*[.)\-:]\s+(?=\S)/);
  if (dotted) {
    s = s.slice(dotted[0].length);
    serialDropped = true;
  }

  const explicitQty = s.match(/^\s*(\d+(?:\.\d+)?)\s*[x×]\s+(?=\p{L})/iu);
  if (explicitQty) {
    leadingQty = parseFloat(explicitQty[1]);
    s = s.slice(explicitQty[0].length);
  }

  let bareLead: number | null = null;
  if (!serialDropped && leadingQty === null) {
    const bare = s.match(/^\s*(\d{1,3})\s+(?=\p{L})/u);
    if (bare) {
      bareLead = parseInt(bare[1], 10);
      s = s.slice(bare[0].length);
    }
  }

  const tokens = s.split(/\s+/).filter(Boolean);
  let i = tokens.length;
  const tail: string[] = [];
  while (i > 0) {
    const t = tokens[i - 1];
    if (isNumericToken(t) || QTY_UNIT.test(t) || UNIT_ONLY.test(t) || /^[x×X*@=:]$/.test(t) || /^\d+(\.\d+)?%$/.test(t)) {
      tail.unshift(t);
      i -= 1;
    } else {
      break;
    }
  }
  // separators or units at the very start of the tail belong to the name
  while (tail.length > 0 && (/^[x×X*@=:]$/.test(tail[0]) || (UNIT_ONLY.test(tail[0]) && !isNumericToken(tail[0])))) {
    i += 1;
    tail.shift();
  }

  const nameTokens = tokens.slice(0, i);

  // Build numeric entries from the tail.
  let hadX = false;
  const entries: NumEntry[] = [];
  for (const t of tail) {
    if (/^[x×X*]$/.test(t)) {
      hadX = true;
    } else if (/^[@=:]$/.test(t) || /%$/.test(t)) {
      continue;
    } else if (QTY_UNIT.test(t)) {
      const m = t.match(QTY_UNIT)!;
      entries.push({ value: parseFloat(m[1]), hasUnit: true, tokens: [t] });
    } else if (UNIT_ONLY.test(t) && !isNumericToken(t)) {
      if (entries.length > 0) {
        entries[entries.length - 1].hasUnit = true;
        entries[entries.length - 1].tokens.push(t);
      }
    } else {
      const v = parseAmount(t);
      if (v !== null) entries.push({ value: v, hasUnit: false, tokens: [t] });
    }
  }

  // HSN code in front of qty / rate / amount
  if (entries.length >= 4 && Number.isInteger(entries[0].value) && /^\d{4,8}$/.test(entries[0].tokens[0])) {
    entries.shift();
  }

  // Pack size such as "500g" before rate and amount belongs to the name
  if (entries.length >= 3 && entries[0].hasUnit && !near(entries[0].value * entries[1].value, entries[2].value)) {
    nameTokens.push(...entries[0].tokens);
    entries.shift();
  }

  if (entries.length === 0) return null;

  const name = cleanName(nameTokens.join(" "));
  if (letterCount(name) < 2) return null;
  if (NON_ITEM_START.test(name) || NON_ITEM_EXACT.test(name)) return null;

  let qty: number | null = null;
  let rate: number | null = null;
  let amount: number;
  let confidence: number;

  const nums = entries.map((e) => e.value);

  if (nums.length === 1) {
    amount = nums[0];
    const rawTok = entries[0].tokens[0];
    if (Number.isInteger(amount) && /^\d{6,}$/.test(rawTok)) return null; // pin code, phone, id
    if (leadingQty === null && bareLead !== null) leadingQty = bareLead;
    qty = leadingQty ?? 1;
    rate = qty !== 0 ? round2(amount / qty) : amount;
    confidence = leadingQty !== null ? 0.8 : 0.75;
  } else if (nums.length === 2) {
    const [a, b] = nums;
    if (hadX) {
      qty = a;
      rate = b;
      amount = round2(a * b);
      confidence = 0.8;
    } else if (entries[0].hasUnit) {
      qty = a;
      amount = b;
      rate = a !== 0 ? round2(b / a) : b;
      confidence = 0.8;
    } else if (Number.isInteger(a) && a >= 1 && a <= 20 && a < b) {
      qty = a;
      amount = b;
      rate = round2(b / a);
      confidence = 0.65;
    } else if (a === b) {
      qty = 1;
      rate = a;
      amount = b;
      confidence = 0.7;
    } else {
      rate = a;
      amount = b;
      const q = a !== 0 ? b / a : 1;
      qty = Math.abs(q - Math.round(q)) < 0.01 ? Math.round(q) : 1;
      confidence = near(a * qty, b) ? 0.65 : 0.5;
    }
  } else {
    const last = nums[nums.length - 1];
    let picked: [number, number, number] | null = null;
    // the last number is the amount; look for qty * rate = amount among the earlier ones
    for (let x = nums.length - 3; x >= 0 && !picked; x--) {
      for (let y = x + 1; y < nums.length - 1 && !picked; y++) {
        if (near(nums[x] * nums[y], last)) picked = [nums[x], nums[y], last];
      }
    }
    if (picked) {
      let [q, r] = picked;
      if (q >= 100 && r <= 99 && Number.isInteger(r)) [q, r] = [r, q];
      qty = q;
      rate = r;
      amount = last;
      confidence = 0.95;
    } else {
      qty = nums[nums.length - 3];
      rate = nums[nums.length - 2];
      amount = last;
      confidence = 0.45;
    }
  }

  if (!(amount > 0) && amount !== 0) return null;
  if (Math.abs(amount) >= 10_000_000) return null;

  const letters = letterCount(name);
  const nonSpace = name.replace(/\s/g, "").length || 1;
  if (letters / nonSpace < 0.6) confidence *= 0.8;
  if (name.length < 3) confidence *= 0.8;

  return { name, qty, rate, amount, confidence: Math.round(confidence * 100) / 100 };
}

/* ------------------------------------------------------------------ */
/* Whole receipt                                                       */
/* ------------------------------------------------------------------ */

const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;
const GENERIC_HEADINGS =
  /^(tax\s*invoice|cash\s*memo|cash\s*bill|bill|invoice|receipt|estimate|original|duplicate|customer\s*copy|retail\s*invoice|bill\s*of\s*supply)$/i;

function findGstin(line: string): string | null {
  const up = line.toUpperCase();
  const direct = up.match(GSTIN_RE);
  if (direct) return direct[1];
  if (/GST/i.test(line)) {
    const squeezed = up.replace(/[\s:\-]/g, "");
    const m = squeezed.match(/(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])/);
    if (m) return m[1];
  }
  return null;
}

export function parseReceiptText(text: string): ParsedReceipt {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter((l) => l.length > 0);
  const warnings: string[] = [];
  const consumed = new Set<number>();

  // GSTIN
  let gstin = "";
  lines.forEach((line, idx) => {
    if (gstin) return;
    const g = findGstin(line);
    if (g) {
      gstin = g;
      consumed.add(idx);
    }
  });

  // Date: prefer lines that say "date"
  let date = "";
  const dateKw = /\b(date|dated|dt|bill\s*date|inv(oice)?\s*date)\b|दिनांक|तारीख/i;
  for (let idx = 0; idx < lines.length && !date; idx++) {
    if (dateKw.test(lines[idx])) {
      const d = parseDate(lines[idx]);
      if (d) {
        date = d;
        consumed.add(idx);
      }
    }
  }
  for (let idx = 0; idx < lines.length && !date; idx++) {
    const d = parseDate(lines[idx]);
    if (d) {
      date = d;
      consumed.add(idx);
    }
  }

  // Classify every line
  const classes = lines.map((l, idx) => (consumed.has(idx) ? ({ kind: "skip", amount: null } as Classified) : classify(l)));
  const summaryKinds: Kind[] = ["subtotal", "grand", "total", "cgst", "sgst", "igst", "gst"];
  let summaryStart = classes.findIndex((c) => summaryKinds.includes(c.kind));
  if (summaryStart === -1) summaryStart = lines.length;

  // Header row (Item / Qty / Rate / Amount)
  let itemsStart = 0;
  for (let idx = 0; idx < Math.min(summaryStart, 25); idx++) {
    const found = new Set((lines[idx].match(HEADER_WORDS) || []).map((w) => w.toLowerCase().replace(/\s/g, "")));
    if (found.size >= 2 && !/\d+\.\d+/.test(lines[idx])) {
      itemsStart = idx + 1;
      consumed.add(idx);
      break;
    }
  }

  const collect = (from: number, to: number): ReceiptItem[] => {
    const out: ReceiptItem[] = [];
    for (let idx = from; idx < to; idx++) {
      if (consumed.has(idx)) continue;
      const c = classes[idx];
      if (c.kind === "adjust" && c.amount !== null) {
        out.push({ id: newId(), name: /round/i.test(lines[idx]) ? "Round off" : "Discount", qty: 1, rate: c.amount, amount: c.amount, confidence: 0.7 });
      } else if (c.kind === "candidate") {
        const it = parseItemLine(lines[idx]);
        if (it) out.push({ id: newId(), ...it });
      }
    }
    return out;
  };

  let items = collect(itemsStart, summaryStart);
  if (items.length === 0 && itemsStart > 0) items = collect(0, summaryStart);
  if (items.length === 0 && summaryStart < lines.length) items = collect(0, lines.length);

  // Totals and GST
  const sum = (kind: Kind): number | null => {
    const vals = classes.filter((c) => c.kind === kind && c.amount !== null).map((c) => c.amount as number);
    return vals.length ? round2(vals.reduce((a, b) => a + b, 0)) : null;
  };
  const lastOf = (kind: Kind): number | null => {
    const vals = classes.filter((c) => c.kind === kind && c.amount !== null).map((c) => c.amount as number);
    return vals.length ? vals[vals.length - 1] : null;
  };

  let gst: number | null = null;
  const totalGstIdx = lines.findIndex((l, idx) => classes[idx].kind === "gst" && /total\s*(gst|tax)/i.test(l));
  if (totalGstIdx >= 0) gst = classes[totalGstIdx].amount;
  else gst = sum("gst");

  const grand = lastOf("grand");
  const plain = lastOf("total");
  const total = grand ?? plain;

  // Vendor: first meaningful text line near the top
  let vendor = "";
  for (let idx = 0; idx < Math.min(lines.length, 6); idx++) {
    const l = lines[idx];
    if (consumed.has(idx)) continue;
    if (SKIP_RE.test(l) || GENERIC_HEADINGS.test(l)) continue;
    if (letterCount(l) < 3) continue;
    if (classes[idx].kind !== "candidate") continue;
    if (parseItemLine(l)) continue;
    vendor = cleanName(l);
    break;
  }

  if (!gstin) {
    const printed = lines.some(
      (l) => /gst\s*in|gst\s*no/i.test(l) && l.replace(/gst\s*in|gst\s*no\.?|number|[^A-Za-z0-9]/gi, "").length >= 10,
    );
    if (printed) warnings.push("A GSTIN is printed on the receipt but could not be read exactly. Please type it in.");
  }
  if (!date) warnings.push("No date found. Please enter it.");
  if (items.length === 0) warnings.push("No items found. Add rows manually or try a clearer photo.");
  if (total === null) warnings.push("No total found on the receipt.");

  return {
    vendor,
    date,
    gstin,
    items,
    subtotal: lastOf("subtotal"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    gst,
    total,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Totals check                                                        */
/* ------------------------------------------------------------------ */

export function sumItems(items: Pick<ReceiptItem, "amount">[]): number {
  return round2(items.reduce((acc, it) => acc + (it.amount ?? 0), 0));
}

export function gstTotal(r: Pick<ParsedReceipt, "cgst" | "sgst" | "igst" | "gst">): number {
  const split = (r.cgst ?? 0) + (r.sgst ?? 0) + (r.igst ?? 0);
  return round2(split > 0 ? split : r.gst ?? 0);
}

/**
 * Compares the printed total with the sum of items, with and without GST.
 * A difference of up to Rs 1 is accepted as rounding.
 */
export function checkTotals(r: Pick<ParsedReceipt, "items" | "cgst" | "sgst" | "igst" | "gst" | "total">): TotalsCheck {
  const itemsSum = sumItems(r.items);
  const gst = gstTotal(r);
  if (r.total === null || r.total === undefined) {
    return { itemsSum, gstTotal: gst, ok: null, diff: null };
  }
  const d1 = round2(r.total - itemsSum);
  const d2 = round2(r.total - (itemsSum + gst));
  const best = Math.abs(d1) <= Math.abs(d2) ? d1 : d2;
  return { itemsSum, gstTotal: gst, ok: Math.abs(best) <= 1.01, diff: best };
}
