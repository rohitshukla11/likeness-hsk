/**
 * Vertex AI over REST in project likeness-hsk, without API keys. The access token comes from the GCP
 * metadata server (the VM's service account, roles/aiplatform.user) or, on a developer's machine, from
 * the likeness-hsk gcloud configuration (never the shared Application Default Credentials file). Every
 * call names the project and sends it as the quota project.
 *   Gemini:  POST https://aiplatform.googleapis.com/v1/projects/{p}/locations/global/publishers/google/models/{m}:generateContent
 *   Veo:     POST https://us-central1-aiplatform.googleapis.com/v1/projects/{p}/locations/us-central1/publishers/google/models/{m}:predictLongRunning
 *            then :fetchPredictOperation until done; the MP4 comes back inline (no storage bucket).
 */
import { execFileSync } from "node:child_process";

export const vertexProject = () => process.env.VERTEX_PROJECT ?? "likeness-hsk";
export const models = {
  image: () => process.env.VERTEX_IMAGE_MODEL ?? "gemini-nano-banana-2.1",
  filter: () => process.env.VERTEX_FILTER_MODEL ?? "gemini-3.5-flash-lite",
  video: () => process.env.VERTEX_VIDEO_MODEL ?? "veo-3.1-lite-generate-001",
};

let token: { value: string; exp: number } | undefined;
let source: "metadata" | "gcloud" | undefined;

async function metadataToken(): Promise<{ value: string; exp: number }> {
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) throw new Error(`metadata server: HTTP ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  return { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
}

function gcloudToken(): { value: string; exp: number } {
  const value = execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: process.env.LIKENESS_GCLOUD_CONFIG ?? "likeness-hsk" },
  }).trim();
  return { value, exp: Date.now() + 45 * 60_000 };
}

export async function accessToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  if (source !== "gcloud") {
    try {
      token = await metadataToken();
      source = "metadata";
      return token.value;
    } catch (e) {
      if (source === "metadata") throw e;
    }
  }
  token = gcloudToken();
  source = "gcloud";
  return token.value;
}

export class VertexError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

async function post<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", "x-goog-user-project": vertexProject() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { status?: string; message?: string } };
  if (!r.ok || j.error) throw new VertexError(r.status, `Vertex AI: HTTP ${r.status} ${j.error?.status ?? ""}: ${j.error?.message ?? "no message"}`.replace(/\s+/g, " "));
  return j;
}

export type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string }; thought?: boolean };
export type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string; finishMessage?: string }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
};

/** Vertex AI's shared quota answers 429/503 under load: retried after 5, 15 and 30 s. */
export async function generateContent(model: string, body: unknown, timeoutMs = 120_000): Promise<GeminiResponse> {
  const url = `https://aiplatform.googleapis.com/v1/projects/${vertexProject()}/locations/global/publishers/google/models/${model}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await post<GeminiResponse>(url, body, timeoutMs);
    } catch (e) {
      if (!(e instanceof VertexError) || (e.httpStatus !== 429 && e.httpStatus !== 503) || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, [5000, 15000, 30000][attempt]));
    }
  }
}

type VeoOp = { name: string; done?: boolean; error?: { code?: number; message?: string }; response?: { videos?: { bytesBase64Encoded?: string; mimeType?: string }[]; raiMediaFilteredReasons?: string[] } };
const veoBase = () => `https://us-central1-aiplatform.googleapis.com/v1/projects/${vertexProject()}/locations/us-central1/publishers/google/models/${models.video()}`;

/**
 * Veo image-to-video: the first frame is the given still. Adults only (personGeneration allow_adult),
 * silent, 720p. Polled every 10 s until done or the deadline.
 */
export async function imageToVideo(input: { image: Uint8Array; mime: "image/jpeg" | "image/png"; prompt: string; seconds: 4 | 6 | 8; aspectRatio: "16:9" | "9:16"; timeoutMs?: number }): Promise<Uint8Array> {
  const op = await post<VeoOp>(
    `${veoBase()}:predictLongRunning`,
    {
      instances: [{ prompt: input.prompt, image: { bytesBase64Encoded: Buffer.from(input.image).toString("base64"), mimeType: input.mime } }],
      parameters: { durationSeconds: input.seconds, resolution: "720p", aspectRatio: input.aspectRatio, generateAudio: false, personGeneration: "allow_adult", sampleCount: 1 },
    },
    60_000,
  );
  const deadline = Date.now() + (input.timeoutMs ?? 360_000);
  for (;;) {
    if (Date.now() > deadline) throw new Error("Veo took longer than the deadline");
    await new Promise((r) => setTimeout(r, 10_000));
    const r = await post<VeoOp>(`${veoBase()}:fetchPredictOperation`, { operationName: op.name }, 60_000);
    if (!r.done) continue;
    if (r.error) throw new Error(`Veo: ${r.error.message ?? r.error.code}`);
    const v = r.response?.videos?.[0];
    if (!v?.bytesBase64Encoded) throw new Error(`Veo declined to make this video: ${r.response?.raiMediaFilteredReasons?.join("; ") || "no video returned"}`);
    return new Uint8Array(Buffer.from(v.bytesBase64Encoded, "base64"));
  }
}
