import type { Renderer } from "./renderAgent.js";

/**
 * Optional real renderer: Gemini image generation, used only when GEMINI_API_KEY is set (each render is
 * a paid API call). The demo creator is synthetic, so the prompt describes a fictional adult; a real
 * creator's renders would use their encrypted reference photos, as in likeness-arc.
 */
export function geminiRenderer(opts: {
  apiKey: string;
  model?: string;
  creatorDescription: string;
  fetch?: typeof fetch;
}): Renderer {
  const model = opts.model ?? "gemini-nano-banana-2.1";
  const f = opts.fetch ?? fetch;
  return async ({ brief }) => {
    const prompt = [
      `Photorealistic advertising image featuring a fictional adult who is not a real person: ${opts.creatorDescription}.`,
      `Creative brief: ${brief}.`,
      "Natural light, product-ad composition, no text, no logos.",
    ].join(" ");
    const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"] } }),
    });
    if (!res.ok) throw new Error(`Gemini: HTTP ${res.status}`);
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[];
      promptFeedback?: { blockReason?: string };
    };
    const img = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!img) throw new Error(`Gemini returned no image${body.promptFeedback?.blockReason ? `: ${body.promptFeedback.blockReason}` : ""}`);
    return { bytes: new Uint8Array(Buffer.from(img.data, "base64")), mime: img.mimeType };
  };
}
