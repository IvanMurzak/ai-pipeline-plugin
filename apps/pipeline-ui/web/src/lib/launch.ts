import type { LaunchCatalogPipeline } from "../types";

/**
 * Type-to-filter for the launch combobox. Splits the query on whitespace and
 * keeps pipelines whose name or end-state contains EVERY term
 * (case-insensitive) — so "unreal install" narrows to
 * "unreal-cli-install-extension" without demanding the exact hyphenation.
 */
export function filterPipelines(
  catalog: LaunchCatalogPipeline[],
  query: string,
): LaunchCatalogPipeline[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return catalog;
  return catalog.filter((p) => {
    const hay = `${p.name} ${p.end_state ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
