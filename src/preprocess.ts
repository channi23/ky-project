import { UserError } from "./errors";

const MAX_SIDE = 2200;
const MIN_SIDE = 1000;

const OPEN_ERROR =
  "This image could not be opened. Please use a JPG, PNG or WebP photo. On iPhone, set Camera > Formats to Most Compatible, or share the photo as JPEG.";

export async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  try {
    // imageOrientation applies the EXIF rotation that phones store with photos.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      throw new UserError(OPEN_ERROR);
    }
  }
}

/**
 * Prepares a photo for OCR: applies the phone's rotation, resizes very large or very small
 * images to a good working size, and converts to grayscale. All work happens in the browser
 * on a canvas.
 *
 * Tested on purpose NOT to binarize (hard black and white) or flatten lighting: on phone-style
 * photos, thresholding before Tesseract produced noisy blobs and badly wrong text, while plain
 * grayscale matched the best results. Tesseract does its own binarization internally.
 */
export async function preprocessImage(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await loadBitmap(file);
  const longest = Math.max(bmp.width, bmp.height);
  let scale = 1;
  if (longest > MAX_SIDE) scale = MAX_SIDE / longest;
  else if (longest < MIN_SIDE) scale = Math.min(2, MIN_SIDE / longest);

  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Your browser could not create a drawing surface.");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Re-encodes a file as a JPEG no larger than maxSide, for the optional enhanced mode. */
export async function toJpegBase64(file: Blob, maxSide = 1600, quality = 0.85): Promise<string> {
  const bmp = await loadBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not create a drawing surface.");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
