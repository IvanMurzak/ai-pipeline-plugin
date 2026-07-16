/**
 * MirrorService — daemon-side tailer that mirrors Claude Code terminal
 * transcripts into the pipeline UI's chat panel.
 *
 * Context: see issue #11.
 *
 * The PreToolUse/PostToolUse hooks (hooks/analytics_relay.ts) append a
 * binding record to ~/.claude/pipeline-ui/active-mirror-bindings.jsonl when
 * they detect a pipeline-manager (run anchor) or worker (step-executor /
 * legacy pipeline-executor) spawn (Path B or Path C). This service:
 *
 *   - rebuilds the in-memory binding map on boot from that file,
 *   - polls the file for new bindings (1s) and adds them dynamically,
 *   - for each transcript path referenced by an active binding, tails
 *     the file from a persisted byte offset
 *     (`<project>/.claude/pipeline/.runtime/transcripts/<sessionId>.chat.offset`)
 *     and normalizes each new entry via `normalizeTranscriptEntry`,
 *   - writes normalized entries into the binding's project's
 *     chat-messages.jsonl via `appendChatMessagePart` with
 *     `source: "mirror"` so the UI can distinguish them,
 *   - recursively binds spawned subagent transcripts (Phase 1.4) under
 *     the same run_id so the chat panel sees the executor's inner
 *     subagent activity too,
 *   - marks bindings terminal when the run's pipeline.completed /
 *     pipeline.halted lands, then unbinds them. GCs stale bindings
 *     after 24h.
 *
 * Scope discipline: sessions that never produced a binding are never
 * tailed. The MirrorService NEVER scans `~/.claude/projects/` blindly.
 * Every transcript path on the watch list got there via a hook-emitted
 * binding (Path B/C) or a recursive subagent reference from one of
 * those bindings.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

import {
  normalizeTranscriptEntry,
  type NormalizeOptions,
} from "./transcript-normalize.ts";
import { isAgentSpawnTool } from "./lib.ts";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export interface MirrorBindingRecord {
  event: "bound" | "terminal";
  tool_use_id: string | null;
  run_id: string;
  session_id: string | null;
  transcript_path: string | null;
  project_root: string;
  worktree: string | null;
  pipeline_name: string;
  iteration_path: string;
  start_ts: string;
  end_ts?: string;
  kind: "bypass-spawn" | "bypass-spawn-failed" | "chain-controller" | "subagent";
  schema: number;
}

/** Hook called by the MirrorService whenever a normalized message
 *  should be appended to a project's chat-messages.jsonl AND broadcast
 *  on the daemon's SSE channel. Wired to `appendChatMessagePart` in
 *  server.ts at boot. The indirection keeps mirror.ts dependency-free
 *  from server.ts and trivially testable. */
export type AppendChatFn = (
  projectRoot: string,
  runId: string,
  msg: unknown,
  opts: { source: "mirror"; ts: string },
) => void;

interface ActiveBinding {
  key: string;
  binding: MirrorBindingRecord;
  /** Set when the binding has been marked terminal (by an explicit
   *  `terminal` record OR by pipeline.completed/halted matching the
   *  run_id). The service does ONE more drain pass after this flips
   *  true, then removes the binding from the watch list. */
  terminal: boolean;
  /** end_ts to pass into normalizeTranscriptEntry once terminal. */
  endTs: string | null;
  /** Track uuids we've already emitted so re-tail-after-shrink doesn't
   *  duplicate. Bounded to MAX_DEDUP_UUIDS entries (LRU-ish). */
  emittedUuids: Set<string>;
}

interface TranscriptWatch {
  path: string;
  /** Byte offset of the next unread byte. Persisted via writeOffset. */
  offset: number;
  /** Partial line carried from the previous read. Lines must terminate
   *  in `\n` before we parse them. */
  partial: string;
}

interface OffsetState {
  offset: number;
  size_at_offset: number;
}

// --------------------------------------------------------------------
// Bindings file management
// --------------------------------------------------------------------

