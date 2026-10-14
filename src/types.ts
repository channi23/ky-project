export interface ReceiptItem {
  id: string;
  name: string;
  qty: number | null;
  rate: number | null;
  amount: number | null;
  /** 0 to 1. Low values are highlighted in the table so the user checks them. */
  confidence: number;
}

export interface ParsedReceipt {
  vendor: string;
  /** ISO date (YYYY-MM-DD) or empty string when not found. */
  date: string;
  gstin: string;
  items: ReceiptItem[];
  subtotal: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  /** GST printed as a single figure (no CGST/SGST split). */
  gst: number | null;
  total: number | null;
  warnings: string[];
}

export interface Receipt extends ParsedReceipt {
  id: string;
  fileName: string;
  rawText: string;
}

export interface TotalsCheck {
  itemsSum: number;
  gstTotal: number;
  /** null when there is no printed total to compare with. */
  ok: boolean | null;
  /** printed total minus the closest computed value. */
  diff: number | null;
}
