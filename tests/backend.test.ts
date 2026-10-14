import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore - plain JS module without type declarations
import worker from "../backend/worker.js";

const ORIGIN = "https://example.github.io";
const env = { ALLOWED_ORIGIN: ORIGIN, ANTHROPIC_API_KEY: "sk-test-secret" };

function post(body: unknown, origin = ORIGIN): Request {
  return new Request("https://ky-ocr.example.workers.dev/", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("enhanced OCR backend", () => {
  it("answers CORS preflight only for the allowed origin", async () => {
    const ok = await worker.fetch(new Request("https://x/", { method: "OPTIONS", headers: { Origin: ORIGIN } }), env);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const other = await worker.fetch(new Request("https://x/", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBe("null");
  });

  it("rejects other origins and non-POST methods", async () => {
    expect((await worker.fetch(post({ image: "QUJD" }, "https://evil.example"), env)).status).toBe(403);
    expect((await worker.fetch(new Request("https://x/", { method: "GET", headers: { Origin: ORIGIN } }), env)).status).toBe(405);
  });

  it("rejects missing, invalid and oversized images", async () => {
    expect((await worker.fetch(post({}), env)).status).toBe(400);
    expect((await worker.fetch(post({ image: "not base64!!" }), env)).status).toBe(400);
    expect((await worker.fetch(post({ image: "A".repeat(6_000_001) }), env)).status).toBe(413);
  });

  it("forwards the image to the model and returns only the text", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "Rice 2 50 100\nTotal 100" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(post({ image: "QUJDRA==", mime: "image/jpeg" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ text: "Rice 2 50 100\nTotal 100" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test-secret");
    const sent = JSON.parse(init.body as string);
    expect(sent.messages[0].content[0].source.data).toBe("QUJDRA==");
  });

  it("does not leak upstream details or the API key on errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret upstream body sk-test-secret", { status: 500 })));
    const res = await worker.fetch(post({ image: "QUJD" }), env);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("sk-test-secret");
    expect(text).not.toContain("upstream body");
  });

  it("reports a missing key as a server configuration error", async () => {
    const res = await worker.fetch(post({ image: "QUJD" }), { ALLOWED_ORIGIN: ORIGIN });
    expect(res.status).toBe(500);
  });
});
