# 01 — Retrieve candidates

## Goal

Produce a ranked list of the documentation files most relevant to
`${PP_QUESTION}`, using dependency-free BM25 retrieval over `${PP_DOCS_DIR}`, and
record it as this step's `output.candidates` for the next step to consume.

## Context

- Retrieval is done by a bundled, deterministic script — no LLM judgement, no
  network, no installs: `<pipeline-root>/scripts/bm25_retrieve.ts` (run with
  `bun`, which every plugin user has). Your run context gives you this pipeline's
  absolute root; `<pipeline-root>` below means that path.
- The script is READ-ONLY — it only reads the docs folder. Do not edit any file.
- `${PP_DOCS_DIR}` may be relative (the script resolves a relative value against
  the pipeline root, so the bundled `./sample-docs` corpus works out of the box).

## Inputs

- `${PP_QUESTION}` — the question to retrieve for.
- `${PP_DOCS_DIR}` — the docs folder to search.
- `${PP_TOP_K}` — how many candidates to return.

## Steps

1. Run the retrieval script (a single Bash command):
   `bun "<pipeline-root>/scripts/bm25_retrieve.ts" --docs "${PP_DOCS_DIR}" --question "${PP_QUESTION}" --top-k ${PP_TOP_K}`
   It prints a JSON object `{ "candidates": [ { "file", "score", "snippet" }, ... ] }`
   on stdout (scores descending; `file` is relative to the docs folder). Exit 0 =
   success; exit 2 = a bad flag or a missing docs folder.
2. Parse that JSON. Record the `candidates` array verbatim as this step's
   structured `output` under the field `candidates`, so the next step can read it
   from the run's outputs store.
3. If `candidates` is empty (the question matches no docs), still record
   `output.candidates: []` — the selection step will handle "no relevant source".

## Success Criteria

- The script exited 0 and this step's `output.candidates` holds the ranked array
  it printed (possibly empty). No files were modified.

## Next

`<pipeline-root>/steps/02-select.md`
