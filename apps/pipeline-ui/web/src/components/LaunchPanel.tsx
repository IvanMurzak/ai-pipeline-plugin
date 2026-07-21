import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileText, Keyboard, Loader2, Rocket, Search, TriangleAlert, Variable } from "lucide-react";
import { fetchLaunchPipelines, launchRun } from "../lib/api";
import { useSSE } from "../lib/sse";
import { VoiceInput } from "./VoiceInput";
import { appendDictation, modelPillClass, withInterim } from "../lib/format";
import { collectLaunchVars, filterPipelines, initialVarValues, missingRequiredVars, pipelineVariables } from "../lib/launch";
import { useClickOutside } from "../lib/useClickOutside";
import { EFFORT_KEYS, MODEL_KEYS, type LaunchCatalogPipeline } from "../types";

const MODEL_CHOICES = ["inherit", ...MODEL_KEYS] as const;
const EFFORT_CHOICES = ["inherit", ...EFFORT_KEYS] as const;

interface Props {
  projectId: string;
  /** Pre-select this pipeline (the Board's Launch CTA passes the current one). */
  initialPipelineName?: string | null;
  /** The pre-selected pipeline's root — exact match wins over the name
   *  heuristics (duplicate basenames are legal across categories/families). */
  initialPipelineRoot?: string | null;
  /** Called with the minted run_id after a successful launch. */
  onLaunched: (runId: string) => void;
}

/** The launch form: pick a pipeline, give it a task (typed, dictated, or a
 *  file reference), optionally override models per step, launch. Runs through
 *  POST /api/runs/launch → `pipeline drive` (the interactive headless runner:
 *  needs-input questions come back to the UI, answerable in place). */
