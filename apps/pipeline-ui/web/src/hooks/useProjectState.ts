/**
 * Project state hook — owns everything that flows from "pick a project":
 *   - projects list
 *   - selected project_id (persisted to localStorage)
 *   - full project state snapshot (pipelines + events)
 *   - server-derived run summaries (long-term history)
 *   - chat sessions (resumable run ids)
 *   - plugin version + SSE connection status
 *
 * Extracted from App.tsx so the layout shell doesn't need to know about
 * any of this. Returns a stable API consumers can destructure.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchChatSessions,
  fetchHealth,
  fetchProjectState,
  fetchProjects,
  fetchRuns,
  type ChatSessionRecord,
} from "../lib/api";
import { useConnectionStatus, useJournalEvents, useSSE } from "../lib/sse";
import { eventSignature } from "../lib/format";
import type {
  PipelineEvent,
  ProjectEntry,
  ProjectState,
  RunSummary,
} from "../types";

const LAST_PROJECT_KEY = "pipeline-ui-last-project";

// The daemon's test harnesses register throwaway projects under the OS
// temp dir. Two prefixes are in use today: `pipeline-ui-srv-` (Bun unit
// tests in apps/pipeline-ui/tests/) and `pipe-test-` (the manual harness
// in apps/pipeline-ui/manual-tests/harness.ts). Hide both — the daemon
// registry keeps them for /api/unregister, the UI just never lists.
//
// Matching is name-prefix OR path-substring under any tmp-style folder
// (`/Temp/` on Windows, `/tmp/` on POSIX, `/var/folders/.../T/` on macOS
// also surfaces via the name-prefix branch since mkdtemp's basename is
// the prefix).
const HARNESS_PREFIXES = ["pipeline-ui-srv-", "pipe-test-"];
function isHarnessProject(p: ProjectEntry): boolean {
  for (const prefix of HARNESS_PREFIXES) {
    if (p.project_name.startsWith(prefix)) return true;
  }
  const root = p.project_root.replace(/\\/g, "/");
  for (const prefix of HARNESS_PREFIXES) {
    if (new RegExp(`/(?:Temp|tmp|T)/${prefix}`, "i").test(root)) return true;
  }
  return false;
}

export interface UseProjectStateResult {
  projects: ProjectEntry[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  state: ProjectState | null;
  runSummaries: RunSummary[];
  chatSessions: ChatSessionRecord[];
  pluginVersion: string | null;
  connection: ReturnType<typeof useConnectionStatus>;
  /** Manually refresh server-derived summaries. Cheap and idempotent. */
  refreshSummaries: () => void;
  /** Manually refresh resumable chat sessions. Call after the daemon links a
   *  new run_id ↔ SDK session id pair so the "Resume" affordance lights up
   *  without waiting for the next project switch. */
  refreshChatSessions: () => void;
}

