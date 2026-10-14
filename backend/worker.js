/**
 * KY enhanced handwriting backend (OPTIONAL).
 *
 * A stateless Cloudflare Worker. It receives one receipt photo, asks a vision model to
 * transcribe it, and returns the text. It has no database, no KV, no R2 and no logging
 * of request bodies. The image only exists in memory while the request is handled.
 *
 * Secrets / variables (set with wrangler, see README):
 *   ANTHROPIC_API_KEY  secret   your Anthropic API key
 *   ALLOWED_ORIGIN     var      exact origin of your site, e.g. https://yourname.github.io
 *   MODEL              var      optional, defaults to claude-haiku-5-5
 */

const MAX_IMAGE_BASE64_CHARS = 6_000_000; // about 4.5 MB of image data
const DEFAULT_MODEL = "claude-haiku-5-5";

const PROMPT = `You are an OCR engine for Indian paper receipts, bills and handwritten kirana notes.
Transcribe ALL text in the image exactly as written, one receipt line per output line, keeping the left-to-right order of each line (item name, quantity, rate, amount).
Rules:
- Copy numbers exactly as written. Do not calculate, correct or guess missing values.
- Keep currency marks, dates, GSTIN, CGST/SGST/IGST and total lines.
- Text may be English, Hindi, Telugu, Tamil or another Indian language, printed or handwritten. Transcribe it as written.
- If a word is unreadable write [?] in its place.
- Output only the transcription. No commentary, no markdown.`;

function corsHeaders(origin, allowed) {
  const ok = allowed && origin === allowed;
  return {
    "Access-Control-Allow-Origin": ok ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);
    if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return json({ error: "Origin not allowed." }, 403, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Service is not configured." }, 500, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400, cors);
    }
    const image = typeof body.image === "string" ? body.image : "";
    const mime = body.mime === "image/png" || body.mime === "image/webp" ? body.mime : "image/jpeg";
    if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: "Missing or invalid image." }, 400, cors);
    if (image.length > MAX_IMAGE_BASE64_CHARS) return json({ error: "Image is too large." }, 413, cors);

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: env.MODEL || DEFAULT_MODEL,
          max_tokens: 2000,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mime, data: image } },
                { type: "text", text: PROMPT },
              ],
            },
          ],
        }),
      });
    } catch {
      return json({ error: "Could not reach the reading model." }, 502, cors);
    }

    if (!upstream.ok) {
      // Do not forward upstream details; they may contain request data.
      return json({ error: `Reading model error (${upstream.status}).` }, 502, cors);
    }
    const data = await upstream.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return json({ text }, 200, cors);
  },
};
