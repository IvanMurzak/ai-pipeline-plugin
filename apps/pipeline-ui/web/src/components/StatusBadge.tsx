import { motion } from "framer-motion";
import type { RunStatus } from "../types";

const META: Record<
  RunStatus,
  { label: string; dot: string; text: string; border: string }
> = {
  running:           { label: "RUNNING",   dot: "bg-accent",  text: "text-accent",  border: "border-accent/60"  },
  improving:         { label: "IMPROVE",   dot: "bg-accent2", text: "text-accent2", border: "border-accent2/60" },
  scripting:         { label: "SCRIPT",    dot: "bg-accent2", text: "text-accent2", border: "border-accent2/60" },
  "polling-blocker": { label: "BLOCKER",   dot: "bg-warn",    text: "text-warn",    border: "border-warn/60"    },
  completed:         { label: "COMPLETE",  dot: "bg-good",    text: "text-good",    border: "border-good/60"    },
  halted:            { label: "HALTED",    dot: "bg-bad",     text: "text-bad",     border: "border-bad/60"     },
  unknown:           { label: "UNKNOWN",   dot: "bg-muted",   text: "text-muted",   border: "border-muted/60"   },
};

export function StatusBadge({ status, animate = true }: { status: RunStatus; animate?: boolean }) {
  const m = META[status];
  const active =
    status === "running" || status === "improving" || status === "scripting" || status === "polling-blocker";
  return (
    <motion.span
      layout
      className={`
        inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono
        text-[10px] uppercase tracking-[0.16em] ${m.text} ${m.border}
        bg-canvas/60 backdrop-blur
      `}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {active && animate && (
          <span className={`absolute inset-0 rounded-full ${m.dot} opacity-50 animate-ping`} />
        )}
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${m.dot} ${
            active && animate ? "animate-pulseDot" : ""
          }`}
        />
      </span>
      {m.label}
    </motion.span>
  );
}
