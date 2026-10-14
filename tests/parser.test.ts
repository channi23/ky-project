import { describe, expect, it } from "vitest";
import { checkTotals, parseAmount, parseDate, parseItemLine, parseReceiptText } from "../src/parser";

const KIRANA_GST_BILL = `
SRI LAKSHMI GENERAL STORES
Shop No 12, Main Road, Bahadurpura
Hyderabad - 500064
GSTIN: 36ABCDE1234F1Z5
Ph: 9876543210
Bill No: 1042   Date: 12/10/2026
Item      Qty   Rate   Amount
Basmati Rice 5kg  2  420.00  840.00
Toor Dal 1 kg  1  165.00  165.00
Amul Butter 500g  2  275.00  550.00
Sugar 3 45.00 135.00
Sub Total 1690.00
CGST @2.5% 42.25
SGST @2.5% 42.25
Total 1774.50
Cash 2000.00
Change 225.50
`;

const RESTAURANT_BILL = `
HOTEL SAGAR RESTAURANT
Tax Invoice
GSTIN : 29AAPCS9876K1ZP
Date: 03-Oct-2026   Time: 20:15
Table 7
1. Masala Dosa 2 x 60 120.00
2. Veg Biryani 1 x 180 180.00
3. Filter Coffee 3 x 25 75.00
4. Gulab Jamun 2 x 40 80.00
Sub Total 455.00
CGST 2.5% 11.38
SGST 2.5% 11.37
Round off 0.25
Grand Total 478.00
`;

const HANDWRITTEN_NOISY = `
Sri Ganesh Kirana
Date 1O/1O/2O26
Rice 5 kg   35O
Dal 2kg  2l0
Oil 1 ltr  1BO
Sugar  1kg 45
Salt           2O
Total  8O5
`;

const IGST_HSN_BILL = `
AGARWAL ELECTRICALS
GSTIN: 07AAACA1234B1ZQ
Invoice No: INV/22/118
Date: 5th Sept 2026
S.No Description HSN Qty Rate Amount
1 LED Bulb 9W 85395 10 95.00 950.00
2 Ceiling Fan 8414 1 2,450.00 2,450.00
3 Switch Board 8536 4 180.00 720.00
Taxable Value 4,120.00
IGST @18% 741.60
Total Amount 4,861.60
`;

const HANDWRITTEN_RS = `
Ramu Fruits & Veg
12.10.26
Tomato  2 kg   Rs.60/-
Onion 3kg  90/-
Banana 1 dz  48,00
Total Rs 198/-
`;

const DISCOUNT_BILL = `
Corner Mart
Maggi Noodles 4 14.00 56.00
Milk 500ml 2 27.00 54.00
Discount 10.00
Total 100.00
`;

describe("parseAmount", () => {
  it("handles Indian digit grouping", () => {
    expect(parseAmount("1,23,456.00")).toBe(123456);
    expect(parseAmount("2,450.00")).toBe(2450);
  });
  it("handles currency markers and /-", () => {
    expect(parseAmount("Rs.1,250/-")).toBe(1250);
    expect(parseAmount("₹99")).toBe(99);
  });
  it("treats a comma followed by two digits as a decimal", () => {
    expect(parseAmount("120,50")).toBe(120.5);
  });
  it("fixes common OCR digit mistakes", () => {
    expect(parseAmount("1O0.OO")).toBe(100);
    expect(parseAmount("2l0")).toBe(210);
  });
  it("reads negatives and rejects words", () => {
    expect(parseAmount("(-)0.20")).toBe(-0.2);
    expect(parseAmount("abc")).toBeNull();
  });
});

describe("parseDate", () => {
  it("reads DD/MM/YYYY, DD-MM-YY and DD.MM.YY", () => {
    expect(parseDate("Date: 12/10/2026")).toBe("2026-10-12");
    expect(parseDate("5-10-26")).toBe("2026-10-05");
    expect(parseDate("12.10.26")).toBe("2026-10-12");
  });
  it("reads dates with month names", () => {
    expect(parseDate("12 Oct 2026")).toBe("2026-10-12");
    expect(parseDate("Oct 12, 2026")).toBe("2026-10-12");
    expect(parseDate("5th Sept 2026")).toBe("2026-09-05");
  });
  it("fixes letter O inside a date", () => {
    expect(parseDate("1O/1O/2O26")).toBe("2026-10-10");
  });
  it("rejects impossible dates", () => {
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("no date here")).toBeNull();
  });
});

describe("parseItemLine", () => {
  it("reads qty, rate and amount", () => {
    const it = parseItemLine("Sugar 3 45.00 135.00");
    expect(it).toMatchObject({ name: "Sugar", qty: 3, rate: 45, amount: 135 });
    expect(it!.confidence).toBeGreaterThan(0.9);
  });
  it("keeps pack size in the name", () => {
    expect(parseItemLine("Amul Butter 500g 2 275.00 550.00")).toMatchObject({
      name: "Amul Butter 500g", qty: 2, rate: 275, amount: 550,
    });
  });
  it("drops the HSN column", () => {
    expect(parseItemLine("LED Bulb 9W 85395 10 95.00 950.00")).toMatchObject({ qty: 10, rate: 95, amount: 950 });
  });
  it("handles a percent column", () => {
    expect(parseItemLine("Soap 3 25.00 5% 75.00")).toMatchObject({ qty: 3, rate: 25, amount: 75 });
  });
  it("handles a name with an amount only", () => {
    expect(parseItemLine("Salt 20")).toMatchObject({ name: "Salt", qty: 1, amount: 20 });
  });
  it("ignores pin codes, phone numbers and text-only lines", () => {
    expect(parseItemLine("Hyderabad - 500064")).toBeNull();
    expect(parseItemLine("Main Road Bahadurpura")).toBeNull();
    expect(parseItemLine("Cash 2000.00")).toBeNull();
  });
});

