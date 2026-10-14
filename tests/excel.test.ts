import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildWorkbook, suggestedFileName } from "../src/excel";
import { parseReceiptText } from "../src/parser";
import type { Receipt } from "../src/types";

const TEXT = `
SRI LAKSHMI GENERAL STORES
GSTIN: 36ABCDE1234F1Z5
Date: 12/10/2026
Basmati Rice 5kg  2  420.00  840.00
Sugar 3 45.00 135.00
Sub Total 975.00
CGST @2.5% 24.38
SGST @2.5% 24.37
Total 1023.75
`;

function make(text: string, name: string): Receipt {
  return { ...parseReceiptText(text), id: name, fileName: name, rawText: text };
}

async function roundTrip(receipts: Receipt[]): Promise<ExcelJS.Workbook> {
  const wb = await buildWorkbook(receipts);
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as ArrayBuffer);
  return back;
}

describe("Excel export", () => {
  it("writes an Items sheet with real dates, numbers and formats", async () => {
    const wb = await roundTrip([make(TEXT, "a.jpg")]);
    const ws = wb.getWorksheet("Items")!;
    expect(ws.getRow(1).values).toEqual([undefined, "Receipt", "Date", "Vendor", "Item", "Qty", "Rate (₹)", "Amount (₹)"]);
    expect(ws.getRow(1).font?.bold).toBe(true);

    const row = ws.getRow(2);
    expect(row.getCell(2).value).toBeInstanceOf(Date);
    expect((row.getCell(2).value as Date).toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(row.getCell(2).numFmt).toBe("dd-mmm-yyyy");
    expect(row.getCell(4).value).toBe("Basmati Rice 5kg");
    expect(row.getCell(5).value).toBe(2);
    expect(row.getCell(6).value).toBe(420);
    expect(row.getCell(7).value).toBe(840);
    expect(row.getCell(7).numFmt).toContain("₹");
  });

  it("adds a live SUM formula for the items total", async () => {
    const wb = await roundTrip([make(TEXT, "a.jpg")]);
    const ws = wb.getWorksheet("Items")!;
    const last = ws.getRow(ws.rowCount);
    expect(last.getCell(4).value).toBe("Total of all items");
    expect((last.getCell(7).value as ExcelJS.CellFormulaValue).formula).toBe("SUM(G2:G3)");
  });

  it("writes a Summary sheet with GST and a check formula", async () => {
    const wb = await roundTrip([make(TEXT, "a.jpg")]);
    const ws = wb.getWorksheet("Summary")!;
    const row = ws.getRow(2);
    expect(row.getCell(5).value).toBe("36ABCDE1234F1Z5");
    expect(row.getCell(7).value).toBe(24.38);
    expect(row.getCell(8).value).toBe(24.37);
    expect(row.getCell(11).value).toBe(1023.75);
    expect(typeof (row.getCell(12).value as ExcelJS.CellFormulaValue).formula).toBe("string");
  });

  it("combines several receipts and numbers them", async () => {
    const wb = await roundTrip([make(TEXT, "a.jpg"), make("Tea Stall\nTea 2 10.00 20.00\nTotal 20", "b.jpg")]);
    const ws = wb.getWorksheet("Items")!;
    expect(ws.getRow(2).getCell(1).value).toBe(1);
    expect(ws.getRow(4).getCell(1).value).toBe(2);
    expect(wb.getWorksheet("Summary")!.rowCount).toBe(4); // header, 2 receipts, totals row
  });

  it("keeps edited values and handles empty receipts", async () => {
    const r = make(TEXT, "a.jpg");
    r.items[0].name = "Edited name";
    r.items[0].amount = 999;
    const empty = make("nothing here", "b.jpg");
    const wb = await roundTrip([r, empty]);
    const ws = wb.getWorksheet("Items")!;
    expect(ws.getRow(2).getCell(4).value).toBe("Edited name");
    expect(ws.getRow(2).getCell(7).value).toBe(999);
  });

  it("names the file from the receipt date", () => {
    expect(suggestedFileName([make(TEXT, "a.jpg")])).toBe("KY-receipts-2026-10-12.xlsx");
  });
});
