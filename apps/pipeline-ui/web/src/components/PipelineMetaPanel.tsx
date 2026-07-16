import { motion } from "framer-motion";
import { FileCode, FolderTree, Info, Pencil, Play } from "lucide-react";
import type { ModelValue, PipelineInfo } from "../types";
import { modelLabel, modelPillClass } from "../lib/format";
import { Markdown } from "./Markdown";
import { HudCorners } from "./HudFrame";

interface Props {
  pipeline: PipelineInfo;
  /** Optional handler — when wired, renders a "Launch" CTA that opens the launch form. */
  onLaunch?: () => void;
  /** Optional handler — when wired, renders an "Edit" CTA that opens the editor. */
  onEdit?: () => void;
  /** Pipeline-level model override from the most recent pipeline.started
   *  event (schema v3+). null when no run for this pipeline has set one.
   *  May be an alias OR a canonical `claude-*` id. */
  defaultModel?: ModelValue | null;
}

export function PipelineMetaPanel({ pipeline, onLaunch, onEdit, defaultModel }: Props) {
  const excerpt = pipeline.manifest_excerpt?.trim() ?? null;
  const stepsCount = pipeline.iterations.length;
  const defaultModelLabel = modelLabel(defaultModel);
  const defaultModelPill = modelPillClass(defaultModel);

  return (
    <motion.section
      key={pipeline.pipeline_name}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="surface flex min-h-[140px] flex-col gap-3 p-5 text-accent"
    >
      <HudCorners />
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            <Info size={11} /> ▌ MANIFEST
          </p>
          <h3 className="mt-1 truncate font-display text-base font-bold uppercase tracking-[0.12em] text-ink">
            {pipeline.pipeline_name}
          </h3>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10.5px]">
          {defaultModelLabel && (
            <span className={`${defaultModelPill}`}>
              default: {defaultModelLabel}
            </span>
          )}
          {onLaunch && stepsCount > 0 && (
            <button
              onClick={onLaunch}
              className="
                relative flex items-center gap-1.5 border-2 border-accent bg-canvas/60
                px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-accent
                transition-all hover:bg-accent hover:text-canvas
              "
            >
              <Play size={11} /> LAUNCH
            </button>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              title="Edit this pipeline's files"
              className="
                relative flex items-center gap-1.5 border border-accent/50 bg-canvas/60
                px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-accent
                transition-all hover:bg-accent/15
              "
            >
              <Pencil size={11} /> EDIT
            </button>
          )}
          <div className="flex items-center gap-1.5 border border-line/40 bg-canvas/50 px-2 py-1 text-[10px] uppercase tracking-wider text-muted">
            <FileCode size={11} /> {stepsCount} {stepsCount === 1 ? "STEP" : "STEPS"}
          </div>
        </div>
      </header>

      {pipeline.end_state && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            ▌ END_STATE
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink/90">{pipeline.end_state}</p>
        </div>
      )}

      {excerpt && excerpt !== pipeline.end_state && (
        <div className="border border-accent/20 bg-panel2/40 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            <FolderTree size={11} /> ▌ EXCERPT
          </p>
          <div className="max-h-40 overflow-y-auto pr-1">
            <Markdown size="sm">{excerpt}</Markdown>
          </div>
        </div>
      )}

      <p className="break-all font-mono text-[10px] text-muted/70">
        › {pipeline.pipeline_root}
      </p>
    </motion.section>
  );
}
