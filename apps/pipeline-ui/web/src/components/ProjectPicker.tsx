import { useCallback, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, FolderGit2, Check } from "lucide-react";
import type { ProjectEntry } from "../types";
import { relativeTime } from "../lib/format";
import { useClickOutside } from "../lib/useClickOutside";
import { HudCorners } from "./HudFrame";

interface Props {
  projects: ProjectEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectPicker({ projects, selectedId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.project_id === selectedId);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(rootRef, close, open);

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="
          group flex items-center gap-2.5 border border-accent/40 bg-canvas/70 px-3 py-2
          font-mono text-[12px] uppercase tracking-[0.12em] text-ink backdrop-blur
          transition-colors hover:border-accent hover:text-accent
          focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
        "
      >
        <span
          className="grid h-6 w-6 place-items-center border border-accent/60 bg-panel2/80 text-accent"
          aria-hidden
        >
          <FolderGit2 size={12} strokeWidth={2.4} />
        </span>
        <span className="max-w-[280px] truncate">
          {current
            ? current.project_name
            : projects.length
              ? "SELECT_PROJECT…"
              : "NO_PROJECTS"}
        </span>
        <ChevronDown
          size={14}
          className={`text-accent/70 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.4, 0, 0.2, 1] }}
            className="surface absolute left-0 top-full z-40 mt-2 w-[420px] max-w-[80vw] overflow-hidden shadow-card"
          >
            <HudCorners />
            <div className="border-b frame-divider px-4 py-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
                ▌ {projects.length.toString().padStart(2, "0")} PROJECT{projects.length === 1 ? "" : "S"}
              </p>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {projects.length === 0 && (
                <li className="px-4 py-6 text-center text-xs text-muted">
                  Run a pipeline in any project — it will appear here automatically.
                </li>
              )}
              {projects.map((p) => (
                <li key={p.project_id}>
                  <button
                    onClick={() => {
                      onSelect(p.project_id);
                      setOpen(false);
                    }}
                    className={`
                      flex w-full items-start gap-3 px-4 py-2.5 text-left font-mono
                      transition-colors hover:bg-accent/10
                      ${p.project_id === selectedId ? "bg-accent/10 text-accent" : "text-ink"}
                    `}
                  >
                    <span className="mt-0.5">
                      {p.project_id === selectedId ? (
                        <Check size={14} className="text-accent" />
                      ) : (
                        <span className="inline-block h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold uppercase tracking-[0.1em]">
                        {p.project_name}
                      </p>
                      <p className="truncate text-[10.5px] normal-case text-muted">
                        {p.project_root}
                      </p>
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted">
                      {relativeTime(p.last_seen)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
