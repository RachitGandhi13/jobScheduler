/**
 * Shimmering loading placeholder (static tint under prefers-reduced-motion).
 * Shape/size come from the caller's className -- see .skeleton in index.css.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}
