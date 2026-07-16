import { useRef, useState } from "react";

/**
 * Vertical drag-bar that bridges the gap between two grid columns.
 * Reports cumulative pointer-x delta to its parent — the parent owns
 * the width state, persists it, and clamps. The handle itself is
 * stateless apart from the active-drag flag (for hover styling).
 *
 * Position it absolutely on the left edge of the column you want to
 * resize FROM the left. Width-grows-leftward layout: a leftward drag
 * means `delta < 0` and the right column gets wider, so the parent
 * should subtract delta.
 */
export function ResizeHandle({
  onResize,
  ariaLabel = "Resize panel",
  side = "left",
}: {
  onResize: (deltaX: number) => void;
  ariaLabel?: string;
  /** Which edge of the column the bar sits on: "left" (resize the column to
   *  its right, e.g. the right pane) or "right" (resize the column to its
   *  left, e.g. the left pane). */
  side?: "left" | "right";
}) {
  const [active, setActive] = useState(false);
  const lastX = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only handle primary button drags. Right-click / middle-click should
    // pass through (lets users still open context menus on the gap area).
    if (e.button !== 0) return;
    e.preventDefault();
    lastX.current = e.clientX;
    setActive(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - lastX.current;
      lastX.current = ev.clientX;
      if (dx !== 0) onResize(dx);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setActive(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      className={`
        absolute ${side === "left" ? "-left-3" : "-right-3"} top-0 bottom-0 z-30 hidden w-3 cursor-col-resize lg:flex
        items-center justify-center transition-colors
        ${active ? "" : "hover:bg-accent/10"}
      `}
    >
      <span
        className={`
          h-12 w-[3px] transition-colors
          ${active ? "bg-accent" : "bg-accent/30 group-hover:bg-accent/60"}
        `}
      />
    </div>
  );
}
