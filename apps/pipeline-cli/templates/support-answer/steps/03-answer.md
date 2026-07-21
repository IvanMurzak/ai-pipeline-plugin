# 03 — Answer with a citation

## Goal

Compose a concise, accurate answer to `${PP_QUESTION}` grounded ONLY in the
source file selected by the previous step, ending with a citation to that file.

## Context

- The previous step (`02-select`) recorded the chosen source. Read it from the
  run's outputs store: `<pipeline-root>/.runtime/<run-id>/outputs/02-select.json`
  — the `selected` file (relative to `${PP_DOCS_DIR}`) and the `reason`. Your run
  context provides `<run-id>` and this pipeline's absolute root.
- Ground the answer strictly in that one file. Do NOT use outside knowledge and
  do NOT pull facts from other docs — this keeps the answer faithful and citable.
- READ-ONLY: read the source file; never modify anything.

## Inputs

- `output.selected` from `02-select` (the source file, or `null`).
- `${PP_QUESTION}` — the question to answer.
- `${PP_DOCS_DIR}` — the docs folder the selected `file` is relative to.

## Steps

1. If `selected` is `null`, answer that the local documentation does not cover
   `${PP_QUESTION}`, and stop (no citation to invent).
2. Otherwise read the full selected file (resolve `selected` against
   `${PP_DOCS_DIR}`).
3. Write a concise answer (a short paragraph, or a few steps) to `${PP_QUESTION}`
   using only facts stated in that file. If the file does not actually answer the
   question, say so plainly rather than guessing.
4. End with a citation line naming the source, exactly:
   `Source: <selected file path>`.

## Success Criteria

- The answer addresses `${PP_QUESTION}` using only the selected source and ends
  with a `Source: <path>` citation (or a clear "not covered" message when there
  was no source). No files were modified.

## Next

Pipeline complete.
