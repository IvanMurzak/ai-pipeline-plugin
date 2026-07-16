import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Pencil, Rocket, Workflow } from "lucide-react";
import { buildPipelineTree, pipelinesUnder, type PipelineTreeNode } from "../lib/pipelineTree";
import { flattenRuns, isActive } from "../lib/runs";
import type { PipelineInfo, RunState } from "../types";

// v2 semantics: an entry means "toggled AGAINST the default" (categories
// default open, targets/ folders default closed). The pre-0.68 key
// ("pipeline-ui-tree-expanded", entry = open) is deliberately abandoned —
// reusing it would reinterpret every saved entry with the opposite meaning.
const EXPANDED_KEY = "pipeline-ui-tree-toggles";

interface Props {
  pipelines: PipelineInfo[];
  runs: RunState[];
  selectedPipelineRoot: string | null;
  onSelect: (name: string, root?: string | null) => void;
  onLaunch: (name: string, root?: string | null) => void;
  onEdit: (name: string, root: string) => void;
}

/** The Pipelines tab: category folders as a collapsible tree (workflows/,
 *  targets/, …) mirroring the on-disk layout, with per-pipeline run counters
 *  and inline ▶ Launch / ✎ Edit actions. */
export function PipelineTree({ pipelines, runs, selectedPipelineRoot, onSelect, onLaunch, onEdit }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
    return new Set();
  });
  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Nest by the real on-disk location (category folders, targets/<name>)
  // instead of the flat pipeline_name — duplicate basenames in different
  // categories stay distinct rows and family targets group under their hub.
  const items = useMemo(
    () =>
      pipelines.map((p) => {
        const m = p.pipeline_root.replaceAll("\\", "/").match(/\/\.claude\/pipeline\/(.+)$/);
        return { path: m ? m[1] : p.pipeline_name, name: p.pipeline_name, root: p.pipeline_root };
      }),
    [pipelines],
  );
  const tree = useMemo(() => buildPipelineTree(items), [items]);
  const rootByPath = useMemo(() => new Map(items.map((it) => [it.path, it.root])), [items]);
  const counts = useMemo(() => {
    const m = new Map<string, { active: number; total: number }>();
    for (const r of flattenRuns(runs)) {
      if (!r.pipeline_name) continue;
      const c = m.get(r.pipeline_name) ?? { active: 0, total: 0 };
      c.total++;
      if (isActive(r.status)) c.active++;
      m.set(r.pipeline_name, c);
    }
    return m;
  }, [runs]);

  if (!pipelines.length) {
    return (
      <div className="surface flex h-full items-center justify-center p-6 text-center text-xs text-muted">
        No pipelines yet — run /pipeline:design in this project.
      </div>
    );
  }

  const renderNode = (node: PipelineTreeNode, depth: number): React.ReactNode => {
    const isFolder = node.children.length > 0;
    // Category folders default OPEN (they ARE the navigation); a family's
    // targets/ folder defaults CLOSED (can hold dozens of targets). The
    // persisted set stores the user's toggles AGAINST those defaults.
    const defaultOpen = node.seg !== "targets";
    const open = isFolder && (expanded.has(node.path) ? !defaultOpen : defaultOpen);
    const pad = { paddingLeft: `${8 + depth * 14}px` };
    const c = node.pipeline ? counts.get(node.pipeline) : undefined;
    const nodeRoot = node.pipeline ? rootByPath.get(node.path) ?? null : null;
    // Selection compares ROOTS — names collide across categories/families.
    const selected =
      nodeRoot !== null &&
      selectedPipelineRoot !== null &&
      nodeRoot.replaceAll("\\", "/").toLowerCase() ===
        selectedPipelineRoot.replaceAll("\\", "/").toLowerCase();

    return (
      <div key={node.path}>
        <div
          style={pad}
          className={`group flex min-h-[44px] items-center gap-1.5 border-b border-accent/10 pr-1.5 transition-colors ${
            selected ? "bg-accent/10" : "hover:bg-accent/5"
          }`}
        >
          {isFolder ? (
            <button
              type="button"
              onClick={() => toggle(node.path)}
              aria-expanded={open}
              className="grid h-6 w-6 shrink-0 place-items-center text-muted hover:text-accent"
            >
              <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
            </button>
          ) : (
            <span className="w-6 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => {
              if (node.pipeline) onSelect(node.pipeline, nodeRoot);
              else toggle(node.path);
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
          >
            {isFolder ? (
              open ? (
                <FolderOpen size={13} className="shrink-0 text-accent2" />
              ) : (
                <Folder size={13} className="shrink-0 text-accent2" />
              )
            ) : (
              <Workflow size={13} className={`shrink-0 ${selected ? "text-accent" : "text-muted"}`} />
            )}
            <span
              className={`truncate font-mono text-xs ${
                node.pipeline ? (selected ? "text-accent" : "text-ink") : "text-muted"
              }`}
            >
              {node.seg}
            </span>
            {node.pipeline && c && (
              <span className="shrink-0 font-mono text-[9px] text-muted">
                {c.active > 0 ? <span className="text-accent">{c.active}▶ </span> : null}
                {c.total}
              </span>
            )}
            {!node.pipeline && (
              <span className="shrink-0 font-mono text-[9px] text-muted/60">{pipelinesUnder(node)}</span>
            )}
          </button>
          {node.pipeline && (
            <span className="flex shrink-0 items-center gap-1 opacity-70 group-hover:opacity-100">
              <button
                type="button"
                title="Launch this pipeline"
                onClick={() => onLaunch(node.pipeline!, nodeRoot)}
                className="grid h-7 w-7 place-items-center border border-accent/30 text-accent hover:bg-accent/15"
              >
                <Rocket size={11} />
              </button>
              <button
                type="button"
                title="Edit this pipeline's files"
                onClick={() => {
                  const root = rootByPath.get(node.path);
                  if (root) onEdit(node.pipeline!, root);
                }}
                className="grid h-7 w-7 place-items-center border border-accent/25 text-muted hover:text-accent"
              >
                <Pencil size={11} />
              </button>
            </span>
          )}
        </div>
        {isFolder && open && <div>{node.children.map((ch) => renderNode(ch, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <div className="surface h-full overflow-y-auto">
      {tree.map((n) => renderNode(n, 0))}
    </div>
  );
}
