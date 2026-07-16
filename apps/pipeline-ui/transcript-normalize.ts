/**
 * Claude Code transcript → chat-messages.jsonl normalizer.
 *
 * The pipeline UI's chat panel (`web/src/components/MessageRow.tsx`)
 * already accepts BOTH Anthropic Agent SDK message objects AND Claude
 * Code transcript entries — they share the
 * `{type, message:{role, content:[...]}}` shape. This module is the
 * thin adapter that decides which transcript entries to mirror and
 * trims off CC-specific metadata that the renderer would ignore anyway
 * (parentUuid, requestId, isSidechain, agentId, gitBranch, etc.) to
 * keep the chat-messages.jsonl file small and clean.
 *
 * Used by mirror.ts when tailing a bound transcript.
 */

/**
 * Top-level keys we DROP from a transcript entry before mirroring.
 * Each is either CC-internal correlation metadata that the renderer
 * does not consult, or large/noisy state (attachments, snapshots)
 * that would balloon chat-messages.jsonl without any user-visible
 * benefit.
 */
const STRIP_FIELDS = new Set([
  "parentUuid",
  "requestId",
  "isSidechain",
  "agentId",
  "promptId",
  "entrypoint",
  "userType",
  "cwd",
  "gitBranch",
  "version",
  "attachment",
  "sourceToolAssistantUUID",
  "toolUseResult",
]);

/** Top-level `type` values we always SKIP — they carry no user-facing
 *  content. `attachment` entries hold deferred-tool deltas / mcp
 *  notifications; `file-history-snapshot` and `permission-mode` are CC
 *  internal session bookkeeping; `summary` is auto-generated and would
 *  duplicate the final assistant turn. */
const SKIP_TYPES = new Set([
  "attachment",
  "file-history-snapshot",
  "permission-mode",
  "summary",
]);

export interface NormalizeOptions {
  /** ISO timestamp of the binding's start. Entries strictly before this
   *  are skipped — prevents historical executor runs (from earlier in
   *  the same session transcript) from being mirrored into the current
   *  pipeline's chat panel. Pass `null` to disable the gate. */
  startTs?: string | null;
  /** ISO timestamp of the binding's end. Entries strictly after this
   *  are skipped. Pass `null` for an open-ended window (the default;
   *  the daemon uses end_ts only when the binding is marked terminal). */
  endTs?: string | null;
}

export interface NormalizedMessage {
  /** Parsed timestamp of the entry, propagated to the chat-messages.jsonl
   *  `ts` field. Falls back to "now" only when the entry has no
   *  timestamp — should never happen for real CC transcripts. */
  ts: string;
  /** The SDK-shaped message payload to write under chat-messages.jsonl
   *  `msg`. Same shape the chat-panel renderer already handles. */
  msg: Record<string, unknown>;
  /** Forwarded so callers (mirror.ts) can dedupe within a binding by
   *  transcript-entry uuid. */
  uuid: string | null;
}

/** Normalize one parsed transcript line.
 *
 *  Returns `null` for entries we skip (not pipelined content, out of
 *  window, unrecognized type). The caller MUST handle null silently. */
export function normalizeTranscriptEntry(
  raw: unknown,
  opts: NormalizeOptions = {},
): NormalizedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (!type) return null;
  if (SKIP_TYPES.has(type)) return null;

  // Only mirror entries the renderer actually knows how to render.
  if (type !== "user" && type !== "assistant" && type !== "system") return null;

  // Window gate. When the caller supplies a startTs but the entry's
  // timestamp is missing or unparseable, treat the entry as OUT of the
  // window — without this, a transcript line with a garbage timestamp
  // (e.g. a CC sentinel like `timestamp: "pending"`) would bypass the
  // gate and historical content could leak into the run's chat panel.
  const tsRaw = typeof entry.timestamp === "string" ? entry.timestamp : "";
  const ts = tsRaw ? Date.parse(tsRaw) : NaN;
  if (opts.startTs) {
    const start = Date.parse(opts.startTs);
    if (Number.isFinite(start)) {
      if (!Number.isFinite(ts)) return null;
      if (ts < start) return null;
    }
  }
  if (opts.endTs) {
    const end = Date.parse(opts.endTs);
    if (Number.isFinite(end) && Number.isFinite(ts) && ts > end) return null;
  }

  // Build the trimmed msg payload. Keep the original `type`, the
  // SDK-shaped `message`, the entry uuid, and the sessionId — the
  // renderer consults all of these. Strip CC-internal correlation
  // fields. Anything else we don't recognize: also drop, since the
  // renderer ignores it.
  const msg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (STRIP_FIELDS.has(k)) continue;
    msg[k] = v;
  }

  // Normalize sessionId → session_id so the renderer's heuristics match
  // the SDK convention. We KEEP sessionId too in case downstream code
  // still inspects it; the duplication is tiny.
  if (typeof entry.sessionId === "string" && entry.sessionId.length > 0) {
    msg.session_id = entry.sessionId;
  }

  // Filter user messages whose ONLY content block is a tool_result with
  // empty content — these get emitted by CC for housekeeping (e.g.
  // attachment ack) and add visual noise without user-facing payload.
  // We still keep tool_results that have actual content.
  if (type === "user") {
    const m = entry.message as Record<string, unknown> | undefined;
    const content = m?.content;
    if (Array.isArray(content) && content.length > 0) {
      const allEmptyToolResults = content.every((c: unknown) => {
        if (!c || typeof c !== "object") return false;
        const cb = c as Record<string, unknown>;
        if (cb.type !== "tool_result") return false;
        const inner = cb.content;
        if (inner == null) return true;
        if (typeof inner === "string" && inner.length === 0) return true;
        if (Array.isArray(inner) && inner.length === 0) return true;
        return false;
      });
      if (allEmptyToolResults) return null;
    }
  }

  const outTs = tsRaw && Number.isFinite(Date.parse(tsRaw))
    ? tsRaw
    : new Date().toISOString();
  const uuid = typeof entry.uuid === "string" ? entry.uuid : null;

  return { ts: outTs, msg, uuid };
}

/** Iterate transcript lines (one JSON object per line) and yield
 *  normalized entries in order. Silently skips malformed lines. */
export function* normalizeTranscriptText(
  text: string,
  opts: NormalizeOptions = {},
): Generator<NormalizedMessage, void, unknown> {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const normalized = normalizeTranscriptEntry(parsed, opts);
    if (normalized) yield normalized;
  }
}
