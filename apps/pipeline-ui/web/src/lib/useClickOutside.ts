import { useEffect, type RefObject } from "react";

/**
 * Close-on-outside-click for dropdowns/popovers.
 *
 * Deliberately NOT a `fixed inset-0` backdrop div: several ancestors here
 * (the header, every `.surface`) carry `backdrop-filter`, which makes them
 * the CONTAINING BLOCK for fixed-position descendants — the "full-screen"
 * backdrop silently shrinks to the ancestor's box and clicks outside it
 * never close the popover. A document-level listener has no such trap.
 * Also closes on Escape.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onOutside();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOutside();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, onOutside, active]);
}
