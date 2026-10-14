import "./style.css";
import type { Receipt, ReceiptItem } from "./types";
import { checkTotals, newId, parseAmount, parseReceiptText, round2 } from "./parser";
import { runOcr } from "./ocr";
import { ENHANCED_URL, enhancedHost, runEnhancedOcr } from "./enhanced";
import { downloadBlob, suggestedFileName, workbookToBlob } from "./excel";
import { UserError, errorMessage } from "./errors";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const IMAGE_NAME = /\.(jpe?g|png|webp|bmp|gif|heic|heif|avif)$/i;

interface Job {
  id: string;
  file: File;
  state: "queued" | "working" | "done" | "error";
  pct: number;
  message: string;
}

const receipts: Receipt[] = [];
const thumbs = new Map<string, string>();
const jobs: Job[] = [];
let draining = false;
let enhancedOn = false;

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const fmtInr = (n: number): string => inr.format(n);

function numStr(n: number | null): string {
  return n === null || n === undefined ? "" : String(Number(n.toFixed(3)));
}

let toastTimer: number | undefined;
function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 3500);
}

/* ------------------------------------------------------------------ */
/* Upload and processing queue                                         */
/* ------------------------------------------------------------------ */

function addFiles(list: FileList | File[]): void {
  const files = Array.from(list);
  if (files.length === 0) return;
  for (const file of files) {
    const looksLikeImage = file.type.startsWith("image/") || IMAGE_NAME.test(file.name);
    const job: Job = { id: newId(), file, state: "queued", pct: 0, message: "Waiting" };
    if (!looksLikeImage) {
      job.state = "error";
      job.message = "This file is not an image. Please choose a JPG, PNG or WebP photo of the receipt.";
    } else if (file.size > MAX_FILE_BYTES) {
      job.state = "error";
      job.message = "This image is larger than 25 MB. Please use a smaller photo.";
    } else if (file.size === 0) {
      job.state = "error";
      job.message = "This file is empty.";
    }
    jobs.push(job);
  }
  renderJobs();
  void drain();
}

function friendlyStatus(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("core") || s.includes("initializ")) return "Loading text reader";
  if (s.includes("language") || s.includes("traineddata")) return "Loading language data";
  if (s.includes("recogniz")) return "Reading text";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const job = jobs.find((j) => j.state === "queued");
      if (!job) break;
      await processJob(job);
    }
  } finally {
    draining = false;
  }
}

async function processJob(job: Job): Promise<void> {
  job.state = "working";
  job.message = "Starting";
  renderJobs();
  try {
    let text = "";
    let confidence = 100;
    let usedEnhanced = false;
    let note = "";

    if (enhancedOn && ENHANCED_URL) {
      try {
        job.message = "Reading with enhanced handwriting mode";
        job.pct = 10;
        renderJobs();
        text = await runEnhancedOcr(job.file);
        usedEnhanced = true;
      } catch (e) {
        note = `${errorMessage(e)} Used on-device reading instead.`;
      }
    }
    if (!usedEnhanced) {
      const res = await runOcr(job.file, (pct, status) => {
        job.pct = pct;
        job.message = friendlyStatus(status);
        renderJobs();
      });
      text = res.text;
      confidence = res.confidence;
    }

    if (text.replace(/\s/g, "").length < 6) {
      throw new UserError(
        "No text was found. Try a clearer photo: hold the phone straight above the receipt, use good light, and fill the frame.",
      );
    }

    const parsed = parseReceiptText(text);
    if (!usedEnhanced && confidence < 55) {
      parsed.warnings.unshift("This photo was hard to read, so please check every row carefully.");
    }
    if (note) parsed.warnings.unshift(note);

    const receipt: Receipt = { ...parsed, id: newId(), fileName: job.file.name || "receipt", rawText: text };
    receipts.push(receipt);
    thumbs.set(receipt.id, URL.createObjectURL(job.file));
    job.state = "done";
    job.pct = 100;
    job.message =
      parsed.items.length > 0
        ? `Found ${parsed.items.length} item${parsed.items.length === 1 ? "" : "s"}. Please check them below.`
        : "No items were recognised. You can add rows by hand below.";
    renderReceipts();
  } catch (e) {
    job.state = "error";
    job.message = errorMessage(e);
  }
  renderJobs();
}

