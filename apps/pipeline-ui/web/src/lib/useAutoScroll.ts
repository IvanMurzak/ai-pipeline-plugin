import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Sticky scroll-to-bottom.
 *
 * Tracks whether the user is currently "at the bottom" of the scroll
 * container (within `threshold` px). When `dep` changes — typically the
 * message list length — and the user was at the bottom, jumps them back
 * to the bottom in a layout effect (so the new content is visible without
 * a visible scroll-jump).
 *
 * If the user has scrolled up to read earlier content, new content arrives
 * but does NOT yank them down. That's the assistant-ui / Slack / Discord
 * convention.
 *
 * When the dep value DECREASES (e.g. msgCount went from 50 → 0 because the
 * caller cleared the list to load a new context), pinnedRef is force-reset
 * to true so the new content auto-scrolls to bottom regardless of where
 * the user was scrolled in the old context. Without that reset, scrolling
 * up in transcript A would leak across the switch to transcript B and B
 * would open at the top.
 *
 * Returns:
 *   - `ref`     — attach to the scrollable element
 *   - `pinnedRef`— ref-style getter for the "stuck to bottom" state
 *   - `scrollToBottom` — manual jump (e.g. for a "scroll to bottom" button)
 *   - `isNearBottom`   — predicate to query mid-render
 */
export function useAutoScroll(dep: number, threshold = 48) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const lastDepRef = useRef<number>(dep);

  const isNearBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, [threshold]);

  // Update the pinned flag whenever the user scrolls. Without this we'd
  // only know "was pinned at last render time" — fine in theory but
  // breaks when the user scrolls between renders.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = isNearBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Initial reading too.
    pinnedRef.current = isNearBottom();
    return () => el.removeEventListener("scroll", onScroll);
  }, [isNearBottom]);

  // After the DOM commits new content, if we were pinned, snap to the
  // bottom *before* the browser paints so the user never sees a flash.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Context switch: dep went down (typically: items array reset to 0
    // before refilling). Re-pin to bottom so the new context's first
    // render auto-scrolls regardless of the prior pinned state.
    if (dep < lastDepRef.current) {
      pinnedRef.current = true;
    }
    lastDepRef.current = dep;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [dep]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    pinnedRef.current = true;
  }, []);

  return { ref, pinnedRef, scrollToBottom, isNearBottom };
}
