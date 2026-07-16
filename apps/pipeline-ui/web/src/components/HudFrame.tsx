import type { ReactNode } from "react";

/**
 * HudFrame — wraps children in a positioned block and paints four
 * corner brackets using `currentColor`. Pair with `text-accent`,
 * `text-accent2`, etc. to colour the bracket.
 *
 * Ported from the architecture-site HudBracket pattern.
 */
export function HudFrame({
  children,
  className = "",
  tone,
}: {
  children: ReactNode;
  className?: string;
  /** Optional CSS color (rgb / hex / var). Defaults to currentColor. */
  tone?: string;
}) {
  return (
    <div className={`relative ${className}`} style={tone ? { color: tone } : undefined}>
      <span className="hud-corner tl" aria-hidden />
      <span className="hud-corner tr" aria-hidden />
      <span className="hud-corner bl" aria-hidden />
      <span className="hud-corner br" aria-hidden />
      {children}
    </div>
  );
}

/**
 * Corner spans only — render inside an existing `relative` container
 * (e.g. a `surface` block) when you don't want an extra wrapper div.
 */
export function HudCorners({ tone }: { tone?: string }) {
  const style = tone ? { color: tone } : undefined;
  return (
    <>
      <span className="hud-corner tl" style={style} aria-hidden />
      <span className="hud-corner tr" style={style} aria-hidden />
      <span className="hud-corner bl" style={style} aria-hidden />
      <span className="hud-corner br" style={style} aria-hidden />
    </>
  );
}
