import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FilePlus2, Loader2, Save, ShieldCheck, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import {
  createStep,
  deleteEditorFile,
  fetchAiFixJob,
  fetchEditorFile,
  fetchEditorFiles,
  saveEditorFile,
  startAiFix,
  validatePipeline,
  type ValidateResult,
} from "../lib/api";
import { getScalar, parseDoc, serializeDoc, setScalar } from "../lib/editorFrontmatter";
import { durationMs } from "../lib/format";
import { useNowTick } from "../hooks/useNowTick";
import { EFFORT_KEYS, MODEL_KEYS, type AiFixJob } from "../types";

const STEP_MODELS = ["", ...MODEL_KEYS, "inherit"] as const;
const STEP_EFFORTS = ["", ...EFFORT_KEYS, "inherit"] as const;
const PERMISSION_MODES = ["", "acceptEdits", "dontAsk", "plan", "bypassPermissions", "inherit"] as const;

/** One labeled frontmatter control (select with free-text fallback via ''-prefixed custom). */
function ConfigSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  const known = options.includes(value as (typeof options)[number]);
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <select
        value={known ? value : "__custom"}
        onChange={(e) => {
          if (e.target.value === "__custom") return;
          onChange(e.target.value);
        }}
        className="appearance-none border border-accent/30 bg-panel2 px-2 py-1.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
      >
        {options.map((o) => (
          <option key={o || "(unset)"} value={o}>
            {o === "" ? "(unset)" : o}
          </option>
        ))}
        {!known && <option value="__custom">{value}</option>}
      </select>
    </label>
  );
}

function ConfigText({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="border border-accent/30 bg-panel2 px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted/50 focus:border-accent focus:outline-none"
      />
    </label>
  );
}

interface Props {
  projectId: string;
  pipelineName: string;
  pipelineRoot: string;
  onClose: () => void;
}

/** Ticking "time since" readout. Self-ticking LEAF — the 1 Hz clock re-renders
 *  this span only, not the whole editor (with its full-file textarea). */
function TickingSince({ startedAt }: { startedAt: string }) {
  const now = useNowTick(true);
  return <>{durationMs(Math.max(0, now - Date.parse(startedAt)))}</>;
}

/** The pipeline editor: pick any file of the pipeline (manifest, steps,
 *  context modules, scripts), edit it raw, save with optimistic concurrency,
 *  add steps from the designer template, and lint the whole pipeline with
 *  `pipeline plan`'s validation. */
