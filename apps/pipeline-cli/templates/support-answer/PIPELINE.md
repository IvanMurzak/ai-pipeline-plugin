# Pipeline: support-answer

## End State

A concise answer to the user's question, grounded in a local folder of docs and
citing the source file it came from.

## Scope

In:
- BM25 retrieval over a local docs folder (read-only), agent selection of the
  best source, and a cited answer.

Out:
- Writing to the docs or the user's code, network calls, and multi-source
  synthesis (one answer, one source).

## Project Context

- Root: the consumer project this pipeline was cloned into.
- Docs: `.md` / `.txt` files (`PP_DOCS_DIR`); a bundled `sample-docs/` corpus
  ships so a bare run works with zero config.
- Retrieval: `scripts/bm25_retrieve.ts` (Bun, stdlib-only, no network, no LLM);
  self-tests via `bun test scripts/tests/`. Step 01 is a `type: script` step —
  in-process, no agent, no tokens.

## Graph

```json
{
"01-retrieve": {"goto": "02-select"},
"02-select": {"goto": "03-answer"},
"03-answer": {"done": true}
}
```

## Invariants

- READ-ONLY: no step writes to the docs or the user's code; nothing outside the
  run state is touched.
- Each answer is grounded in exactly ONE source file and cites it.
- No network and no external installs — pure local retrieval.

## Variables

- PP_DOCS_DIR (default: ./sample-docs) — docs folder to search; a relative value resolves against this pipeline root (so the default hits the bundled corpus), an absolute value points at your own docs.
- PP_QUESTION (default: How do I get started?) — the question to answer.
- PP_TOP_K (default: 5) — number of BM25 candidates to retrieve.
