import { useEffect, useState } from "react";

/** Reactive matchMedia — drives the mobile/desktop layout split and lets the
 *  shell skip rendering desktop-only decor (canvas particles) on phones
 *  instead of merely hiding it with CSS (hidden canvases still burn frames). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The single breakpoint the shell splits on (Tailwind lg). */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}
