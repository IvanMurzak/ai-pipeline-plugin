# 02 — Select the best source

## Goal

From the retrieved candidates, choose the SINGLE best source file to ground an
answer to `${PP_QUESTION}`, and record that choice with a brief rationale.

## Context

- The previous step (`01-retrieve`) recorded a ranked candidate list as its
  output. Read it from the run's outputs store:
  `<pipeline-root>/.runtime/<run-id>/outputs/01-retrieve.json` — the `candidates`
  array (equivalently `${steps.01-retrieve.output.candidates}`). Your run context
  provides `<run-id>` and this pipeline's absolute root.
- BM25 ranks by term overlap; the top hit is not always the best fit, which is
  exactly why a reading step follows retrieval. Read the candidates and judge.
- READ-ONLY: read files only; never modify anything.

## Inputs

- The `candidates` array from `01-retrieve` (`file`, `score`, `snippet` each).
- `${PP_DOCS_DIR}` — the docs folder; each candidate `file` is relative to it.
- `${PP_QUESTION}` — the question the source must be able to answer.

## Steps

1. Read the `candidates`. If it is empty, record `output.selected: null` with a
   one-line note that no local doc matched, and proceed (the answer step will say
   the docs do not cover the question).
2. Otherwise open the top few candidate files (resolve each `file` against
   `${PP_DOCS_DIR}`) and read the passages around their snippets.
3. Pick the ONE file whose content best and most directly answers
   `${PP_QUESTION}`. Prefer a direct, on-topic source over a merely
   high-BM25-score one.
4. Record this step's `output`: `selected` (the chosen `file`, relative to the
   docs folder) and `reason` (one sentence on why it was chosen).

## Success Criteria

- `output.selected` is exactly one candidate `file` (or `null` when there were no
  candidates), with a one-sentence `reason`. No files were modified.

## Next

`<pipeline-root>/steps/03-answer.md`
