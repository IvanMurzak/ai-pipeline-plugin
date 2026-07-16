import { useEffect, useState } from "react";
import { Activity, DownloadCloud, Workflow } from "lucide-react";
import { motion } from "framer-motion";
import { ThemeToggle } from "./ThemeToggle";
import { ProjectPicker } from "./ProjectPicker";
import { fetchUpdateStatus, postRestart, type UpdateStatus } from "../lib/api";
import type { ProjectEntry } from "../types";
import type { ConnectionStatus } from "../lib/sse";

const UPDATE_POLL_MS = 60_000;

/** Poll /api/update-status so the UPDATE button appears when a different
 *  plugin version is installed than the one the daemon runs from. Slow poll —
 *  this state changes on install actions, not on run activity. */
function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchUpdateStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, UPDATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return status;
}

interface Props {
  projects: ProjectEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  connection: ConnectionStatus;
  pluginVersion: string | null;
}

export function TopBar({ projects, selectedId, onSelect, connection, pluginVersion }: Props) {
  const updateStatus = useUpdateStatus();
  const [updateClicked, setUpdateClicked] = useState(false);
  const pendingUpdate =
    updateStatus?.update && !updateStatus.restarting ? updateStatus.update : null;
  const updating = updateClicked || connection === "restarting";
  const connColor =
    connection === "open"
      ? "text-good"
      : connection === "error"
      ? "text-bad"
      : "text-warn";
  const connLabel =
    connection === "open"
      ? "LIVE"
      : connection === "error"
      ? "RECONNECT"
      : connection === "restarting"
      ? "UPGRADING"
      : "CONNECTING";
  return (
    <header className="relative z-20 border-b frame-divider bg-canvas/60 backdrop-blur-md">
      <div className="flex items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-4 sm:py-3 lg:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
            className="flex shrink-0 items-center gap-2 sm:gap-3"
          >
            <span
              className="grid h-8 w-8 place-items-center border-2 border-accent bg-canvas/80 text-accent sm:h-9 sm:w-9"
              aria-hidden
            >
              <Workflow size={16} strokeWidth={2.4} />
            </span>
            <div className="hidden leading-tight md:block">
              <h1
                className="glitch font-display text-sm font-bold uppercase tracking-[0.22em] text-gradient-cyber"
                data-text="SYSTEM://PIPELINE"
              >
                SYSTEM://PIPELINE
              </h1>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                v{pluginVersion ?? "—"} · /pipeline:ui
              </p>
            </div>
          </motion.div>
          <span className="hidden h-7 w-px bg-accent/30 md:inline-block" />
          <div className="min-w-0 flex-1 sm:flex-none">
            <ProjectPicker projects={projects} selectedId={selectedId} onSelect={onSelect} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {pendingUpdate && (
            <button
              type="button"
              disabled={updating}
              onClick={() => {
                setUpdateClicked(true);
                // The daemon answers, broadcasts `restart`, and exits after a
                // short grace; useReloadOnRestart reloads this page once the
                // successor is up. On failure re-enable so the user can retry.
                postRestart().catch(() => setUpdateClicked(false));
              }}
              title={`Plugin v${pendingUpdate.version} is installed, but the daemon is still running v${pluginVersion ?? "?"}. Restart into the new version — open tabs reconnect and reload automatically.`}
              className="flex items-center gap-1.5 border border-warn/60 bg-warn/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-warn transition-colors hover:bg-warn/20 disabled:cursor-wait disabled:opacity-60"
            >
              <DownloadCloud size={11} strokeWidth={2.5} className={updating ? "animate-pulse" : ""} />
              <span className="hidden sm:inline">
                {updating ? "UPDATING…" : `UPDATE v${pendingUpdate.version}`}
              </span>
            </button>
          )}
          <span
            className={`flex items-center gap-1.5 border border-current/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${connColor}`}
          >
            <Activity
              size={11}
              strokeWidth={2.5}
              className={connection === "open" ? "animate-pulseDot" : ""}
            />
            <span className="hidden sm:inline">{connLabel}</span>
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
