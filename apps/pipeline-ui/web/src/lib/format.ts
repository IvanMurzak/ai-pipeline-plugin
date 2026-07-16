export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Elapsed wall-clock between two ISO stamps (open end = now), rendered via
 *  the one canonical duration format below. */
export function elapsed(fromIso: string, toIso: string | null): string {
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : Date.now();
  return durationMs(b - a);
}

/** THE duration format: 42s · 7m 05s · 3h 12m. Everything that renders a
 *  span of time (run elapsed, step chips, AI-fix timer) goes through this. */
export function durationMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, "0")}m`;
}

export function pipelineNameFromIterationPath(p: string | null | undefined): string | null {
  if (!p) return null;
  // Handles both flat (.claude/pipeline/<name>/steps/) and category-nested
  // (.claude/pipeline/<category>/<name>/steps/) layouts. We always take the
  // last directory component immediately preceding /steps/ as the pipeline
  // name — that matches what scanPipelines uses for pipeline_name.
  const norm = p.replaceAll("\\", "/");
  const m = norm.match(/\/([^/]+)\/steps\//);
  return m ? m[1] : null;
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function iterationLabel(p: string | null | undefined): string {
  if (!p) return "—";
  const norm = p.replaceAll("\\", "/");
  const tail = norm.slice(norm.lastIndexOf("/") + 1);
  return tail.replace(/\.md$/, "");
}

// Parse the leading numeric token of an iteration filename, e.g.
// "01-count-files.md" → "01", "03a-review.md" → "03a", anything weird → null.
export function iterationIndexFromPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const norm = p.replaceAll("\\", "/");
  const tail = norm.slice(norm.lastIndexOf("/") + 1);
  const m = tail.match(/^(\d+[a-zA-Z]?)[-_.]/);
  return m ? m[1] : null;
}

// Tailwind class string for a model pill — matches the shape of the
// existing per-step badges (rounded-full + px-1.5 + py-px on a tinted
// background). Only the colour tokens differ per known tier:
//   haiku  → `good`    (green;  the cheapest tier)
//   sonnet → `accent2` (mint cyan; the project's closest-to-blue token)
//   opus   → `accent`  (electric violet; the project's purple token)
//   fable  → `warn`    (amber; the newest tier)
// A value that is present but NOT a known alias (e.g. a canonical
// `claude-*` id) gets a NEUTRAL pill so it still renders with a chip —
// the daemon must never coerce a valid value to "no badge". null /
// undefined / empty returns "" — callers MUST check the result before
// rendering so they can skip the wrapper entirely (no "default" pill).
export function modelPillClass(
  model: string | null | undefined,
): string {
  const base = "rounded-full px-1.5 py-px font-medium";
  switch (model) {
    case "haiku":
      return `${base} bg-good/15 text-good`;
    case "sonnet":
      return `${base} bg-accent2/15 text-accent2`;
    case "opus":
      return `${base} bg-accent/15 text-accent`;
    case "fable":
      return `${base} bg-warn/15 text-warn`;
    default:
      // null / undefined / empty → no pill; any other present value (a
      // canonical id / future tier) → neutral pill so it still shows.
      return model ? `${base} bg-muted/15 text-muted` : "";
  }
}

// Model name suitable for display, or null when the model is absent. The
// known aliases render lowercase; any other present value (a canonical
// `claude-*` id) is returned VERBATIM so it displays as-is rather than
// vanishing. Kept separate from modelPillClass so callers that need text
// without a pill (e.g. inline "model: opus" footer copy) don't have to
// re-narrow the union themselves.
export function modelLabel(
  model: string | null | undefined,
): string | null {
  if (!model) return null;
  const t = model.trim();
  return t.length > 0 ? t : null;
}

/** Append a dictated chunk to a field with a single separating space —
 *  shared by every voice-input consumer (task composer, answer box). */
export function appendDictation(prev: string, chunk: string): string {
  return (prev && !prev.endsWith(" ") ? prev + " " : prev) + chunk;
}

/** Live field value while an interim (browser-engine) transcription is in
 *  flight; identical to the committed value once the interim clears. */
export function withInterim(value: string, interim: string): string {
  return interim ? appendDictation(value, interim) : value;
}

// Stable signature for an event used for client-side de-duplication. Two
// events with the same ts + type + project + run + iteration_path are
// treated as the same event whether they arrived via the initial REST
// snapshot or the SSE stream.
export function eventSignature(e: {
  ts: string;
  type: string;
  run_id?: string | null;
  _project_id?: string;
  data?: Record<string, unknown>;
}): string {
  const iter =
    (e.data && (e.data.iteration_path as string | undefined)) ?? "";
  return `${e._project_id ?? ""}|${e.ts}|${e.type}|${e.run_id ?? ""}|${iter}`;
}