describe("parseReceiptText: printed GST kirana bill", () => {
  const r = parseReceiptText(KIRANA_GST_BILL);
  it("reads header fields", () => {
    expect(r.vendor).toBe("SRI LAKSHMI GENERAL STORES");
    expect(r.date).toBe("2026-10-12");
    expect(r.gstin).toBe("36ABCDE1234F1Z5");
  });
  it("reads all four items and nothing else", () => {
    expect(r.items.map((i) => i.name)).toEqual(["Basmati Rice 5kg", "Toor Dal 1 kg", "Amul Butter 500g", "Sugar"]);
    expect(r.items.map((i) => i.amount)).toEqual([840, 165, 550, 135]);
    expect(r.items.map((i) => i.qty)).toEqual([2, 1, 2, 3]);
  });
  it("reads totals and GST", () => {
    expect(r.subtotal).toBe(1690);
    expect(r.cgst).toBe(42.25);
    expect(r.sgst).toBe(42.25);
    expect(r.total).toBe(1774.5);
    expect(r.warnings).toEqual([]);
  });
  it("passes the totals check", () => {
    expect(checkTotals(r).ok).toBe(true);
  });
});

describe("parseReceiptText: restaurant bill", () => {
  const r = parseReceiptText(RESTAURANT_BILL);
  it("reads date with month name and ignores time and table", () => {
    expect(r.date).toBe("2026-10-03");
    expect(r.gstin).toBe("29AAPCS9876K1ZP");
    expect(r.vendor).toBe("HOTEL SAGAR RESTAURANT");
  });
  it("reads numbered items with 'qty x rate' format", () => {
    expect(r.items.map((i) => [i.name, i.qty, i.rate, i.amount])).toEqual([
      ["Masala Dosa", 2, 60, 120],
      ["Veg Biryani", 1, 180, 180],
      ["Filter Coffee", 3, 25, 75],
      ["Gulab Jamun", 2, 40, 80],
    ]);
  });
  it("reads grand total and GST split", () => {
    expect(r.total).toBe(478);
    expect(r.cgst).toBe(11.38);
    expect(r.sgst).toBe(11.37);
    expect(checkTotals(r).ok).toBe(true);
  });
});

describe("parseReceiptText: noisy handwritten-style OCR", () => {
  const r = parseReceiptText(HANDWRITTEN_NOISY);
  it("repairs O/l/B digits", () => {
    expect(r.date).toBe("2026-10-10");
    expect(r.items.map((i) => [i.name, i.amount])).toEqual([
      ["Rice", 350], ["Dal", 210], ["Oil", 180], ["Sugar", 45], ["Salt", 20],
    ]);
    expect(r.total).toBe(805);
  });
  it("derives qty from units", () => {
    expect(r.items[0]).toMatchObject({ qty: 5, rate: 70 });
    expect(r.items[1]).toMatchObject({ qty: 2, rate: 105 });
  });
  it("passes the totals check", () => {
    expect(checkTotals(r).ok).toBe(true);
  });
});

describe("parseReceiptText: IGST bill with HSN and Indian commas", () => {
  const r = parseReceiptText(IGST_HSN_BILL);
  it("reads items without HSN codes", () => {
    expect(r.date).toBe("2026-09-05");
    expect(r.items.map((i) => [i.name, i.qty, i.rate, i.amount])).toEqual([
      ["LED Bulb 9W", 10, 95, 950],
      ["Ceiling Fan", 1, 2450, 2450],
      ["Switch Board", 4, 180, 720],
    ]);
  });
  it("reads IGST, taxable value and total", () => {
    expect(r.subtotal).toBe(4120);
    expect(r.igst).toBe(741.6);
    expect(r.total).toBe(4861.6);
    expect(checkTotals(r).ok).toBe(true);
  });
});

describe("parseReceiptText: handwritten with Rs and /-", () => {
  const r = parseReceiptText(HANDWRITTEN_RS);
  it("reads amounts written as Rs.60/-", () => {
    expect(r.date).toBe("2026-10-12");
    expect(r.items.map((i) => [i.name, i.qty, i.amount])).toEqual([
      ["Tomato", 2, 60], ["Onion", 3, 90], ["Banana", 1, 48],
    ]);
    expect(r.total).toBe(198);
  });
});

describe("parseReceiptText: discount line", () => {
  it("keeps the discount as a negative row so totals still match", () => {
    const r = parseReceiptText(DISCOUNT_BILL);
    expect(r.items.map((i) => i.amount)).toEqual([56, 54, -10]);
    expect(checkTotals(r).ok).toBe(true);
  });
});

describe("edge cases", () => {
  it("returns warnings for empty or unreadable text", () => {
    const r = parseReceiptText("   \n  ~~ ..  \n");
    expect(r.items).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("flags a totals mismatch", () => {
    const r = parseReceiptText("Shop\nTea 2 20.00 40.00\nTotal 90.00");
    expect(checkTotals(r).ok).toBe(false);
    expect(checkTotals(r).diff).toBe(50);
  });
  it("warns when a GSTIN is printed but misread", () => {
    const r = parseReceiptText("Shop\nGSTIN: 36ABCDE1234F175\nDate: 12/10/2026\nTea 2 10.00 20.00\nTotal 20");
    expect(r.gstin).toBe("");
    expect(r.warnings.some((w) => w.includes("GSTIN"))).toBe(true);
  });
  it("returns ok null when there is no printed total", () => {
    const r = parseReceiptText("Shop\nTea 2 20.00 40.00");
    expect(checkTotals(r).ok).toBeNull();
  });
});
