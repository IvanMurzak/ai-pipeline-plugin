import { motion } from "framer-motion";
import { useId, type ReactNode } from "react";

interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

interface Props<T extends string> {
  value: T;
  segments: Segment<T>[];
  onChange: (next: T) => void;
}

export function SegmentedToggle<T extends string>({ value, segments, onChange }: Props<T>) {
  // Per-instance layoutId: framer-motion animates elements SHARING a layoutId
  // between positions, so a global id made the active-tab frame fly from one
  // toggle group to the other (left runs/pipelines ↔ right events/launch/…)
  // even though both groups legitimately have a selection at the same time.
  const uid = useId();
  return (
    <div className="relative flex border border-accent/30 bg-canvas/60 p-0.5 font-mono">
      {segments.map((s) => {
        const active = s.value === value;
        return (
          <button
            key={s.value}
            onClick={() => onChange(s.value)}
            className={`
              relative z-10 flex flex-1 items-center justify-center gap-1.5
              px-3 py-1.5 text-[10.5px] uppercase tracking-[0.18em] transition-colors
              ${active ? "text-accent" : "text-muted hover:text-ink"}
            `}
          >
            {active && (
              <motion.span
                layoutId={`segmented-pill-${uid}`}
                className="absolute inset-0 border border-accent bg-accent/12"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {s.label}
              {typeof s.count === "number" && (
                <span
                  className={`px-1.5 py-px text-[9.5px] ${
                    active
                      ? "border border-accent/60 text-accent"
                      : "border border-line/50 text-muted"
                  }`}
                >
                  {s.count.toString().padStart(2, "0")}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
