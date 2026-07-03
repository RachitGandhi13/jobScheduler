import type { HTMLAttributes } from "react";

/** Shared glassmorphism tile: translucent white, soft blur, diffuse shadow. */
export function GlassCard({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-2xl border border-white/40 bg-white/70 shadow-[0_8px_30px_rgb(0,0,0,0.02)] backdrop-blur-md ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