export function LaunchPanel({ projectId, initialPipelineName, initialPipelineRoot, onLaunched }: Props) {
  const [catalog, setCatalog] = useState<LaunchCatalogPipeline[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(initialPipelineName ?? null);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(initialPipelineRoot ?? null);
  const [taskMode, setTaskMode] = useState<"text" | "file">("text");
  const [taskText, setTaskText] = useState("");
  const [interim, setInterim] = useState("");
  const [taskFile, setTaskFile] = useState("");
  const [defaultModel, setDefaultModel] = useState<string>("inherit");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [defaultEffort, setDefaultEffort] = useState<string>("inherit");
  const [effortOverrides, setEffortOverrides] = useState<Record<string, string>>({});
  // Declared ${PP_*} values, keyed by name. Reset to each pipeline's defaults
  // when the selection changes (the effect below).
  const [vars, setVars] = useState<Record<string, string>>({});
  const [showSteps, setShowSteps] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Bumped (debounced) whenever a pipeline file changes on disk — editor save
  // OR an external edit — so the plan catalog (steps, per-step models) tracks
  // the files without a remount. The daemon's pipeline-tree watcher broadcasts
  // file.changed and has already invalidated its server-side catalog cache.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const refreshTimer = useRef<number | null>(null);
  useSSE((msg) => {
    if (msg.type !== "file.changed") return;
    if ((msg.data as { project_id?: string } | null)?.project_id !== projectId) return;
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      setCatalogVersion((v) => v + 1);
    }, 400);
  });
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  // Blank the panel only on a project switch; a same-project refresh swaps
  // the catalog in place so the form doesn't flicker back to the loader.
  useEffect(() => {
    setCatalog(null);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    fetchLaunchPipelines(projectId)
      .then((p) => {
        if (cancelled) return;
        setCatalog(p);
        setLoadError(null);
      })
      .catch((e) => {
        // A failed BACKGROUND refresh must not replace a live launch form
        // with the fatal error panel (the daemon is briefly down during an
        // Update & Restart handoff, for example) — keep serving the last
        // good catalog and only surface the error when there is nothing
        // to show at all.
        if (!cancelled) setLoadError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, catalogVersion]);

  // Adopt the board's pipeline pick when it changes.
  useEffect(() => {
    if (initialPipelineName) {
      setSelectedName(initialPipelineName);
      setSelectedRoot(initialPipelineRoot ?? null);
    }
  }, [initialPipelineName, initialPipelineRoot]);

  const selected = useMemo(() => {
    if (!catalog) return null;
    // Root match first — pipeline NAMES from the board are folder basenames
    // and can suffix-match several catalog entries (same-named targets under
    // two hubs); the root is exact.
    if (selectedRoot) {
      const norm = selectedRoot.replaceAll("\\", "/").toLowerCase();
      const hit = catalog.find(
        (p) => p.pipeline_root.replaceAll("\\", "/").toLowerCase() === norm,
      );
      if (hit) return hit;
    }
    if (selectedName) {
      const hit = catalog.find((p) => p.name === selectedName || p.name.endsWith(`/${selectedName}`));
      if (hit) return hit;
    }
    return null;
  }, [catalog, selectedName, selectedRoot]);

  // Reset per-pipeline state when the pick changes — variables prefill with
  // the newly-selected pipeline's declared defaults.
  useEffect(() => {
    setOverrides({});
    setEffortOverrides({});
    setVars(initialVarValues(selected));
    setShowSteps(false);
    setLaunchError(null);
  }, [selected?.pipeline_root]); // eslint-disable-line react-hooks/exhaustive-deps

  // A same-project catalog refresh can change the selected pipeline's steps
  // in place (step renamed/removed on disk). Prune overrides for step_ids
  // that no longer exist — otherwise the "N overridden" count and the launch
  // request silently carry orphaned overrides while the renamed step runs on
  // the default model/effort.
  useEffect(() => {
    if (!selected) return;
    const valid = new Set(selected.steps.map((s) => s.step_id));
    const prune = (prev: Record<string, string>) => {
      const entries = Object.entries(prev).filter(([k]) => valid.has(k));
      return entries.length === Object.keys(prev).length
        ? prev
        : Object.fromEntries(entries);
    };
    setOverrides(prune);
    setEffortOverrides(prune);
    // Reconcile variables against the refreshed declarations: keep edited
    // values, add newly-declared vars at their default, drop removed ones.
    setVars((prev) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const v of pipelineVariables(selected)) {
        next[v.name] = Object.prototype.hasOwnProperty.call(prev, v.name) ? prev[v.name] : v.default ?? "";
        if (next[v.name] !== prev[v.name]) changed = true;
      }
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [selected]);

  const missingRequired = useMemo(() => missingRequiredVars(selected, vars), [selected, vars]);

  const canLaunch =
    !!selected &&
    !launching &&
    selected.errors.length === 0 &&
    selected.steps.length > 0 &&
    missingRequired.length === 0 &&
    (taskMode === "text" || taskFile.trim() !== "");

  const doLaunch = async () => {
    if (!selected || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const modelOverrides: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (v && v !== "keep") modelOverrides[k] = v;
      }
      const effortOv: Record<string, string> = {};
      for (const [k, v] of Object.entries(effortOverrides)) {
        if (v && v !== "keep") effortOv[k] = v;
      }
      const launchVars = collectLaunchVars(selected, vars);
      const res = await launchRun({
        project_id: projectId,
        pipeline_root: selected.pipeline_root,
        ...(taskMode === "text" && taskText.trim() ? { task_text: taskText.trim() } : {}),
        ...(taskMode === "file" && taskFile.trim() ? { task_file: taskFile.trim() } : {}),
        ...(defaultModel !== "inherit" ? { default_model: defaultModel } : {}),
        ...(Object.keys(modelOverrides).length ? { model_overrides: modelOverrides } : {}),
        ...(defaultEffort !== "inherit" ? { default_effort: defaultEffort } : {}),
        ...(Object.keys(effortOv).length ? { effort_overrides: effortOv } : {}),
        ...(launchVars ? { vars: launchVars } : {}),
      });
      onLaunched(res.run_id);
    } catch (e) {
      setLaunchError(String((e as Error)?.message ?? e));
    } finally {
      setLaunching(false);
    }
  };

  // The fatal panel only when there is no catalog to show — a background
  // refresh failure keeps the last good catalog rendered.
  if (loadError && !catalog) {
    return (
      <div className="surface flex h-full items-center justify-center p-6 text-center text-xs text-bad">
        Couldn't load pipelines: {loadError}
      </div>
    );
  }
  if (!catalog) {
    return (
      <div className="surface flex h-full items-center justify-center p-6 text-xs text-muted">
        <Loader2 size={14} className="mr-2 animate-spin" /> Loading pipelines…
      </div>
    );
  }

  return (
    <div className="surface flex h-full min-h-0 flex-col overflow-y-auto p-3 sm:p-4">
      <h3 className="mb-3 flex items-center gap-2 font-display text-xs font-bold uppercase tracking-[0.18em] text-accent">
        <Rocket size={13} /> Launch a run
      </h3>

      {/* Pipeline picker — searchable combobox (type to filter) */}
      <label className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Pipeline</label>
      <PipelineCombobox
        catalog={catalog}
        selected={selected}
        onSelect={(p) => {
          setSelectedName(p?.name ?? null);
          setSelectedRoot(p?.pipeline_root ?? null);
        }}
      />

      {selected && selected.errors.length > 0 && (
        <div className="mb-3 border border-bad/40 bg-bad/10 p-2.5 text-[11px] text-bad">
          <span className="flex items-center gap-1.5 font-bold">
            <TriangleAlert size={12} /> plan errors — fix before launching
          </span>
          <ul className="mt-1 list-inside list-disc">
            {selected.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Task input */}
      <div className="mb-1 flex items-center justify-between">
        <label className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Task</label>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setTaskMode("text")}
            className={`flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] uppercase ${
              taskMode === "text" ? "border-accent text-accent" : "border-accent/25 text-muted"
            }`}
          >
            <Keyboard size={11} /> Text
          </button>
          <button
            type="button"
            onClick={() => setTaskMode("file")}
            className={`flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] uppercase ${
              taskMode === "file" ? "border-accent text-accent" : "border-accent/25 text-muted"
            }`}
          >
            <FileText size={11} /> File
          </button>
        </div>
      </div>
      {taskMode === "text" ? (
        <div className="relative mb-3">
          <textarea
            value={withInterim(taskText, interim)}
            onChange={(e) => {
              setTaskText(e.target.value);
              setInterim("");
            }}
            rows={4}
            placeholder="Describe the task (optional for self-contained pipelines) — type or dictate…"
            className="w-full resize-y border border-accent/30 bg-panel2 p-3 pr-12 text-xs leading-relaxed text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
          />
          <div className="absolute bottom-2 right-2">
            <VoiceInput
              onTranscript={(t) => setTaskText((prev) => appendDictation(prev, t))}
              onInterim={setInterim}
              disabled={launching}
            />
          </div>
        </div>
      ) : (
        <input
          value={taskFile}
          onChange={(e) => setTaskFile(e.target.value)}
          placeholder="Absolute path to a task file (e.g. C:\\work\\issue-42.md)"
          className="mb-3 w-full border border-accent/30 bg-panel2 px-3 py-2.5 font-mono text-xs text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
        />
      )}

      {/* Variables — declared ${PP_*} the run substitutes, prefilled with
          their defaults. All PP_* values are non-secret by contract. */}
      {selected && pipelineVariables(selected).length > 0 && (
        <div className="mb-3">
          <label className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            <Variable size={11} /> Variables
          </label>
          <div className="flex flex-col gap-2.5 border border-accent/20 bg-panel2/40 p-3">
            {pipelineVariables(selected).map((v) => {
              const value = vars[v.name] ?? "";
              const isMissing = v.required && !value.trim();
              return (
                <div key={v.name} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px] text-ink">{v.name}</span>
                    <span
                      className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${
                        v.required ? "text-accent2" : "text-muted/70"
                      }`}
                    >
                      {v.required ? "required" : "optional"}
                    </span>
                  </div>
                  {v.description && (
                    <span className="font-mono text-[9.5px] leading-snug text-muted">{v.description}</span>
                  )}
                  <input
                    value={value}
                    onChange={(e) => setVars((prev) => ({ ...prev, [v.name]: e.target.value }))}
                    placeholder={
                      v.required
                        ? `Set ${v.name}…`
                        : v.default != null
                          ? `default: ${v.default || "(empty)"}`
                          : `Set ${v.name} (optional)…`
                    }
                    aria-label={v.name}
                    aria-required={v.required}
                    className={`w-full border bg-panel2 px-3 py-2 font-mono text-xs text-ink placeholder:text-muted/60 focus:outline-none ${
                      isMissing ? "border-accent2/60 focus:border-accent2" : "border-accent/30 focus:border-accent"
                    }`}
                  />
                </div>
              );
            })}
          </div>
          {missingRequired.length > 0 && (
            <p className="mt-1 font-mono text-[9.5px] text-accent2">
              fill required variable{missingRequired.length > 1 ? "s" : ""}: {missingRequired.join(", ")}
            </p>
          )}
        </div>
      )}

      {/* Models */}
      <label className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Default model</label>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {MODEL_CHOICES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setDefaultModel(m)}
            className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide ${
              defaultModel === m ? "border-accent bg-accent/15 text-accent" : "border-accent/25 text-muted hover:text-ink"
            }`}
          >
            {m === "inherit" ? "session" : m}
          </button>
        ))}
      </div>

      {/* Reasoning effort — same inherit-or-pin ladder as the model. */}
      <label className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Default effort</label>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {EFFORT_CHOICES.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setDefaultEffort(e)}
            className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide ${
              defaultEffort === e ? "border-accent2 bg-accent2/15 text-accent2" : "border-accent/25 text-muted hover:text-ink"
            }`}
            title={e === "inherit" ? "Use the session's effort level" : `Pin reasoning effort: ${e}`}
          >
            {e === "inherit" ? "session" : e}
          </button>
        ))}
      </div>

      {selected && selected.steps.length > 0 && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowSteps((v) => !v)}
            className="flex w-full items-center justify-between border border-accent/25 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted hover:text-accent"
          >
            <span>
              Per-step models &amp; effort ({selected.steps.length} steps
              {(() => {
                const n = new Set([
                  ...Object.keys(overrides).filter((k) => overrides[k] && overrides[k] !== "keep"),
                  ...Object.keys(effortOverrides).filter((k) => effortOverrides[k] && effortOverrides[k] !== "keep"),
                ]).size;
                return n ? `, ${n} overridden` : "";
              })()}
              )
            </span>
            <ChevronDown size={13} className={`transition-transform ${showSteps ? "rotate-180" : ""}`} />
          </button>
          {showSteps && (
            <div className="border border-t-0 border-accent/25">
              {selected.steps.map((s) => (
                <div
                  key={s.step_id}
                  className="flex items-center justify-between gap-2 border-b border-accent/10 px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px] text-ink">{s.step_id}</div>
                    <div className="font-mono text-[9px] text-muted">
                      configured:{" "}
                      <span className={s.model ? modelPillClass(s.model) : ""}>{s.model ?? "inherit"}</span>
                      {s.effort ? <span className="text-accent2"> ⚡{s.effort}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <select
                      value={overrides[s.step_id] ?? "keep"}
                      onChange={(e) => setOverrides((o) => ({ ...o, [s.step_id]: e.target.value }))}
                      title="Model override for this step"
                      className="appearance-none border border-accent/30 bg-panel2 px-2 py-1.5 font-mono text-[10px] text-ink focus:border-accent focus:outline-none"
                    >
                      <option value="keep">keep</option>
                      {MODEL_CHOICES.map((m) => (
                        <option key={m} value={m}>
                          {m === "inherit" ? "session default" : m}
                        </option>
                      ))}
                    </select>
                    <select
                      value={effortOverrides[s.step_id] ?? "keep"}
                      onChange={(e) => setEffortOverrides((o) => ({ ...o, [s.step_id]: e.target.value }))}
                      title="Reasoning-effort override for this step"
                      className="appearance-none border border-accent2/30 bg-panel2 px-2 py-1.5 font-mono text-[10px] text-ink focus:border-accent2 focus:outline-none"
                    >
                      <option value="keep">⚡keep</option>
                      {EFFORT_CHOICES.map((e) => (
                        <option key={e} value={e}>
                          {e === "inherit" ? "⚡session" : `⚡${e}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {launchError && (
        <div className="mb-3 border border-bad/40 bg-bad/10 p-2.5 text-[11px] text-bad">{launchError}</div>
      )}

      <button
        type="button"
        disabled={!canLaunch}
        onClick={() => void doLaunch()}
        className="mt-auto flex min-h-[44px] w-full items-center justify-center gap-2 border-2 border-accent bg-accent/15 py-2.5 font-display text-xs font-bold uppercase tracking-[0.2em] text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {launching ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
        {launching ? "Launching…" : "Launch"}
      </button>
      <p className="mt-2 text-center font-mono text-[9px] uppercase tracking-wider text-muted/70">
        headless `pipeline drive` — questions from the run come back here
      </p>
    </div>
  );
}

/** Searchable pipeline picker: an input that filters the option list as you
 *  type (every whitespace-separated term must match name or end-state).
 *  Arrow keys + Enter select; Escape closes; clicking outside closes. */
function PipelineCombobox({
  catalog,
  selected,
  onSelect,
}: {
  catalog: LaunchCatalogPipeline[];
  selected: LaunchCatalogPipeline | null;
  onSelect: (p: LaunchCatalogPipeline | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open);

  const filtered = useMemo(() => filterPipelines(catalog, query), [catalog, query]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const pick = (p: LaunchCatalogPipeline) => {
    onSelect(p);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative mb-3" ref={rootRef}>
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-3 text-muted" />
        <input
          ref={inputRef}
          value={open ? query : selected?.name ?? ""}
          placeholder={selected ? selected.name : `Search ${catalog.length} pipelines…`}
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setHighlight(0);
          }}
          onChange={(e) => {
            if (!open) setOpen(true);
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
              setOpen(true);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const p = filtered[highlight];
              if (p) pick(p);
            } else if (e.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
          role="combobox"
          aria-expanded={open}
          aria-label="Pipeline"
          className="w-full border border-accent/30 bg-panel2 py-2.5 pl-8 pr-8 font-mono text-xs text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
        />
        <ChevronDown
          size={14}
          className={`pointer-events-none absolute right-2.5 top-3 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </div>
      {open && (
        <ul
          ref={listRef}
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto border border-accent/50 bg-panel shadow-card"
        >
            {filtered.length === 0 && (
              <li className="px-3 py-4 text-center font-mono text-[10px] uppercase tracking-wider text-muted">
                no pipeline matches “{query}”
              </li>
            )}
            {filtered.map((p, i) => (
              <li key={p.pipeline_root}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(p)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left font-mono transition-colors ${
                    i === highlight ? "bg-accent/15" : ""
                  } ${p.name === selected?.name ? "text-accent" : "text-ink"}`}
                >
                  <span className="flex items-center gap-1.5 text-[11.5px]">
                    <span className="truncate">{p.name}</span>
                    {p.errors.length > 0 && (
                      <TriangleAlert size={11} className="shrink-0 text-bad" aria-label="plan errors" />
                    )}
                  </span>
                  {p.end_state && (
                    <span className="truncate text-[10px] text-muted">{p.end_state}</span>
                  )}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
