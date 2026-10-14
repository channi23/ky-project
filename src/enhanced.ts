import { UserError } from "./errors";
import { toJpegBase64 } from "./preprocess";

/**
 * Optional "Enhanced handwriting mode". It is only available when the site was built with
 * VITE_ENHANCED_OCR_URL pointing at the small backend in /backend. Without it, KY works
 * fully in the browser and nothing is ever uploaded.
 */
export const ENHANCED_URL: string = ((import.meta.env.VITE_ENHANCED_OCR_URL as string | undefined) ?? "").trim();

export function enhancedHost(): string {
  try {
    return new URL(ENHANCED_URL).host;
  } catch {
    return "";
  }
}

export async function runEnhancedOcr(file: Blob): Promise<string> {
  if (!ENHANCED_URL) throw new UserError("Enhanced handwriting mode is not set up on this site.");
  const image = await toJpegBase64(file);
  let res: Response;
  try {
    res = await fetch(ENHANCED_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image, mime: "image/jpeg" }),
    });
  } catch {
    throw new UserError("Could not reach the enhanced reading service.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* ignore */
    }
    throw new UserError(`The enhanced reading service returned an error${detail ? `: ${detail}` : ` (${res.status})`}.`);
  }
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}
