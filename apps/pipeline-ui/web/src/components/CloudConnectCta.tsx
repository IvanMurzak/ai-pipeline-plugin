import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Cloud, X } from "lucide-react";
import { HudCorners } from "./HudFrame";
import { CLOUD_CONNECT_COMMAND, cloudConnectView } from "../lib/cloudConnect";

const DISMISSED_KEY = "pipeline-ui-cloud-cta-dismissed";

function loadDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface Props {
  /** Whether the ACTIVE project is already bound to a cloud project via
   *  `.claude/pipeline/cloud.json`. Always `undefined` today — no dashboard
   *  data seam reads that file yet (see cloudConnect.ts's module doc for the
   *  flagged follow-up). Exposed as a prop rather than hardcoded so wiring
   *  it up later is a one-line change at the call site, not a rewrite. */
  connected?: boolean | null;
}

/** Corner CTA inviting the user to bind this local project to the AI
 *  Pipeline cloud control plane (T1-16's `pipeline cloud connect`) — durable
 *  run history off this machine, mobile push when a run needs input,
 *  scheduling, and job leases. Tucked bottom-right so it never competes with
 *  the run boards, and dismissible (persisted) so it doesn't nag. Reflects a
 *  "Connected ✓" state instead of the invite once `connected` is confirmed
 *  true — best-effort and degrades to the static invite otherwise. */
export function CloudConnectCta({ connected }: Props) {
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [copied, setCopied] = useState(false);
  const view = cloudConnectView(connected);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* ignore — worst case it reappears next reload */
    }
  };

  const copyCommand = () => {
    navigator.clipboard
      ?.writeText(CLOUD_CONNECT_COMMAND)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.22 }}
        className="surface fixed bottom-20 right-3 z-20 w-72 max-w-[calc(100vw-1.5rem)] p-3 lg:bottom-4 lg:right-4"
      >
        <HudCorners />
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          title="Dismiss"
          className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center text-muted transition-colors hover:text-ink"
        >
          <X size={13} />
        </button>

        {view === "connected" ? (
          <div className="flex items-center gap-2 pr-5 font-mono text-[11px] uppercase tracking-[0.16em] text-good">
            <Check size={14} /> Connected to cloud ✓
          </div>
        ) : (
          <div className="pr-5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
              <Cloud size={13} /> Connect to cloud
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Durable run history, mobile push when a run needs your input, scheduling, and job
              leases — beyond this machine.
            </p>
            <button
              type="button"
              onClick={copyCommand}
              title="Copy command"
              className="mt-2 block w-full truncate border border-accent/40 bg-panel2 px-2 py-1.5 text-left font-mono text-[11px] text-accent transition-colors hover:bg-accent/10"
            >
              {copied ? "Copied ✓" : CLOUD_CONNECT_COMMAND}
            </button>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