export function defaultBindingsPath(): string {
  // Match the home-dir resolution used elsewhere in this plugin
  // (transcripts.ts:48 + hooks/analytics_relay.ts:mirrorBindingsPath).
  // Reading from process.env first lets tests override HOME/USERPROFILE
  // between cases — Bun's node:os.homedir() caches the home dir at
  // process start, so post-spawn env mutations wouldn't take effect on
  // POSIX otherwise.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl");
}

/** Parse a binding-file record from a single line. Returns null for
 *  malformed lines or wrong-schema records. */
function parseBindingLine(line: string): MirrorBindingRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as MirrorBindingRecord;
    if (typeof obj !== "object" || obj == null) return null;
    if (obj.event !== "bound" && obj.event !== "terminal") return null;
    if (typeof obj.run_id !== "string" || !obj.run_id) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Key bindings by their natural ID (tool_use_id when available;
 *  fallback to a synthetic per-record key). Tool_use_id is supposed to
 *  be unique within a session, but the hook reads it from the payload —
 *  if the payload lacked it, we may have null. Two bindings with
 *  identical natural keys are treated as the same binding (idempotent
 *  re-application of the same record on daemon restart). */
function bindingKey(b: MirrorBindingRecord): string {
  if (b.tool_use_id) return `tool:${b.tool_use_id}`;
  // Synthetic fallback: (run_id, iteration_path, start_ts). This
  // collides only when the same iteration is bound twice at the same
  // ms, which would be a duplicate anyway.
  return `synth:${b.run_id}:${b.iteration_path}:${b.start_ts}`;
}

// --------------------------------------------------------------------
// Per-binding offset file (lives next to the existing token-counter
// offsets used by the Stop hook, but with a `.chat.offset` suffix so
// the two never collide).
// --------------------------------------------------------------------

function chatOffsetPath(projectRoot: string, sessionKey: string): string {
  return join(
    projectRoot,
    ".claude",
    "pipeline",
    ".runtime",
    "transcripts",
    `${sessionKey}.chat.offset`,
  );
}

function readOffsetState(path: string): OffsetState {
  try {
    if (!existsSync(path)) return { offset: 0, size_at_offset: 0 };
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { offset: 0, size_at_offset: 0 };
  }
}

function writeOffsetState(path: string, state: OffsetState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

function readByteRange(path: string, from: number, len: number): string {
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    let pos = from;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, pos);
      if (n <= 0) break;
      read += n;
      pos += n;
    }
    return buf.slice(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

// --------------------------------------------------------------------
// Subagent transcript discovery
// --------------------------------------------------------------------

/** Given a parent transcript path
 *  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
 *  and a tool_use_id from a `tool_use` content block inside that
 *  transcript, locate the corresponding subagent transcript file.
 *
 *  CC writes subagent transcripts under
 *  `<encoded-cwd>/<session-id>/subagents/agent-<aid>.jsonl` with a
 *  sibling `.meta.json`. The parent tool_use_id is NOT in the meta;
 *  the only reliable correlation is filesystem mtime order. We return
 *  the most-recent subagent file modified after the binding's
 *  start_ts whose meta.agentType matches the spawn's subagent_type.
 *
 *  Returns null when we cannot uniquely identify a subagent file. The
 *  caller silently skips — subagent chasing is best-effort. */
export function findSubagentTranscript(
  parentTranscriptPath: string,
  spawnTs: string,
  spawnSubagentType: string,
): string | null {
  const parentDir = dirname(parentTranscriptPath);
  const sessionBase = basename(parentTranscriptPath, ".jsonl");
  const subagentsDir = join(parentDir, sessionBase, "subagents");
  if (!existsSync(subagentsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return null;
  }

  const spawnTime = Date.parse(spawnTs);
  let best: { path: string; createdMs: number } | null = null;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const jsonlPath = join(subagentsDir, name);
    const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
    let agentType: string | null = null;
    try {
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        agentType = typeof meta?.agentType === "string" ? meta.agentType : null;
      }
    } catch {
      /* fall through */
    }
    // Tolerate plugin-namespaced subagent_type (e.g. pipeline:step-executor
    // or pipeline:pipeline-manager) — the meta.agentType is typically the
    // bare name.
    const bareSpawn = spawnSubagentType.includes(":")
      ? spawnSubagentType.split(":").slice(-1)[0]
      : spawnSubagentType;
    if (agentType && agentType !== bareSpawn) continue;

    let createdMs: number;
    let touchedMs: number;
    try {
      const s = statSync(jsonlPath);
      // Prefer birthtime (file creation moment) so a long-running
      // subagent that's still writing — and therefore has a LATER
      // mtime than a brief later sibling — still wins by creation
      // order. Windows and macOS report birthtime reliably; ext4
      // sometimes returns 0/mtime as birthtime, so fall back to
      // mtime when birthtime is missing or implausibly old.
      createdMs = s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
      touchedMs = s.mtimeMs;
    } catch {
      continue;
    }
    // Subagent transcript must have been CREATED at or after the spawn
    // moment (allow a small skew for clock drift / filesystem
    // granularity). Using createdMs here is critical: mtime advances
    // with writes, so a long-running earlier subagent would otherwise
    // get a later mtime than a brief later subagent and the EARLIEST
    // selection below would pick the wrong file.
    if (Number.isFinite(spawnTime) && createdMs + 5_000 < spawnTime) continue;
    // Also require touched-since-spawn so a stale historical jsonl
    // (from a prior session that happened to share an agent type)
    // doesn't sneak in when birthtime is unreliable.
    if (Number.isFinite(spawnTime) && touchedMs + 5_000 < spawnTime) continue;

    if (!best || createdMs < best.createdMs) {
      // We want the EARLIEST CREATED file at-or-after spawnTs — that's
      // the one this spawn produced. Later spawns by the SAME parent
      // appear in subsequent tool_use blocks with their own chase pass.
      best = { path: jsonlPath, createdMs };
    }
  }

  return best?.path ?? null;
}

