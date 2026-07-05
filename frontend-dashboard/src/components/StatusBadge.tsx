import type { JobStatus } from "../types";

/*
 * Dot + tinted-pill treatment per job status. Completed borrows the chart's
 * validated success green and failed the reserved alert red-orange, so state
 * reads at a glance without color ever being the only signal (the status
 * word is always printed beside the dot). The running dot pulses.
 */
const STYLES: Record<JobStatus, { pill: string; dot: string; pulse?: boolean }> = {
  queued: { pill: "bg-olive-dark/[0.06] text-olive-dark/80", dot: "bg-olive-dark/40" },
  scheduled: { pill: "bg-sage/20 text-olive-dark/80", dot: "bg-sage" },
  claimed: { pill: "bg-olive/10 text-olive-dark", dot: "bg-olive/70" },
  running: { pill: "bg-olive/10 text-olive-dark", dot: "bg-olive", pulse: true },
  completed: { pill: "bg-[#398048]/10 text-[#2c6338]", dot: "bg-[#398048]" },
  failed: { pill: "bg-terracotta/10 text-terracotta", dot: "bg-terracotta" },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const style = STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${style.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot} ${style.pulse ? "animate-pulse" : ""}`} />
      {status}
    </span>
  );
}
