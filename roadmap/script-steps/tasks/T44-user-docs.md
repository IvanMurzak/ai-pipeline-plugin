# T44 — User-facing docs: README, docs/cli.md, docs/script-steps.md, CLAUDE.md

- **Depends on:** T00 (contracts frozen in DESIGN.md)
- **Parallel with:** T11, T12, T41, T42, T43
- **Footprint (only these files):**
  - `README.md` (edit)
  - `docs/cli.md` (edit)
  - `docs/script-steps.md` (NEW)
  - `CLAUDE.md` (edit — pointers/layout lines only)
- **Status:** done — added `docs/script-steps.md` (frozen process-I/O reference), extended `docs/cli.md` (`pipeline next` in-process script exec + `continue` + `--manual-scripts` + call budget, new `pipeline step run` bullet), added README "Script steps (zero-token steps)" section, and wired `CLAUDE.md` pointers (layout tree + reference-docs list + lockstep editing rule → DESIGN §15). All literals cross-checked against DESIGN.md.

## Goal

Consumers (pipeline authors) and future maintainers can learn the feature
without reading the roadmap: a reference doc for the frozen script I/O
contract, CLI docs for the new flags/subcommand, and README positioning.

## Spec

Entire `DESIGN.md`; the reference doc mirrors the role
`docs/worktree-hook-contract.md` plays for hooks.

## Steps

1. **`docs/script-steps.md`** (NEW, the reference): step declaration
   (frontmatter + body), `## Params`/`## Output` vocabulary + bindings, the
   process I/O contract (env vars, params file, stdin/stdout, exit
   semantics, the ok:false rule), failure classes + `retries`/`on-failure`
   policies + fallback, the timeout ladder (manager window vs headless), the
   ledger/idempotency requirement, outputs store paths, secrets rule,
   `pipeline step run` usage. Mark the process I/O contract section FROZEN
   (consumer interface — same language as the hook contract doc).
2. **`docs/cli.md`**: extend the `pipeline next` bullet (in-process script
   execution, `continue` action, `--manual-scripts`, budget) and add a
   `pipeline step run` bullet — follow the existing dense-bullet style with
   lockstep notes.
3. **`README.md`**: a "Script steps (zero-token steps)" section — what/why
   (token economy), a minimal example, link to `docs/script-steps.md`.
4. **`CLAUDE.md`**: add `docs/script-steps.md` to the docs list + the plugin
   layout tree; add one editing-rules line pointing to the lockstep chain
   (DESIGN.md §15) for anyone touching script-step behavior.
5. Consistency pass: field names, paths, exit codes, and env var names match
   DESIGN.md exactly (this doc set becomes the public contract — a typo here
   becomes someone's bug).

## Acceptance criteria

- A consumer can author + test a script step using only README →
  docs/script-steps.md.
- `docs/cli.md` mentions every new flag/subcommand the code adds (cross-check
  T31/T33 task specs).
- No concrete project names anywhere (repo rule).

## Out of scope

Agent docs (T41–T43), code, version bump (T51 — do NOT bump here).
