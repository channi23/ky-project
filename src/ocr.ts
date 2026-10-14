import { createWorker, type Worker } from "tesseract.js";
import { preprocessImage } from "./preprocess";

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0 to 100. */
  confidence: number;
}

let workerPromise: Promise<Worker> | null = null;
let currentProgress: ((pct: number, status: string) => void) | null = null;

/**
 * Tesseract.js runs the OCR engine in its own Web Worker, so the page stays responsive.
 * The engine and the English + Hindi language data are downloaded once from a public CDN
 * and cached by the browser. The receipt image itself is never uploaded.
 */
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(["eng", "hin"], 1, {
      logger: (m: { status: string; progress: number }) => {
        if (currentProgress) currentProgress(Math.round((m.progress || 0) * 100), m.status);
      },
    }).then(async (w) => {
      await w.setParameters({ preserve_interword_spaces: "1", user_defined_dpi: "300" });
      return w;
    });
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

export async function runOcr(file: Blob, onProgress: (pct: number, status: string) => void): Promise<OcrResult> {
  currentProgress = onProgress;
  try {
    onProgress(0, "Preparing image");
    const canvas = await preprocessImage(file);
    onProgress(0, "Loading text reader");
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    return { text: data.text || "", confidence: data.confidence || 0 };
  } finally {
    currentProgress = null;
  }
}

export async function disposeOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    if (w) await w.terminate();
  }
}