function renderJobs(): void {
  const ul = $("jobs");
  ul.innerHTML = jobs
    .map((j) => {
      const label = { queued: "Waiting", working: j.pct ? `${j.pct}%` : "Working", done: "Done", error: "Problem" }[j.state];
      const bar = j.state === "working" ? `<div class="bar"><i style="width:${j.pct}%"></i></div>` : "";
      return `<li class="job ${j.state}">
        <div class="job-top"><span class="job-name">${esc(j.file.name || "receipt")}</span><span class="job-state">${label}</span></div>
        <div class="job-msg">${esc(j.message)}</div>${bar}</li>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* Receipt cards                                                       */
/* ------------------------------------------------------------------ */

function rowHtml(it: ReceiptItem): string {
  const low = it.confidence < 0.7;
  return `<div class="row${low ? " low" : ""}" data-iid="${it.id}"${low ? ' title="Low confidence. Please check this row."' : ""}>
    <input class="c-name" data-f="name" value="${esc(it.name)}" placeholder="Item name" aria-label="Item name" autocomplete="off" />
    <label class="cell"><span class="cell-label">Qty</span><input class="num" data-f="qty" value="${numStr(it.qty)}" placeholder="Qty" inputmode="decimal" aria-label="Quantity" autocomplete="off" /></label>
    <label class="cell"><span class="cell-label">Rate (₹)</span><input class="num" data-f="rate" value="${numStr(it.rate)}" placeholder="Rate" inputmode="decimal" aria-label="Rate" autocomplete="off" /></label>
    <label class="cell"><span class="cell-label">Amount (₹)</span><input class="num" data-f="amount" value="${numStr(it.amount)}" placeholder="Amount" inputmode="decimal" aria-label="Amount" autocomplete="off" /></label>
    <button class="icon-btn" type="button" data-act="del-row" aria-label="Delete this row">✕</button>
  </div>`;
}

function taxField(r: Receipt, key: "subtotal" | "cgst" | "sgst" | "igst" | "gst" | "total", label: string): string {
  return `<div class="field"><label>${label}</label>
    <input data-rf="${key}" value="${numStr(r[key])}" inputmode="decimal" placeholder="0.00" autocomplete="off" /></div>`;
}

function receiptHtml(r: Receipt): string {
  const thumb = thumbs.get(r.id);
  return `<section class="card receipt" data-rid="${r.id}" aria-label="Receipt ${esc(r.fileName)}">
    <div class="receipt-head">
      <div class="thumb">${thumb ? `<a href="${thumb}" target="_blank" rel="noopener" title="Open photo"><img src="${thumb}" alt="Photo of the receipt" /></a>` : ""}</div>
      <div class="head-fields">
        <div class="field"><label>Vendor</label><input data-rf="vendor" value="${esc(r.vendor)}" autocomplete="off" /></div>
        <div class="field"><label>Date</label><input type="date" data-rf="date" value="${esc(r.date)}" /></div>
        <div class="field"><label>GSTIN</label><input data-rf="gstin" value="${esc(r.gstin)}" maxlength="15" autocapitalize="characters" autocomplete="off" /></div>
      </div>
      <button class="icon-btn" type="button" data-act="del-receipt" aria-label="Remove this receipt">✕</button>
    </div>
    ${r.warnings.length ? `<ul class="warnings">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <div class="items">
      <div class="row head" aria-hidden="true"><span>Item</span><span>Qty</span><span>Rate (₹)</span><span>Amount (₹)</span><span></span></div>
      <div data-rows>${r.items.map(rowHtml).join("")}</div>
    </div>
    <button class="btn small add" type="button" data-act="add-row">+ Add row</button>
    <div class="tax">
      ${taxField(r, "subtotal", "Subtotal (₹)")}${taxField(r, "cgst", "CGST (₹)")}${taxField(r, "sgst", "SGST (₹)")}
      ${taxField(r, "igst", "IGST (₹)")}${taxField(r, "gst", "Other GST (₹)")}${taxField(r, "total", "Printed total (₹)")}
    </div>
    <div class="check" data-check></div>
    <details><summary>Show the text read from the photo</summary><pre>${esc(r.rawText)}</pre></details>
  </section>`;
}

function renderReceipts(): void {
  $("receipts").innerHTML = receipts.map(receiptHtml).join("");
  receipts.forEach((r) => updateCheck(r));
  $("results").hidden = receipts.length === 0;
  updateDownloadBar();
}

function cardFor(r: Receipt): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-rid="${r.id}"]`);
}

function updateCheck(r: Receipt): void {
  const box = cardFor(r)?.querySelector<HTMLElement>("[data-check]");
  if (!box) return;
  const c = checkTotals(r);
  box.classList.remove("ok", "bad");
  if (c.ok === null) {
    box.textContent = `Items add up to ${fmtInr(c.itemsSum)}. Enter the printed total to check it.`;
  } else if (c.ok) {
    box.classList.add("ok");
    box.textContent = `✓ Items add up to ${fmtInr(c.itemsSum)}${c.gstTotal > 0 && Math.abs((r.total ?? 0) - c.itemsSum) > 1.01 ? ` (plus GST ${fmtInr(c.gstTotal)})` : ""} and match the printed total.`;
  } else {
    box.classList.add("bad");
    box.textContent = `Items add up to ${fmtInr(c.itemsSum)} but the printed total is ${fmtInr(r.total ?? 0)} (difference ${fmtInr(Math.abs(c.diff ?? 0))}). Check quantities, rates and amounts.`;
  }
  updateDownloadBar();
}

function updateDownloadBar(): void {
  const bar = $("dlbar");
  bar.hidden = receipts.length === 0;
  const items = receipts.reduce((n, r) => n + r.items.length, 0);
  $("dl-info").textContent = `${receipts.length} receipt${receipts.length === 1 ? "" : "s"}, ${items} item${items === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

type NumRead = { ok: true; value: number | null } | { ok: false };

function readNum(el: HTMLInputElement): NumRead {
  const v = el.value.trim();
  if (v === "") {
    el.classList.remove("invalid");
    el.removeAttribute("aria-invalid");
    return { ok: true, value: null };
  }
  const n = parseAmount(v);
  const bad = n === null;
  el.classList.toggle("invalid", bad);
  if (bad) el.setAttribute("aria-invalid", "true");
  else el.removeAttribute("aria-invalid");
  return bad ? { ok: false } : { ok: true, value: n };
}

function findReceipt(el: Element): Receipt | undefined {
  const id = el.closest<HTMLElement>("[data-rid]")?.dataset.rid;
  return receipts.find((r) => r.id === id);
}

function onInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  if (!(el instanceof HTMLInputElement)) return;
  const r = findReceipt(el);
  if (!r) return;

  const rf = el.dataset.rf;
  if (rf) {
    if (rf === "vendor") r.vendor = el.value;
    else if (rf === "date") r.date = el.value;
    else if (rf === "gstin") r.gstin = el.value.toUpperCase().replace(/\s/g, "");
    else {
      const res = readNum(el);
      if (res.ok) (r as unknown as Record<string, number | null>)[rf] = res.value;
    }
    updateCheck(r);
    return;
  }

  const rowEl = el.closest<HTMLElement>("[data-iid]");
  const f = el.dataset.f;
  if (!rowEl || !f) return;
  const it = r.items.find((x) => x.id === rowEl.dataset.iid);
  if (!it) return;

  if (f === "name") {
    it.name = el.value;
  } else if (f === "qty" || f === "rate" || f === "amount") {
    const res = readNum(el);
    if (!res.ok) return;
    it[f] = res.value;
    if ((f === "qty" || f === "rate") && it.qty !== null && it.rate !== null) {
      it.amount = round2(it.qty * it.rate);
      const amt = rowEl.querySelector<HTMLInputElement>('[data-f="amount"]');
      if (amt) {
        amt.value = numStr(it.amount);
        amt.classList.remove("invalid");
      }
    }
  }
  it.confidence = 1; // the person has looked at this row
  rowEl.classList.remove("low");
  rowEl.removeAttribute("title");
  updateCheck(r);
}

function onClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!btn) return;
  const r = findReceipt(btn);
  if (!r) return;

  switch (btn.dataset.act) {
    case "del-row": {
      const id = btn.closest<HTMLElement>("[data-iid]")?.dataset.iid;
      r.items = r.items.filter((x) => x.id !== id);
      btn.closest("[data-iid]")?.remove();
      updateCheck(r);
      break;
    }
    case "add-row": {
      const it: ReceiptItem = { id: newId(), name: "", qty: 1, rate: null, amount: null, confidence: 1 };
      r.items.push(it);
      const holder = cardFor(r)?.querySelector("[data-rows]");
      if (holder) {
        holder.insertAdjacentHTML("beforeend", rowHtml(it));
        holder.querySelector<HTMLInputElement>(`[data-iid="${it.id}"] [data-f="name"]`)?.focus();
      }
      updateCheck(r);
      break;
    }
    case "del-receipt": {
      const url = thumbs.get(r.id);
      if (url) URL.revokeObjectURL(url);
      thumbs.delete(r.id);
      receipts.splice(receipts.indexOf(r), 1);
      renderReceipts();
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Download, clear, share                                              */
/* ------------------------------------------------------------------ */

async function onDownload(): Promise<void> {
  if (receipts.length === 0) {
    toast("Add a receipt first.");
    return;
  }
  const bad = document.querySelector<HTMLElement>("#receipts input.invalid");
  if (bad) {
    bad.scrollIntoView({ block: "center", behavior: "smooth" });
    bad.focus();
    toast("Some numbers are not valid. Please fix the red cells first.");
    return;
  }
  const btn = $<HTMLButtonElement>("download");
  btn.disabled = true;
  try {
    const blob = await workbookToBlob(receipts);
    downloadBlob(blob, suggestedFileName(receipts));
    toast("Excel file downloaded.");
  } catch (e) {
    toast(`Could not create the Excel file (${e instanceof Error ? e.message : "unknown error"}).`);
  } finally {
    btn.disabled = false;
  }
}

function onClear(): void {
  if (receipts.length > 0 && !window.confirm("Remove all receipts from this page? Your downloaded files are not affected.")) return;
  thumbs.forEach((u) => URL.revokeObjectURL(u));
  thumbs.clear();
  receipts.length = 0;
  jobs.length = 0;
  renderJobs();
  renderReceipts();
}

async function onShare(): Promise<void> {
  const url = window.location.href.split("#")[0];
  const data = { title: "KY – Receipt to Excel", text: "Turn paper receipts into Excel. Free and private, it runs in your browser.", url };
  if (typeof navigator.share === "function") {
    try {
      await navigator.share(data);
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. Paste it anywhere to share KY.");
  } catch {
    window.prompt("Copy this link to share KY:", url);
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function setupEnhanced(): void {
  if (!ENHANCED_URL) return;
  $("enhanced-wrap").hidden = false;
  $("consent-host").textContent = enhancedHost();
  const box = $<HTMLInputElement>("enhanced");
  const dialog = $<HTMLDialogElement>("consent");
  box.addEventListener("change", () => {
    if (!box.checked) {
      enhancedOn = false;
      return;
    }
    if (sessionStorageGet("ky-enhanced-ok") === "1") {
      enhancedOn = true;
      return;
    }
    box.checked = false;
    dialog.showModal();
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "agree") {
      sessionStorageSet("ky-enhanced-ok", "1");
      enhancedOn = true;
      box.checked = true;
    }
  });
}

function sessionStorageGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function sessionStorageSet(k: string, v: string): void {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

function init(): void {
  const camera = $<HTMLInputElement>("in-camera");
  const files = $<HTMLInputElement>("in-files");
  $("btn-camera").addEventListener("click", () => camera.click());
  $("btn-files").addEventListener("click", () => files.click());
  for (const input of [camera, files]) {
    input.addEventListener("change", () => {
      if (input.files) addFiles(input.files);
      input.value = ""; // allow choosing the same file again
    });
  }

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    }),
  );
  drop.addEventListener("drop", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files) addFiles(dt.files);
  });
  // Pasting an image (Ctrl+V) also works on desktop.
  window.addEventListener("paste", (e) => {
    const fl = e.clipboardData?.files;
    if (fl && fl.length) addFiles(fl);
  });
  // Stop the browser from navigating away when a file is dropped outside the drop area.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  const list = $("receipts");
  list.addEventListener("input", onInput);
  list.addEventListener("click", onClick);

  $("download").addEventListener("click", () => void onDownload());
  $("clear").addEventListener("click", onClear);
  $("share").addEventListener("click", () => void onShare());
  setupEnhanced();
  renderReceipts();
}

init();
