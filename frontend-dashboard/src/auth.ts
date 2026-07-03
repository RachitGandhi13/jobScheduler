const STORAGE_KEY = "scheduler-dashboard-session";

export interface AuthSession {
  token: string;
  user: { id: string; email: string; name: string | null };
  organization: { id: string; name: string };
  project: { id: string; name: string } | null;
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
