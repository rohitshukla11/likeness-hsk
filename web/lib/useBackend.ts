"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type State } from "./api";

/** The backend's /api/state (mode, HSP gateway, operator session, policy, caps, creator terms). */
export function useBackend() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await api<State>("/api/state"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { state, error, refresh };
}

/** Polls a loader every `ms` while mounted. */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const reload = useCallback(async () => setData(await load().catch(() => null)), deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
  }, [reload, ms]);
  return { data, reload };
}
