import { describe, expect, it } from "vitest";
import { geminiRenderer } from "../src/render/gemini.js";

describe("optional Gemini renderer (fake fetch, no real calls)", () => {
  it("sends the brief and the synthetic creator, returns the image bytes", async () => {
    let sent: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fake: typeof fetch = async (url, init) => {
      sent = { url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("PNG").toString("base64") } }] } }] }));
    };
    const r = geminiRenderer({ apiKey: "test-key-not-real", creatorDescription: "a fictional adult", fetch: fake });
    const out = await r({ licenceId: 1n, renderIndex: 0, brief: "spring campaign" });
    expect(Buffer.from(out.bytes).toString()).toBe("PNG");
    expect(out.mime).toBe("image/png");
    expect(sent!.url).toContain(":generateContent");
    expect(sent!.headers["x-goog-api-key"]).toBe("test-key-not-real");
    expect(sent!.body).toContain("spring campaign");
    expect(sent!.body).toContain("not a real person");
  });

  it("fails clearly on a blocked prompt or an HTTP error", async () => {
    const blocked = geminiRenderer({ apiKey: "k", creatorDescription: "x", fetch: async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })) });
    await expect(blocked({ licenceId: 1n, renderIndex: 0, brief: "b" })).rejects.toThrow("SAFETY");
    const down = geminiRenderer({ apiKey: "k", creatorDescription: "x", fetch: async () => new Response("", { status: 503 }) });
    await expect(down({ licenceId: 1n, renderIndex: 0, brief: "b" })).rejects.toThrow("503");
  });
});
