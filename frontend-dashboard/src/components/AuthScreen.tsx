import { useState, type FormEvent } from "react";
import { GlassCard } from "./GlassCard";

interface AuthScreenProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onSignup: (email: string, password: string, organizationName: string, name?: string) => Promise<void>;
}

export function AuthScreen({ onLogin, onSignup }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await onLogin(email, password);
      } else {
        await onSignup(email, password, organizationName, name || undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-sand p-4">
      <GlassCard className="w-full max-w-sm p-8">
        <p className="text-xs font-medium uppercase tracking-wider text-olive/70">Scheduler</p>
        <h1 className="mb-6 text-xl font-semibold text-olive-dark">
          {mode === "login" ? "Log in" : "Create your workspace"}
        </h1>

        <form className="space-y-3" onSubmit={handleSubmit}>
          {mode === "signup" && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-olive-dark">Organization name</span>
              <input
                className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 text-sm outline-none focus:border-olive"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                required
              />
            </label>
          )}
          {mode === "signup" && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-olive-dark">Your name</span>
              <input
                className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 text-sm outline-none focus:border-olive"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-olive-dark">Email</span>
            <input
              type="email"
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 text-sm outline-none focus:border-olive"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-olive-dark">Password</span>
            <input
              type="password"
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 text-sm outline-none focus:border-olive"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={mode === "signup" ? 8 : undefined}
              required
            />
          </label>

          {error && <p className="text-sm text-terracotta">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="btn-press w-full rounded-lg bg-olive px-4 py-2 text-sm font-medium text-white transition hover:bg-olive-dark disabled:opacity-50"
          >
            {busy ? "Working…" : mode === "login" ? "Log in" : "Create workspace"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
          className="mt-4 w-full text-center text-sm text-olive-dark/60 hover:text-olive-dark"
        >
          {mode === "login" ? "Need a workspace? Sign up" : "Already have an account? Log in"}
        </button>
      </GlassCard>
    </div>
  );
}
