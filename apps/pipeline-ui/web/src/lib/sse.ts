import { useEffect, useRef, useState } from "react";
import type { PipelineEvent } from "../types";

type SSEListener = (msg: { type: string; data: unknown }) => void;

let singleton: EventSource | null = null;
const listeners = new Set<SSEListener>();

function ensureStream(): void {
  if (singleton && singleton.readyState !== EventSource.CLOSED) return;
  singleton = new EventSource("/api/stream");
  const dispatch = (type: string, ev: MessageEvent) => {
    let data: unknown = ev.data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      /* keep raw */
    }
    for (const l of listeners) l({ type, data });
  };
  // Known event types from the daemon.
  for (const t of [
    "hello",
    "journal",
    "file.changed",
    "project.registered",
    "chat.message_part",
    // Daemon-launched headless runs (launcher.ts) — status transitions incl.
    // the needs-input question.
    "drive.run",
    // Emitted just before the daemon hands off to a newer/older plugin
    // version (POST /api/restart-to). The successor binds the same seed
    // port, so the EventSource below auto-reconnects within ~1s — this
    // event just lets the UI show "upgrading to vX…" instead of a bare
    // "reconnecting" blip.
    "restart",
  ]) {
    singleton.addEventListener(t, (ev) => dispatch(t, ev as MessageEvent));
  }
  // EventSource fires `open` after a successful (re)connect — but the daemon
  // only emits `hello` once per stream-start, so without this the connection
  // indicator stays stuck on "reconnecting" after a transparent recovery.
  singleton.addEventListener("open", () => {
    for (const l of listeners) l({ type: "open", data: null });
  });
  singleton.onerror = () => {
    // EventSource auto-reconnects; just notify listeners.
    for (const l of listeners) l({ type: "error", data: null });
  };
}

export function useSSE(onMessage: SSEListener): void {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  useEffect(() => {
    const l: SSEListener = (msg) => ref.current(msg);
    listeners.add(l);
    ensureStream();
    return () => {
      listeners.delete(l);
    };
  }, []);
}

export type ConnectionStatus = "connecting" | "open" | "error" | "restarting";

// How long to keep showing "restarting" after a `restart` frame before a
// persistent error is allowed to surface. A handoff that preserves the port
// reconnects in ~1s; if no hello/open arrives within this window the successor
// likely failed to bind (e.g. the port walked), so stop pretending it's fine
// and let the user see the real error instead of a permanent "UPGRADING".
const RESTART_GRACE_MS = 12000;

export function useConnectionStatus(): ConnectionStatus {
  const [s, setS] = useState<ConnectionStatus>("connecting");
  const restartAtRef = useRef(0);
  useSSE((msg) => {
    // A `restart` frame means the daemon is about to hand off to another
    // plugin version; the socket will drop and the successor will accept the
    // EventSource reconnect on the same port. Show "restarting" until the
    // fresh `hello`/`open` arrives so the user sees an intentional upgrade
    // rather than a connection error.
    if (msg.type === "restart") {
      restartAtRef.current = Date.now();
      setS("restarting");
    } else if (msg.type === "hello" || msg.type === "open") {
      restartAtRef.current = 0;
      setS("open");
    } else if (msg.type === "error") {
      // Keep masking the reconnect as "restarting" only within the grace
      // window after a restart; past that, a real error wins.
      setS(Date.now() - restartAtRef.current < RESTART_GRACE_MS ? "restarting" : "error");
    }
  });
  return s;
}

// Convenience — receive only journal events.
export function useJournalEvents(onEvent: (e: PipelineEvent) => void): void {
  useSSE((msg) => {
    if (msg.type === "journal") onEvent(msg.data as PipelineEvent);
  });
}

/**
 * Hard-reload the page once a daemon handoff completes. After a `restart`
 * frame the successor serves a NEW dist bundle while this tab still runs the
 * old one — the EventSource reconnects transparently, so without a reload the
 * stale JS keeps rendering against the upgraded daemon until a manual refresh.
 * Applies to every handoff source (UPDATE button, SessionStart hook,
 * auto-reconcile).
 *
 * Timing: the old server stops serving at `grace_ms` (then the port is closed
 * until the successor rebinds it), so the first successful /api/health fetch
 * after grace is by construction the successor. If the user has unsaved editor
 * changes, EditorPanel's beforeunload guard turns this into a browser prompt
 * instead of silent data loss.
 */
export function useReloadOnRestart(): void {
  const armed = useRef(false);
  useSSE((msg) => {
    if (msg.type !== "restart" || armed.current) return;
    armed.current = true;
    const grace = (msg.data as { grace_ms?: number })?.grace_ms ?? 750;
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          const res = await fetch("/api/health", { signal: AbortSignal.timeout(600) });
          if (res.ok) {
            location.reload();
            return;
          }
        } catch {
          /* successor not bound yet — keep polling */
        }
      }
      // Successor never came up (e.g. failed boot) — disarm so a future
      // restart attempt can arm again; the connection indicator already
      // shows the real error state by now.
      armed.current = false;
    };
    setTimeout(poll, grace + 250);
  });
}
