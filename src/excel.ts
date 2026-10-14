import ExcelJS from "exceljs";
import type { Receipt } from "./types";
import { checkTotals, gstTotal } from "./parser";

const INR = '"₹"#,##0.00;[Red]-"₹"#,##0.00';
const ACCENT = "FF0F766E";

function isoToDate(iso: string): Date | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.alignment = { vertical: "middle" };
  row.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
  });
}

export async function buildWorkbook(receipts: Receipt[]): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KY";
  wb.created = new Date();

  /* ---------------- Items sheet ---------------- */
  const items = wb.addWorksheet("Items", { views: [{ state: "frozen", ySplit: 1 }] });
  items.columns = [
    { header: "Receipt", key: "receipt", width: 9 },
    { header: "Date", key: "date", width: 13 },
    { header: "Vendor", key: "vendor", width: 26 },
    { header: "Item", key: "item", width: 36 },
    { header: "Qty", key: "qty", width: 9 },
    { header: "Rate (₹)", key: "rate", width: 13 },
    { header: "Amount (₹)", key: "amount", width: 15 },
  ];
  styleHeader(items.getRow(1));

  let firstDataRow = 2;
  receipts.forEach((r, ri) => {
    const date = isoToDate(r.date);
    for (const it of r.items) {
      const row = items.addRow({
        receipt: ri + 1,
        date: date ?? (r.date || null),
        vendor: r.vendor || null,
        item: it.name,
        qty: it.qty,
        rate: it.rate,
        amount: it.amount,
      });
      row.getCell("date").numFmt = "dd-mmm-yyyy";
      row.getCell("qty").numFmt = "#,##0.###";
      row.getCell("rate").numFmt = INR;
      row.getCell("amount").numFmt = INR;
    }
  });
  const lastDataRow = items.rowCount;
  if (lastDataRow >= firstDataRow) {
    const totalRow = items.addRow({ item: "Total of all items", amount: { formula: `SUM(G${firstDataRow}:G${lastDataRow})` } });
    totalRow.font = { bold: true };
    totalRow.getCell("amount").numFmt = INR;
    totalRow.eachCell((c) => {
      c.border = { top: { style: "thin" } };
    });
    items.autoFilter = { from: "A1", to: `G${lastDataRow}` };
  }
  firstDataRow = 2;

  /* ---------------- Summary sheet ---------------- */
  const sum = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  sum.columns = [
    { header: "Receipt", key: "receipt", width: 9 },
    { header: "File", key: "file", width: 26 },
    { header: "Date", key: "date", width: 13 },
    { header: "Vendor", key: "vendor", width: 26 },
    { header: "GSTIN", key: "gstin", width: 19 },
    { header: "Items total (₹)", key: "items", width: 16 },
    { header: "CGST (₹)", key: "cgst", width: 13 },
    { header: "SGST (₹)", key: "sgst", width: 13 },
    { header: "IGST (₹)", key: "igst", width: 13 },
    { header: "Total GST (₹)", key: "gst", width: 15 },
    { header: "Printed total (₹)", key: "total", width: 17 },
    { header: "Check", key: "check", width: 26 },
  ];
  styleHeader(sum.getRow(1));

  receipts.forEach((r, ri) => {
    const date = isoToDate(r.date);
    const chk = checkTotals(r);
    const rowNo = sum.rowCount + 1;
    // SUMIF over the Items sheet keeps the items total live if the user edits the Items sheet.
    const row = sum.addRow({
      receipt: ri + 1,
      file: r.fileName,
      date: date ?? (r.date || null),
      vendor: r.vendor || null,
      gstin: r.gstin || null,
      items: { formula: `SUMIF(Items!A:A,A${rowNo},Items!G:G)`, result: chk.itemsSum },
      cgst: r.cgst,
      sgst: r.sgst,
      igst: r.igst,
      gst: { formula: `IF(SUM(G${rowNo}:I${rowNo})>0,SUM(G${rowNo}:I${rowNo}),${r.gst ?? 0})`, result: gstTotal(r) },
      total: r.total,
      check:
        r.total === null
          ? "No printed total"
          : { formula: `IF(ABS(K${rowNo}-F${rowNo})<=1,"Matches items",IF(ABS(K${rowNo}-F${rowNo}-J${rowNo})<=1,"Matches items + GST","Check: differs by "&TEXT(K${rowNo}-F${rowNo},"0.00")))` },
    });
    row.getCell("date").numFmt = "dd-mmm-yyyy";
    for (const k of ["items", "cgst", "sgst", "igst", "gst", "total"]) row.getCell(k).numFmt = INR;
  });

  const n = sum.rowCount;
  if (n >= 2) {
    const t = sum.addRow({
      vendor: "All receipts",
      items: { formula: `SUM(F2:F${n})` },
      cgst: { formula: `SUM(G2:G${n})` },
      sgst: { formula: `SUM(H2:H${n})` },
      igst: { formula: `SUM(I2:I${n})` },
      gst: { formula: `SUM(J2:J${n})` },
      total: { formula: `SUM(K2:K${n})` },
    });
    t.font = { bold: true };
    for (const k of ["items", "cgst", "sgst", "igst", "gst", "total"]) t.getCell(k).numFmt = INR;
    t.eachCell((c) => {
      c.border = { top: { style: "thin" } };
    });
  }

  return wb;
}

export async function workbookToBlob(receipts: Receipt[]): Promise<Blob> {
  const wb = await buildWorkbook(receipts);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function suggestedFileName(receipts: Receipt[]): string {
  const dated = receipts.map((r) => r.date).filter(Boolean).sort();
  const stamp = dated[0] || new Date().toISOString().slice(0, 10);
  return `KY-receipts-${stamp}.xlsx`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
