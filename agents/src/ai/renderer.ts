/**
 * The render agent's renderer when AI generation is on: an image or video ad of the creator from their
 * consented photo; a marked TEST RENDER instead (with the reason) if the creator has no photo (Ana Reyes,
 * the synthetic creator) or generation fails, so a paid render is always delivered and anchored.
 */
import { testRenderer, type Renderer } from "../render/renderAgent.js";
import type { AdGenerator } from "./generate.js";

export function aiRenderer(gen: AdGenerator, fallback: Renderer = testRenderer): Renderer {
  return async (input) => {
    const photo = input.subject?.photo;
    if (!photo) return { ...(await fallback(input)), note: "TEST RENDER: this creator has no consented photo for AI generation" };
    try {
      const out =
        input.kind === "video"
          ? await gen.video({ brief: input.brief, prompt: input.prompt, motion: input.motion, photo, onProgress: input.onProgress })
          : await gen.image({ brief: input.brief, prompt: input.prompt, photo });
      return { bytes: out.bytes, mime: out.mime, model: out.model };
    } catch (e) {
      return { ...(await fallback(input)), note: `AI generation failed, so this is a TEST RENDER: ${(e as Error).message.slice(0, 200)}` };
    }
  };
}