// --------------------------------------------------------------------
// MirrorService
// --------------------------------------------------------------------

interface MirrorServiceOpts {
  /** Path to the active-mirror-bindings.jsonl file. Defaults to the
   *  per-user homedir location. Tests inject a tmpdir path. */
  bindingsPath?: string;
  /** Callback that performs the actual chat-messages.jsonl write +
   *  SSE broadcast. Server.ts wires this to `appendChatMessagePart`. */
  appendChat: AppendChatFn;
  /** Optional hook invoked when a journal event arrives that should
   *  affect bindings (currently: pipeline.completed / pipeline.halted
   *  closes all bindings on that run_id). Server.ts forwards parsed
   *  journal events to this via `MirrorService.onJournalEvent`. */
}

const POLL_INTERVAL_MS = 1000;
const MAX_DEDUP_UUIDS = 5000;
const STALE_BINDING_MS = 24 * 60 * 60 * 1000;

export class MirrorService {
  private readonly bindingsFile: string;
  private readonly appendChat: AppendChatFn;
  /** All currently-watched bindings, keyed by bindingKey(). */
  private readonly bindings = new Map<string, ActiveBinding>();
  /** Map of transcript path → list of binding keys referencing it.
   *  One transcript can serve multiple bindings (e.g. successive
   *  iterations of a chain controller share the main session's
   *  transcript). */
  private readonly transcriptToBindings = new Map<string, Set<string>>();
  /** Per-transcript tail state — byte offset + partial-line carry. */
  private readonly transcripts = new Map<string, TranscriptWatch>();
  /** How many bytes of the bindings file we've already parsed. */
  private bindingsOffset = 0;
  private bindingsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: MirrorServiceOpts) {
    this.bindingsFile = opts.bindingsPath ?? defaultBindingsPath();
    this.appendChat = opts.appendChat;
  }

  start(): void {
    if (this.bindingsTimer) return;
    this.readBindingsIncremental();
    this.tickAll();
    this.bindingsTimer = setInterval(() => {
      try {
        this.readBindingsIncremental();
        this.tickAll();
        this.gc();
      } catch {
        /* swallow — never crash the daemon */
      }
    }, POLL_INTERVAL_MS);
    // Unref so the interval doesn't keep the daemon alive on its own.
    (this.bindingsTimer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.bindingsTimer) {
      clearInterval(this.bindingsTimer);
      this.bindingsTimer = null;
    }
  }

  /** Forwarded from the journal tail in server.ts when a relevant
   *  lifecycle event lands. Closes bindings whose run_id matches AND
   *  whose project_root matches — without the project_root scope, a
   *  run_id collision (deterministic ~48-bit ids derived from tool_use_id
   *  have a birthday-bound collision space) or a subagent binding that
   *  inherited its parent's run_id could be terminated by an unrelated
   *  project's completion event. */
  onJournalEvent(
    ev: { type?: string; run_id?: string | null; project_root?: string },
  ): void {
    if (!ev || !ev.type) return;
    if (ev.type !== "pipeline.completed" && ev.type !== "pipeline.halted") return;
    if (!ev.run_id) return;
    for (const ab of this.bindings.values()) {
      if (ab.binding.run_id !== ev.run_id) continue;
      if (ev.project_root && ab.binding.project_root !== ev.project_root) continue;
      if (ab.terminal) continue;
      ab.terminal = true;
      ab.endTs = new Date().toISOString();
    }
  }

  /** Test-only — observe currently active binding keys. */
  activeBindingKeys(): string[] {
    return Array.from(this.bindings.keys());
  }

  /** Test-only — directly add a binding without going through the
   *  bindings-file IO. Used for unit tests that exercise the tail
   *  logic in isolation. */
  registerBindingForTest(b: MirrorBindingRecord): void {
    this.registerBinding(b);
  }

  /** Test-only — manually tick one cycle of transcript reads. */
  tickForTest(): void {
    this.tickAll();
    this.gc();
  }

  // ------------------------------------------------------------------
  // Bindings-file ingestion
  // ------------------------------------------------------------------

  private readBindingsIncremental(): void {
    if (!existsSync(this.bindingsFile)) return;
    let size: number;
    try {
      size = statSync(this.bindingsFile).size;
    } catch {
      return;
    }
    if (size < this.bindingsOffset) {
      // File rotated / truncated — re-read from 0.
      this.bindingsOffset = 0;
    }
    if (size === this.bindingsOffset) return;
    const chunk = readByteRange(this.bindingsFile, this.bindingsOffset, size - this.bindingsOffset);
    this.bindingsOffset = size;
    for (const line of chunk.split("\n")) {
      const rec = parseBindingLine(line);
      if (!rec) continue;
      if (rec.event === "bound") this.registerBinding(rec);
      else if (rec.event === "terminal") this.markTerminalByKey(bindingKey(rec));
    }
  }

  private registerBinding(rec: MirrorBindingRecord): void {
    const key = bindingKey(rec);
    if (this.bindings.has(key)) return; // idempotent
    if (!rec.transcript_path) {
      // Without a transcript path the tailer cannot do anything useful
      // — log and skip. (The hook records the binding regardless so
      // the issue is visible in the bindings file.)
      return;
    }
    const ab: ActiveBinding = {
      key,
      binding: rec,
      terminal: false,
      endTs: null,
      emittedUuids: new Set(),
    };
    this.bindings.set(key, ab);
    this.attachTranscript(rec.transcript_path, key);
  }

  private attachTranscript(path: string, bindingKeyStr: string): void {
    let set = this.transcriptToBindings.get(path);
    if (!set) {
      set = new Set();
      this.transcriptToBindings.set(path, set);
    }
    set.add(bindingKeyStr);

    if (!this.transcripts.has(path)) {
      // Recover persisted offset for the FIRST binding only — its
      // project_root anchors the offset file location. Subsequent
      // bindings on the same path piggyback on the same offset.
      const firstKey = set.values().next().value;
      const firstBinding = this.bindings.get(firstKey!);
      const offsetState = firstBinding
        ? readOffsetState(this.offsetPath(firstBinding))
        : { offset: 0, size_at_offset: 0 };
      this.transcripts.set(path, {
        path,
        offset: offsetState.offset,
        partial: "",
      });
    }
  }

  private offsetPath(ab: ActiveBinding): string {
    // The offset file must be unique PER TRANSCRIPT PATH, not per session_id
    // — a parent and its child subagents inherit the same session_id but
    // tail DIFFERENT transcript files, so a session_id-keyed offset would
    // make them write the same .chat.offset and corrupt each other's cursor
    // on daemon restart. Hash the transcript_path so the cursor file
    // uniquely identifies which transcript it bookmarks.
    const tpath = ab.binding.transcript_path ?? "";
    const hash = createHash("sha1").update(tpath).digest("hex").slice(0, 16);
    return chatOffsetPath(ab.binding.project_root, hash);
  }

  private markTerminalByKey(key: string): void {
    const ab = this.bindings.get(key);
    if (!ab) return;
    ab.terminal = true;
    ab.endTs = new Date().toISOString();
  }

  // ------------------------------------------------------------------
  // Per-tick: drain each watched transcript
  // ------------------------------------------------------------------

  private tickAll(): void {
    for (const path of Array.from(this.transcripts.keys())) {
      this.drainTranscript(path);
    }
  }

  private drainTranscript(path: string): void {
    const tw = this.transcripts.get(path);
    if (!tw) return;
    if (!existsSync(path)) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    // Handle truncation/rotation.
    if (size < tw.offset) {
      tw.offset = 0;
      tw.partial = "";
    }
    if (size > tw.offset) {
      const chunk = readByteRange(path, tw.offset, size - tw.offset);
      tw.offset = size;
      const buf = tw.partial + chunk;
      const lines = buf.split("\n");
      tw.partial = lines.pop() ?? "";
      for (const line of lines) {
        this.dispatchLine(path, line);
      }
    }
    // Persist offset for every binding on this transcript.
    this.persistOffsetsFor(path, size);
    // Final terminal drain — once all bindings on this transcript are
    // terminal AND we've made one no-new-content pass, detach.
    this.maybeDetachTranscript(path);
  }

  private dispatchLine(path: string, rawLine: string): void {
    if (!rawLine.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      return;
    }
    const bindingKeys = this.transcriptToBindings.get(path);
    if (!bindingKeys) return;
    for (const key of bindingKeys) {
      const ab = this.bindings.get(key);
      if (!ab) continue;
      // Only the start_ts gate filters by timestamp. Terminal status
      // does NOT impose an end-window — its sole effect is "one more
      // drain pass, then detach so subsequent appends are ignored".
      // We deliberately don't gate by ab.endTs here because the
      // entry's transcript timestamp ≠ the wall-clock moment we
      // observed `pipeline.completed`; the executor may have written
      // the line well before we noticed the completion event.
      const opts: NormalizeOptions = {
        startTs: ab.binding.start_ts,
        endTs: null,
      };
      const norm = normalizeTranscriptEntry(parsed, opts);
      if (!norm) continue;
      // De-dup by transcript-entry uuid within this binding.
      if (norm.uuid) {
        if (ab.emittedUuids.has(norm.uuid)) continue;
        ab.emittedUuids.add(norm.uuid);
        if (ab.emittedUuids.size > MAX_DEDUP_UUIDS) {
          // LRU-light: drop the oldest by re-allocating from the last
          // half. Simple, no Map.entries-style overhead.
          const arr = Array.from(ab.emittedUuids);
          ab.emittedUuids.clear();
          for (const u of arr.slice(arr.length / 2)) ab.emittedUuids.add(u);
        }
      }
      this.appendChat(ab.binding.project_root, ab.binding.run_id, norm.msg, {
        source: "mirror",
        ts: norm.ts,
      });
      // Phase 1.4 — chase subagent spawns recursively.
      this.maybeChaseSubagent(parsed, ab);
    }
  }

  /** Inspect an assistant tool_use block for an Agent/Task spawn; if
   *  found, locate the subagent transcript on disk and bind it under
   *  the same run_id as the parent so its messages flow into the same
   *  chat panel. Best-effort: silently no-ops when discovery fails. */
  private maybeChaseSubagent(parsed: unknown, parent: ActiveBinding): void {
    if (!parsed || typeof parsed !== "object") return;
    const entry = parsed as Record<string, unknown>;
    if (entry.type !== "assistant") return;
    const message = entry.message as Record<string, unknown> | undefined;
    const content = message?.content as unknown[] | undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const cb = block as Record<string, unknown>;
      if (cb.type !== "tool_use") continue;
      if (!isAgentSpawnTool(cb.name)) continue;
      const input = cb.input as Record<string, unknown> | undefined;
      const subagentType = typeof input?.subagent_type === "string"
        ? input.subagent_type
        : "";
      if (!subagentType) continue;
      const toolUseId = typeof cb.id === "string" ? cb.id : null;
      // Avoid re-binding the same nested spawn.
      const synthKey = `subagent:${parent.binding.run_id}:${toolUseId ?? Math.random()}`;
      if (this.bindings.has(synthKey)) continue;
      const parentTs = typeof entry.timestamp === "string"
        ? entry.timestamp
        : parent.binding.start_ts;
      const subagentPath = findSubagentTranscript(parent.binding.transcript_path!, parentTs, subagentType);
      if (!subagentPath) continue;
      const child: MirrorBindingRecord = {
        event: "bound",
        tool_use_id: toolUseId,
        run_id: parent.binding.run_id,
        session_id: parent.binding.session_id,
        transcript_path: subagentPath,
        project_root: parent.binding.project_root,
        worktree: parent.binding.worktree,
        pipeline_name: parent.binding.pipeline_name,
        iteration_path: parent.binding.iteration_path,
        start_ts: parentTs,
        kind: "subagent",
        schema: parent.binding.schema,
      };
      // Bind under the synth key (not bindingKey()), since multiple
      // subagents of the same parent can share a missing tool_use_id.
      const ab: ActiveBinding = {
        key: synthKey,
        binding: child,
        terminal: false,
        endTs: null,
        emittedUuids: new Set(),
      };
      this.bindings.set(synthKey, ab);
      this.attachTranscript(subagentPath, synthKey);
    }
  }

  private persistOffsetsFor(path: string, size: number): void {
    const tw = this.transcripts.get(path);
    if (!tw) return;
    const set = this.transcriptToBindings.get(path);
    if (!set) return;
    for (const key of set) {
      const ab = this.bindings.get(key);
      if (!ab) continue;
      writeOffsetState(this.offsetPath(ab), {
        offset: tw.offset,
        size_at_offset: size,
      });
    }
  }

  private maybeDetachTranscript(path: string): void {
    const set = this.transcriptToBindings.get(path);
    if (!set) return;
    const allTerminal = Array.from(set).every((k) => {
      const ab = this.bindings.get(k);
      return ab?.terminal ?? true;
    });
    if (!allTerminal) return;
    // Remove the transcript watcher and detach its bindings.
    this.transcripts.delete(path);
    for (const k of set) this.bindings.delete(k);
    this.transcriptToBindings.delete(path);
  }

  private gc(): void {
    const now = Date.now();
    for (const ab of Array.from(this.bindings.values())) {
      const startMs = Date.parse(ab.binding.start_ts);
      if (Number.isFinite(startMs) && now - startMs > STALE_BINDING_MS) {
        ab.terminal = true;
        ab.endTs = ab.endTs ?? new Date().toISOString();
      }
    }
    // Reap bindings whose transcript file no longer exists. drainTranscript
    // early-returns on !existsSync without ever reaching maybeDetachTranscript,
    // so without this sweep, bindings to deleted/rotated transcripts would
    // accumulate forever (each holding an emittedUuids Set up to MAX_DEDUP_UUIDS
    // entries).
    for (const [path, set] of Array.from(this.transcriptToBindings.entries())) {
      if (existsSync(path)) continue;
      // Be conservative: only reap once the transcript has been missing
      // long enough that we're not racing a brief rename.
      const youngest = Array.from(set).reduce<number>((acc, k) => {
        const ab = this.bindings.get(k);
        if (!ab) return acc;
        const t = Date.parse(ab.binding.start_ts);
        return Number.isFinite(t) && t > acc ? t : acc;
      }, 0);
      if (now - youngest < 60_000) continue;
      for (const k of set) this.bindings.delete(k);
      this.transcriptToBindings.delete(path);
      this.transcripts.delete(path);
    }
  }
}
