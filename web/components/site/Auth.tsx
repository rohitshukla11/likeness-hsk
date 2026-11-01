"use client";

/**
 * The Google sign-in and this server's account for it (/api/me: role, creator onboarding, brand caps),
 * shared by every page. The demo password is only the admin fallback (/admin).
 */
import { onAuthStateChanged, type User } from "firebase/auth";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "@/lib/api";
import { firebaseAuth, signInConfigured, signInWithGoogle, signOut as fbSignOut } from "@/lib/firebase";

type AuthValue = {
  /** undefined while Firebase restores the session. */
  user: User | null | undefined;
  me: Me | null;
  configured: boolean;
  refreshMe: () => Promise<Me | null>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthValue>({ user: null, me: null, configured: false, refreshMe: async () => null, signIn: async () => {}, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    const a = firebaseAuth();
    if (!a) {
      setUser(null);
      return;
    }
    return onAuthStateChanged(a, setUser);
  }, []);

  const refreshMe = useCallback(async () => {
    if (!firebaseAuth()?.currentUser) {
      setMe(null);
      return null;
    }
    const m = await api<Me>("/api/me").catch(() => null);
    setMe(m);
    return m;
  }, []);
  useEffect(() => {
    if (user !== undefined) void refreshMe();
  }, [user, refreshMe]);

  const signIn = useCallback(async () => {
    await signInWithGoogle();
  }, []);
  const signOut = useCallback(async () => {
    await fbSignOut();
    setMe(null);
  }, []);

  return <Ctx.Provider value={{ user, me, configured: signInConfigured, refreshMe, signIn, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
