import { useState, type FormEvent } from "react";
import { BrandMark, CheckIcon } from "./icons";

interface AuthScreenProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onSignup: (email: string, password: string, organizationName: string, name?: string) => Promise<void>;
}

const LIFECYCLE_STAGES = ["Queued", "Claimed", "Running", "Completed"] as const;

const FEATURES = [
  "Atomic claiming — every job runs exactly once",
  "Fixed, linear & exponential retries with a dead letter queue",
  "Live worker heartbeats and automatic crash recovery",
];

const PROOF_POINTS = [
  { value: "1×", label: "execution guarantee" },
  { value: "3", label: "retry strategies" },
  { value: "23", label: "integration tests" },
];

/**
 * Left: dark brand panel with an animated job-lifecycle rail (hidden below
 * lg:). Right: the actual form. Both halves share one viewport-height flex
 * row, so the form stays vertically centered at any window size.
 */
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

  function switchMode(next: "login" | "signup") {
    setMode(next);
    setError(null);
  }

  return (
    <div className="flex min-h-screen bg-sand">
      {/* ---------- Brand panel ---------- */}
      <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-espresso p-10 text-sand lg:flex xl:w-1/2 xl:p-14">
        {/* Ambient glows -- rust from the top left, gold from the bottom right. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 -left-40 h-[480px] w-[480px] rounded-full bg-olive/40 blur-[140px]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-48 -bottom-48 h-[420px] w-[420px] rounded-full bg-sage/20 blur-[140px]"
        />

        <div className="relative flex items-center gap-3">
          <BrandMark className="h-9 w-9" />
          <div>
            <p className="text-[15px] leading-tight font-semibold tracking-tight text-sand">Scheduler</p>
            <p className="text-[10px] font-semibold tracking-[0.22em] text-sage">CONTROL ROOM</p>
          </div>
        </div>

        <div className="relative max-w-md">
          <h1 className="text-3xl leading-[1.15] font-semibold tracking-tight text-sand xl:text-4xl">
            Reliable background jobs, without the babysitting.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-sand/60">
            A distributed job scheduler with multi-tenant queues, concurrent workers, and a live control
            room for everything they run.
          </p>

          {/* Job-lifecycle rail with a travelling pulse (hidden under reduced motion). */}
          <div className="relative mt-10 mb-10 pl-1">
            <div aria-hidden="true" className="absolute top-3 bottom-3 left-[8px] w-px bg-white/12" />
            <div
              aria-hidden="true"
              className="pipeline-traveler absolute left-[4.5px] hidden h-2 w-2 rounded-full bg-sage shadow-[0_0_14px_3px_rgba(201,165,104,0.55)] lg:block"
            />
            {LIFECYCLE_STAGES.map((stage) => (
              <div key={stage} className="relative flex items-center gap-4 py-2.5">
                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-white/35 ring-4 ring-white/5" />
                <span className="text-sm font-medium text-sand/75">{stage}</span>
                {stage === "Running" && (
                  <span className="rounded-md bg-white/8 px-1.5 py-0.5 font-mono text-[10px] text-sage">
                    worker-02
                  </span>
                )}
              </div>
            ))}
          </div>

          <ul className="space-y-3.5">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-3 text-sm text-sand/75">
                <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-sage/20">
                  <CheckIcon className="h-2.5 w-2.5 text-sage" strokeWidth={3} />
                </span>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex gap-10 border-t border-white/10 pt-6">
          {PROOF_POINTS.map((point) => (
            <div key={point.label}>
              <p className="text-xl font-semibold tracking-tight text-sand tabular-nums">{point.value}</p>
              <p className="mt-0.5 text-[11px] tracking-wide text-sand/45">{point.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ---------- Form panel ---------- */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div className="animate-fade-in-up w-full max-w-[400px]">
          {/* Compact brand row for viewports where the panel is hidden. */}
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <BrandMark className="h-8 w-8" />
            <div>
              <p className="text-sm leading-tight font-semibold tracking-tight">Scheduler</p>
              <p className="text-[9px] font-semibold tracking-[0.22em] text-olive">CONTROL ROOM</p>
            </div>
          </div>

          <h2 className="text-[26px] font-semibold tracking-tight text-olive-dark">
            {mode === "login" ? "Welcome back" : "Create your workspace"}
          </h2>
          <p className="mt-1.5 mb-8 text-sm text-olive-dark/55">
            {mode === "login"
              ? "Sign in to your control room."
              : "Your org, first project, and default queue — provisioned in one step."}
          </p>

          <form className="space-y-4" onSubmit={handleSubmit}>
            {mode === "signup" && (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-olive-dark">Organization name</span>
                <input
                  className="input"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Acme Inc."
                  required
                />
              </label>
            )}
            {mode === "signup" && (
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-olive-dark">Your name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-olive-dark">Email</span>
              <input
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-olive-dark">Password</span>
              <input
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={mode === "signup" ? 8 : undefined}
                required
              />
            </label>

            {error && (
              <div
                role="alert"
                className="animate-fade-in rounded-xl border border-terracotta/25 bg-terracotta-light/40 px-3.5 py-2.5 text-[13px] leading-snug text-olive-dark"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary btn-press mt-2 w-full py-2.5 text-sm"
            >
              {busy && (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none"
                />
              )}
              {busy ? "Working…" : mode === "login" ? "Log in" : "Create workspace"}
            </button>
          </form>

          <div className="mt-7 border-t border-olive-dark/[0.07] pt-5 text-center">
            <button
              onClick={() => switchMode(mode === "login" ? "signup" : "login")}
              className="text-sm text-olive-dark/55 transition hover:text-olive-dark"
            >
              {mode === "login" ? (
                <>
                  Need a workspace? <span className="font-semibold text-olive">Sign up</span>
                </>
              ) : (
                <>
                  Already have an account? <span className="font-semibold text-olive">Log in</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