export function EditorPanel({ projectId, pipelineName, pipelineRoot, onClose }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loadedSha, setLoadedSha] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | "validate" | "create" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "conflict"; text: string } | null>(null);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [newStepTitle, setNewStepTitle] = useState("");
  const [showNewStep, setShowNewStep] = useState(false);

  // Unsaved edits must survive page unloads the user didn't ask for: tab
  // close, back-nav, and — load-bearing — useReloadOnRestart's automatic
  // reload after a daemon handoff. The browser turns this into a native
  // "leave site?" prompt, so an upgrade can't silently drop a dirty buffer.
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  /** Shared busy/notice ceremony for every async action. A handler that needs
   *  special error handling (save's conflict branch) catches inside `fn`. */
  const withBusy = useCallback(async (kind: "load" | "save" | "validate" | "create", fn: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ kind: "err", text: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshFiles = useCallback(() => {
    fetchEditorFiles(projectId, pipelineRoot)
      .then(setFiles)
      .catch((e) => setNotice({ kind: "err", text: String(e?.message ?? e) }));
  }, [projectId, pipelineRoot]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  const openFile = useCallback(
    (path: string) =>
      void withBusy("load", async () => {
        const f = await fetchEditorFile(projectId, path);
        setCurrent(path);
        setContent(f.content);
        setLoadedSha(f.sha1);
        setDirty(false);
      }),
    [projectId, withBusy],
  );

  // Open the manifest by default.
  useEffect(() => {
    if (!current && files.length) {
      const manifest = files.find((f) => f.endsWith("PIPELINE.md")) ?? files[0];
      openFile(manifest);
    }
  }, [files, current, openFile]);

  const save = (force = false) => {
    if (!current || busy) return;
    void withBusy("save", async () => {
      try {
        const res = await saveEditorFile(projectId, current, content, force ? undefined : loadedSha);
        setLoadedSha(res.sha1);
        setDirty(false);
        setNotice({ kind: "ok", text: "Saved." });
      } catch (e) {
        const err = e as Error & { conflict?: boolean };
        if (!err.conflict) throw e;
        setNotice({
          kind: "conflict",
          text: "The file changed on disk since you loaded it. Save again to overwrite, or reopen to reload.",
        });
        setLoadedSha(undefined); // next save overwrites
      }
    });
  };

  const runValidate = () =>
    void withBusy("validate", async () => {
      setValidation(await validatePipeline(projectId, pipelineRoot));
    });

  // --- AI Fix: hand the validate issues to a background `claude -p` session,
  // poll its job, then re-validate + reload when it lands. The poll's
  // lifecycle IS the effect below: it exists exactly while fixJobId is set
  // (clearing the id on landing tears the interval down, incl. on unmount).
  const [fixModel, setFixModel] = useState("sonnet");
  const [fixJobId, setFixJobId] = useState<string | null>(null);
  const [fixJob, setFixJob] = useState<AiFixJob | null>(null);
  const fixRunning = fixJobId !== null;

  useEffect(() => {
    if (!fixJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await fetchAiFixJob(fixJobId);
        if (cancelled) return;
        setFixJob(job);
        if (job.status !== "running") {
          setFixJobId(null);
          // The session edited files on disk — refresh everything the panel
          // shows and re-lint so the issue list reflects reality.
          refreshFiles();
          if (current && !dirty) {
            void withBusy("load", async () => {
              const f = await fetchEditorFile(projectId, current);
              setContent(f.content);
              setLoadedSha(f.sha1);
            });
          }
          void withBusy("validate", async () => {
            setValidation(await validatePipeline(projectId, pipelineRoot));
          });
        }
      } catch {
        /* transient poll error — the next tick retries */
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixJobId]);

  const startFix = () => {
    if (!validation || fixRunning) return;
    const issues = [...validation.errors, ...validation.warnings];
    if (!issues.length) return;
    setNotice(null);
    setFixJob(null);
    void startAiFix(projectId, pipelineRoot, fixModel, issues)
      .then(({ job_id }) => setFixJobId(job_id))
      .catch((e) => setNotice({ kind: "err", text: String((e as Error)?.message ?? e) }));
  };

  const addStep = () => {
    if (!newStepTitle.trim() || busy) return;
    void withBusy("create", async () => {
      const res = await createStep(projectId, pipelineRoot, newStepTitle.trim());
      setNewStepTitle("");
      setShowNewStep(false);
      refreshFiles();
      openFile(res.rel);
    });
  };

  const removeCurrent = () => {
    if (!current || busy) return;
    if (!confirm(`Delete ${current}? This cannot be undone.`)) return;
    void withBusy("save", async () => {
      await deleteEditorFile(projectId, current);
      setCurrent(null);
      setContent("");
      setDirty(false);
      refreshFiles();
      setNotice({ kind: "ok", text: "Deleted." });
    });
  };

  // --- Structured config (frontmatter form) — steps + the manifest get a
  // form over the known keys; unknown keys are preserved untouched by the
  // round-trip-safe parser. The whole-file `content` stays the single source
  // of truth; the form is a projection of it.
  const isManifest = current?.endsWith("PIPELINE.md") ?? false;
  const isStep = !isManifest && (current?.includes("/steps/") ?? false) && (current?.endsWith(".md") ?? false);
  const doc = useMemo(() => parseDoc(content), [content]);
  const setKey = (key: string, value: string) => {
    setContent(serializeDoc(setScalar(doc, key, value)));
    setDirty(true);
  };
  const setBody = (body: string) => {
    setContent(serializeDoc({ ...doc, body }));
    setDirty(true);
  };

  return (
    <div className="surface flex h-full min-h-0 flex-col p-3 sm:p-4">
      <header className="mb-2 flex items-center justify-between gap-2 border-b frame-divider pb-2">
        <p className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
          ▌ EDIT · {pipelineName}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void runValidate()}
            disabled={busy !== null}
            title="Validate with pipeline plan lint"
            className="flex min-h-[32px] items-center gap-1 border border-accent/40 px-2 py-1 font-mono text-[10px] uppercase text-accent hover:bg-accent/10 disabled:opacity-40"
          >
            {busy === "validate" ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            Validate
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy !== null || !dirty || !current}
            title="Save (overwrites after a conflict warning)"
            className="flex min-h-[32px] items-center gap-1 border-2 border-accent bg-accent/15 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-accent hover:bg-accent/25 disabled:opacity-40"
          >
            {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close editor"
            className="grid h-8 w-8 place-items-center border border-accent/30 text-muted hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      </header>

      {/* File picker + add step */}
      <div className="mb-2 flex items-center gap-1.5">
        <select
          value={current ?? ""}
          onChange={(e) => {
            if (dirty && !confirm("Discard unsaved changes?")) return;
            openFile(e.target.value);
          }}
          className="min-w-0 flex-1 appearance-none border border-accent/30 bg-panel2 px-2.5 py-2 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
        >
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
              {f === current && dirty ? " *" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowNewStep((v) => !v)}
          title="Add a new step from the designer template"
          className="flex min-h-[36px] shrink-0 items-center gap-1 border border-accent/40 px-2.5 py-1.5 font-mono text-[10px] uppercase text-accent hover:bg-accent/10"
        >
          <FilePlus2 size={12} /> Step
        </button>
        <button
          type="button"
          onClick={() => void removeCurrent()}
          disabled={!current || isManifest || busy !== null}
          title={isManifest ? "The manifest cannot be deleted" : "Delete this file"}
          className="grid h-9 w-9 shrink-0 place-items-center border border-bad/40 text-bad hover:bg-bad/10 disabled:opacity-30"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {(isStep || isManifest) && (
        <div className="mb-2 grid grid-cols-2 gap-1.5 border border-accent/20 bg-panel2/40 p-2 sm:grid-cols-4">
          <ConfigSelect label="model" value={getScalar(doc, "model")} options={STEP_MODELS} onChange={(v) => setKey("model", v)} />
          <ConfigSelect label="effort" value={getScalar(doc, "effort")} options={STEP_EFFORTS} onChange={(v) => setKey("effort", v)} />
          {isStep ? (
            <>
              <ConfigText label="step_id" value={getScalar(doc, "step_id")} placeholder="(filename stem)" onChange={(v) => setKey("step_id", v)} />
              <ConfigText label="depends-on" value={getScalar(doc, "depends-on")} placeholder="[a, b]" onChange={(v) => setKey("depends-on", v)} />
            </>
          ) : (
            <>
              <ConfigSelect label="execution" value={getScalar(doc, "execution")} options={["", "sequential", "parallel"]} onChange={(v) => setKey("execution", v)} />
              <ConfigSelect label="runner" value={getScalar(doc, "runner")} options={["", "manager", "headless"]} onChange={(v) => setKey("runner", v)} />
            </>
          )}
          <ConfigSelect
            label="permission-mode"
            value={getScalar(doc, "permission-mode")}
            options={PERMISSION_MODES}
            onChange={(v) => setKey("permission-mode", v)}
          />
        </div>
      )}

      {showNewStep && (
        <div className="mb-2 flex items-center gap-1.5">
          <input
            value={newStepTitle}
            onChange={(e) => setNewStepTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addStep();
            }}
            placeholder="New step title (becomes NN-<slug>.md)"
            className="min-w-0 flex-1 border border-accent/30 bg-panel2 px-2.5 py-2 text-[11px] text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            disabled={!newStepTitle.trim() || busy !== null}
            onClick={() => void addStep()}
            className="flex min-h-[36px] shrink-0 items-center gap-1 border-2 border-accent bg-accent/15 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase text-accent disabled:opacity-40"
          >
            {busy === "create" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Create
          </button>
        </div>
      )}

      {notice && (
        <div
          className={`mb-2 border p-2 text-[11px] ${
            notice.kind === "ok"
              ? "border-good/40 bg-good/10 text-good"
              : notice.kind === "conflict"
              ? "border-warn/50 bg-warn/10 text-warn"
              : "border-bad/40 bg-bad/10 text-bad"
          }`}
        >
          {notice.text}
        </div>
      )}

      {validation && (
        <div
          className={`mb-2 border p-2 text-[11px] ${
            validation.ok ? "border-good/40 bg-good/10 text-good" : "border-bad/40 bg-bad/10 text-bad"
          }`}
        >
          <span className="flex items-center gap-1.5 font-bold">
            {validation.ok ? <Check size={12} /> : <TriangleAlert size={12} />}
            {validation.ok
              ? `plan OK — ${validation.steps.length} steps (${validation.mode})`
              : `${validation.errors.length} plan error(s)`}
          </span>
          {validation.errors.map((e, i) => (
            <div key={`e${i}`} className="mt-1">• {e}</div>
          ))}
          {validation.warnings.map((w, i) => (
            <div key={`w${i}`} className="mt-1 text-warn">⚠ {w}</div>
          ))}

          {(validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t frame-divider pt-2">
              <button
                type="button"
                onClick={startFix}
                disabled={fixRunning || busy !== null}
                title="Send these issues to a background Claude session that edits the pipeline files to fix them"
                className="flex min-h-[30px] items-center gap-1.5 border-2 border-accent2 bg-accent2/15 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-accent2 hover:bg-accent2/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {fixRunning ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {fixRunning ? "AI fixing…" : "AI fix"}
              </button>
              <select
                value={fixModel}
                onChange={(e) => setFixModel(e.target.value)}
                disabled={fixRunning}
                title="Model for the fixing session"
                className="appearance-none border border-accent/30 bg-panel2 px-2 py-1.5 font-mono text-[10px] uppercase text-ink focus:border-accent focus:outline-none disabled:opacity-40"
              >
                {MODEL_KEYS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              {fixRunning && fixJob && (
                <span className="flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-accent2">
                  <TickingSince startedAt={fixJob.started_at} />
                  <span className="relative h-1 w-24 overflow-hidden border border-accent2/40 bg-panel2">
                    <span className="shimmer absolute inset-0" aria-hidden />
                  </span>
                </span>
              )}
            </div>
          )}

          {fixJob && fixJob.status === "done" && (
            <div className="mt-2 border-t frame-divider pt-2 text-good">
              <span className="font-bold">
                ✔ AI fix finished in {fixJob.duration_ms != null ? durationMs(fixJob.duration_ms) : "—"}
                {fixJob.cost_usd != null ? ` · $${fixJob.cost_usd.toFixed(3)}` : ""} ({fixJob.model})
              </span>
              {fixJob.summary && (
                <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-ink">{fixJob.summary}</div>
              )}
            </div>
          )}
          {fixJob && fixJob.status === "failed" && (
            <div className="mt-2 border-t frame-divider pt-2 text-bad">
              ✖ AI fix failed{fixJob.error ? `: ${fixJob.error}` : ""}
            </div>
          )}
        </div>
      )}

      <textarea
        value={isStep || isManifest ? doc.body : content}
        onChange={(e) => {
          if (isStep || isManifest) setBody(e.target.value);
          else {
            setContent(e.target.value);
            setDirty(true);
          }
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            void save();
          }
        }}
        spellCheck={false}
        disabled={busy === "load" || !current}
        className="min-h-0 flex-1 resize-none border border-accent/30 bg-panel2 p-3 font-mono text-xs leading-relaxed text-ink focus:border-accent focus:outline-none disabled:opacity-50"
      />
      <p className="mt-1.5 flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-muted/70">
        <span>{dirty ? "UNSAVED CHANGES" : "SAVED"} · Ctrl+S</span>
        <span>{current ?? ""}</span>
      </p>
    </div>
  );
}
