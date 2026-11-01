/**
 * Google sign-in through Firebase Auth: the browser sends its Firebase ID token as a Bearer token; this
 * server checks it against Google's public keys (issuer, audience = the Firebase project, expiry). No
 * service-account key or other secret is needed.
 */
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const GOOGLE_KEYS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface SignedIn {
  uid: string;
  email: string;
  name: string;
  picture: string | null;
}

export type VerifyIdToken = (token: string) => Promise<SignedIn>;

export function firebaseVerifier(projectId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_KEYS))): VerifyIdToken {
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { issuer: `https://securetoken.google.com/${projectId}`, audience: projectId, algorithms: ["RS256"] });
    const p = payload as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string; firebase?: { sign_in_provider?: string } };
    if (!p.sub) throw new Error("token has no subject");
    if (p.firebase?.sign_in_provider !== "google.com") throw new Error("sign in with Google");
    if (!p.email || p.email_verified !== true) throw new Error("the Google account's email isn't verified");
    return { uid: p.sub, email: p.email, name: p.name ?? p.email.split("@")[0]!, picture: p.picture ?? null };
  };
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}
