import type { LaunchCatalogPipeline, LaunchCatalogVariable } from "../types";

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

// --- Launch-time ${PP_*} variables ----------------------------------------

/** A pipeline's declared variables, defensively (`?? []`) — pre-variable
 *  daemons omit the field entirely. */
export function pipelineVariables(pipeline: LaunchCatalogPipeline | null): LaunchCatalogVariable[] {
  return pipeline?.variables ?? [];
}

/** Initial form values for a pipeline's variables: each input starts prefilled
 *  with its declared default ("" when it has none — required vars, or an
 *  optional var with no default). An empty-string default is preserved. */
export function initialVarValues(pipeline: LaunchCatalogPipeline | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of pipelineVariables(pipeline)) out[v.name] = v.default ?? "";
  return out;
}

/** The launch payload's `vars` map: every DECLARED variable whose current
 *  value is non-empty. Empty inputs are dropped so an untouched optional
 *  variable falls back to its declared default at run init (backward compat:
 *  no value ⇒ no `--var` ⇒ default applies). Values are sent verbatim (spaces
 *  and all). Returns undefined when nothing is set, so the request omits the
 *  field entirely for a defaults-only launch. */
export function collectLaunchVars(
  pipeline: LaunchCatalogPipeline | null,
  values: Record<string, string>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const v of pipelineVariables(pipeline)) {
    const val = values[v.name];
    if (val !== undefined && val !== "") out[v.name] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Names of REQUIRED variables the operator has left empty — the launch button
 *  stays disabled until each is filled (required vars can't fall back to a
 *  default; D1.2). */
export function missingRequiredVars(
  pipeline: LaunchCatalogPipeline | null,
  values: Record<string, string>,
): string[] {
  return pipelineVariables(pipeline)
    .filter((v) => v.required && !(values[v.name] ?? "").trim())
    .map((v) => v.name);
}
