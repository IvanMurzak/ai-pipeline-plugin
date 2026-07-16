/** Fold slash-separated pipeline names (workflows/beta, alpha/targets/ios)
 *  into a folder tree. A node can be BOTH a pipeline and a folder — a target
 *  family hub (alpha) is launchable itself while hosting targets/<name>
 *  sub-pipelines below it. */

export interface PipelineTreeNode {
  /** Last path segment — the display label. */
  seg: string;
  /** Full slash path of this node. */
  path: string;
  /** The pipeline_name when this node IS a pipeline, else null (pure folder). */
  pipeline: string | null;
  children: PipelineTreeNode[];
}

/** Input: the pipeline's slash path (its on-disk location under
 *  .claude/pipeline/) + the pipeline_name used for selection. Passing a plain
 *  string keeps the legacy behavior (path IS the name). */
export type PipelineTreeItem = string | { path: string; name: string };

export function buildPipelineTree(items: PipelineTreeItem[]): PipelineTreeNode[] {
  const roots: PipelineTreeNode[] = [];
  const byPath = new Map<string, PipelineTreeNode>();
  const nodeFor = (path: string, seg: string, parent: PipelineTreeNode[] | null): PipelineTreeNode => {
    let n = byPath.get(path);
    if (!n) {
      n = { seg, path, pipeline: null, children: [] };
      byPath.set(path, n);
      (parent ?? roots).push(n);
    }
    return n;
  };
  const normalized = items
    .map((it) => (typeof it === "string" ? { path: it, name: it } : it))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const { path: itemPath, name } of normalized) {
    const segs = itemPath.split("/").filter(Boolean);
    let parent: PipelineTreeNode[] | null = null;
    let path = "";
    let node: PipelineTreeNode | null = null;
    for (const seg of segs) {
      path = path ? `${path}/${seg}` : seg;
      node = nodeFor(path, seg, parent);
      parent = node.children;
    }
    if (node) node.pipeline = name;
  }
  const sortRec = (nodes: PipelineTreeNode[]): void => {
    // Folders (have children) first, then plain pipelines; alphabetical inside.
    nodes.sort((a, b) => Number(b.children.length > 0) - Number(a.children.length > 0) || a.seg.localeCompare(b.seg));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** Count pipelines under a node (itself included when it is one). */
export function pipelinesUnder(node: PipelineTreeNode): number {
  return (node.pipeline ? 1 : 0) + node.children.reduce((acc, c) => acc + pipelinesUnder(c), 0);
}