export function useProjectState(): UseProjectStateResult {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [selectedId, setSelectedIdState] = useState<string | null>(
    () => localStorage.getItem(LAST_PROJECT_KEY),
  );
  const [state, setState] = useState<ProjectState | null>(null);
  const [runSummaries, setRunSummaries] = useState<RunSummary[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSessionRecord[]>([]);
  const [pluginVersion, setPluginVersion] = useState<string | null>(null);
  const connection = useConnectionStatus();

  // Signature set for in-memory dedup: same event can land via REST snapshot
  // AND the SSE tail when their timing crosses.
  const signatures = useRef<Set<string>>(new Set());

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
  }, []);

  // Initial load.
  useEffect(() => {
    fetchProjects()
      .then((raw) => {
        const ps = raw.filter((p) => !isHarnessProject(p));
        setProjects(ps);
        // Auto-select the first project if nothing is in localStorage OR
        // the persisted id is not in the fetched list (stale entry left
        // over from a project that was removed/renamed since last visit).
        const persisted = localStorage.getItem(LAST_PROJECT_KEY);
        const persistedIsValid =
          persisted != null && ps.some((p) => p.project_id === persisted);
        if (!persistedIsValid && ps.length) {
          setSelectedIdState(ps[0].project_id);
        } else if (!persistedIsValid && persisted != null) {
          // No projects yet AND the persisted id is stale — clear it so
          // we don't render a 3-column shell wired to a dead id.
          setSelectedIdState(null);
        }
      })
      .catch(() => undefined);
    fetchHealth()
      .then((h) => setPluginVersion(h.plugin_version))
      .catch(() => undefined);
  }, []);

  // Per-setter sequence tokens — each setState target has its own ref so a
  // refresh of one (e.g. refreshSummaries during a journal event) can't
  // invalidate an in-flight fetch into another (e.g. fetchProjectState).
  // Late responses from previously-selected projects are still dropped.
  const stateSeq = useRef(0);
  const chatSeq = useRef(0);
  const runsSeq = useRef(0);

  const refreshSummaries = useCallback(() => {
    if (!selectedId) return;
    const my = ++runsSeq.current;
    fetchRuns(selectedId, 200)
      .then((rs) => {
        if (my !== runsSeq.current) return;
        setRunSummaries(rs);
      })
      .catch(() => undefined);
  }, [selectedId]);

  const refreshChatSessions = useCallback(() => {
    if (!selectedId) return;
    const my = ++chatSeq.current;
    fetchChatSessions(selectedId)
      .then((cs) => {
        if (my !== chatSeq.current) return;
        setChatSessions(cs);
      })
      .catch(() => undefined);
  }, [selectedId]);

  // Load state when selection changes.
  useEffect(() => {
    if (!selectedId) {
      setState(null);
      setRunSummaries([]);
      setChatSessions([]);
      signatures.current = new Set();
      return;
    }
    localStorage.setItem(LAST_PROJECT_KEY, selectedId);
    const stateMy = ++stateSeq.current;
    const chatMy = ++chatSeq.current;
    const runsMy = ++runsSeq.current;
    fetchProjectState(selectedId)
      .then((s) => {
        if (stateMy !== stateSeq.current) return;
        signatures.current = new Set(s.events.map(eventSignature));
        setState(s);
      })
      .catch(() => {
        if (stateMy !== stateSeq.current) return;
        setState(null);
      });
    fetchChatSessions(selectedId)
      .then((cs) => {
        if (chatMy !== chatSeq.current) return;
        setChatSessions(cs);
      })
      .catch(() => {
        if (chatMy !== chatSeq.current) return;
        setChatSessions([]);
      });
    fetchRuns(selectedId, 200)
      .then((rs) => {
        if (runsMy !== runsSeq.current) return;
        setRunSummaries(rs);
      })
      .catch(() => {
        if (runsMy !== runsSeq.current) return;
        setRunSummaries([]);
      });
  }, [selectedId]);

  // Live updates: dedupe-and-append journal events for the selected project.
  // Gate on selectedId rather than state.project.project_id so that events
  // arriving between project-switch and fetchProjectState resolution are
  // still kept — state may still hold the OLD project at that moment.
  useJournalEvents(
    useCallback(
      (e: PipelineEvent) => {
        if (!selectedId || e._project_id !== selectedId) return;
        const sig = eventSignature(e);
        if (signatures.current.has(sig)) return;
        signatures.current.add(sig);
        setState((prev) =>
          prev && prev.project.project_id === selectedId
            ? { ...prev, events: [...prev.events, e].slice(-500) }
            : prev,
        );
        // Lifecycle events nudge the server summary; we don't refresh on
        // every event because that would spam /api/runs.
        if (
          e.type === "pipeline.completed" ||
          e.type === "pipeline.halted" ||
          e.type === "pipeline.started"
        ) {
          refreshSummaries();
        }
      },
      [selectedId, refreshSummaries],
    ),
  );

  // Refresh project list and pipeline tree on structural changes.
  useSSE(
    useCallback(
      (msg: { type: string; data: unknown }) => {
        if (msg.type === "project.updated") {
          // Daemon bumped a project's last_seen via journal-tail
          // activity. Patch the entry in place so the picker's "X ago"
          // label reflects current activity without waiting for a
          // page-load or a new project.registered.
          const updated = msg.data as ProjectEntry;
          if (updated && !isHarnessProject(updated)) {
            setProjects((prev) => {
              const idx = prev.findIndex((p) => p.project_id === updated.project_id);
              if (idx < 0) return prev;
              const next = prev.slice();
              next[idx] = updated;
              return next;
            });
          }
        }
        if (msg.type === "project.registered") {
          fetchProjects()
            .then((raw) => {
              const ps = raw.filter((p) => !isHarnessProject(p));
              setProjects(ps);
              // If the user landed on EmptyState because the daemon had no
              // projects at mount, auto-select the first registered one
              // when it shows up. Without this the user stays stuck on
              // EmptyState until they manually pick from the dropdown.
              setSelectedIdState((cur) =>
                cur == null && ps.length ? ps[0].project_id : cur,
              );
            })
            .catch(() => undefined);
        }
        if (msg.type === "file.changed") {
          const data = msg.data as { project_id: string };
          if (selectedId === data.project_id) {
            const my = ++stateSeq.current;
            fetchProjectState(selectedId)
              .then((s) => {
                if (my !== stateSeq.current) return;
                signatures.current = new Set(s.events.map(eventSignature));
                setState(s);
              })
              .catch(() => undefined);
            refreshSummaries();
          }
        }
      },
      [selectedId, refreshSummaries],
    ),
  );

  return {
    projects,
    selectedId,
    setSelectedId,
    state,
    runSummaries,
    chatSessions,
    pluginVersion,
    connection,
    refreshSummaries,
    refreshChatSessions,
  };
}
