import { useCallback, useEffect, useState } from "react";
import { authApi } from "../api/client";
import { clearSession, loadSession, saveSession, type AuthSession } from "../auth";

export function useAuth() {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [checking, setChecking] = useState(true);

  // Validate a stored token once on load: a 7-day-old token or a since-deleted
  // account would otherwise leave the UI showing a "logged in" shell whose
  // every API call silently 401s.
  useEffect(() => {
    const stored = loadSession();
    if (!stored) {
      setChecking(false);
      return;
    }
    authApi
      .me()
      .then((res) => {
        const refreshed: AuthSession = { ...res.data, token: stored.token };
        saveSession(refreshed);
        setSession(refreshed);
      })
      .catch(() => {
        clearSession();
        setSession(null);
      })
      .finally(() => setChecking(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login({ email, password });
    saveSession(res.data);
    setSession(res.data);
  }, []);

  const signup = useCallback(async (email: string, password: string, organizationName: string, name?: string) => {
    const res = await authApi.signup({ email, password, organizationName, name });
    saveSession(res.data);
    setSession(res.data);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  return { session, checking, login, signup, logout };
}
