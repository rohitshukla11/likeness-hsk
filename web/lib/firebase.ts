"use client";

/**
 * Google sign-in (Firebase Auth, project likeness-hsk). Sign-in asks only for the basic profile
 * (email, name, photo); YouTube read access is asked for once, during creator onboarding, and its
 * token goes straight to our server, which reads the channel and keeps no token.
 */
import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, reauthenticateWithPopup, signInWithPopup, signOut as fbSignOut, type Auth } from "firebase/auth";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const signInConfigured = !!(config.apiKey && config.projectId);

let auth: Auth | undefined;
export function firebaseAuth(): Auth | undefined {
  if (!signInConfigured || typeof window === "undefined") return undefined;
  auth ??= getAuth(getApps().length ? getApp() : initializeApp(config));
  return auth;
}

export async function signInWithGoogle() {
  const a = firebaseAuth();
  if (!a) throw new Error("Google sign-in isn't configured on this build");
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(a, p);
}

export async function signOut() {
  const a = firebaseAuth();
  if (a) await fbSignOut(a);
}

/** The signed-in account's Firebase ID token, for our API (refreshed by Firebase when near expiry). */
export async function idToken(): Promise<string | undefined> {
  return firebaseAuth()?.currentUser?.getIdToken();
}

/** Asks the signed-in Google account for YouTube read access; returns the OAuth access token. */
export async function youtubeAccessToken(): Promise<string> {
  const a = firebaseAuth();
  const user = a?.currentUser;
  if (!user) throw new Error("sign in with Google first");
  const p = new GoogleAuthProvider();
  p.addScope("https://www.googleapis.com/auth/youtube.readonly");
  p.setCustomParameters({ login_hint: user.email ?? "" });
  const result = await reauthenticateWithPopup(user, p);
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (!token) throw new Error("Google didn't return YouTube access");
  return token;
}
