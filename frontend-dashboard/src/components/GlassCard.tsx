import type { HTMLAttributes } from "react";

/**
 * Shared glassmorphism tile: translucent white, soft blur, diffuse shadow.
 * Fades/slides in once on mount (animate-fade-in-up, see index.css) --
 * doesn't replay on re-render since React never remounts the same DOM node
 * for a prop update, only for a real mount (a fresh card appearing, a tab
 * switch swapping content).
 */
export function GlassCard({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`animate-fade-in-up rounded-2xl border border-white/40 bg-white/70 shadow-[0_8px_30px_rgb(0,0,0,0.02)] backdrop-blur-md transition-shadow duration-300 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
