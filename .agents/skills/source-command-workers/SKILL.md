---
name: "source-command-workers"
description: "Advance the always-on workers buildout by one slice, then stop and report."
---

# source-command-workers

Use this skill when the user asks to run the migrated source command `workers`.

## Command Template

You are continuing the "always-on workers over synced docs" buildout. Do ONE slice, commit, update the tracker, and stop. The stop-and-report IS the checkpoint; do not batch slices.

## Read first (every run)

1. `specs/20260616T225034-workers-buildout.tracker.md` (state + slices + invariants + dependency rules)
2. `specs/20260616T225034-always-on-workers-over-synced-docs.md` (the vision)
3. `docs/adr/0015-...observing-worker.md`, `docs/adr/0014-...app-blind-anchor.md`, `docs/adr/0010-...process-boundary.md`, `specs/20260530T100000-ai-workflows-consolidated-design.md`
4. `git log --oneline -15` to see what already landed.

## Each run

1. Reconcile: tick any tracker box whose work is already in git but unchecked, recording the commit hash.
2. Pick the next action by the tracker's Dependency Rules:
   - V0 slices are strictly ordered: do the lowest unchecked V0 slice.
   - V1 starts only after every V0 box is ticked.
   - V2.R is research only and independent: advance it instead whenever the build track is blocked on my review (a Decisions-Needed entry, or a slice awaiting my sign-off).
3. Do EXACTLY ONE slice. Follow that slice's description plus the invariants in the vision spec and ADRs. Stage specific files only (never `git add -A` or `git add .`). If you are on `main`, branch first.
4. Commit with a message naming the slice, e.g. `feat(vocab): V0.2 child-doc observe loop`.
5. Update the tracker: tick the box, write the commit hash into its `commit:` field, append one line to the Log.
6. STOP. Report: what you did, the commit, what is next, and any decision you need from me.

## Rules

- One slice per run. The checkpoint is the point.
- Never tick a build slice without `bun run typecheck` green (and workspace tests green for V0 slices). If something is red, fix it within the same slice or revert and report.
- If a slice needs a decision the specs and ADRs do not answer, do NOT guess: append it to the tracker's "Decisions Needed" section and stop.
- Hold every invariant in the tracker: single writer per field, `generationId` is the idempotent assistant id, dispatch is only a wake nudge, no server-to-client SSE, tools are published actions only, V2 stays research-only until I say "build V2".
- Do not include AI or tool attribution in commits.

## Whole-effort stop condition

Every V0 and V1 box ticked, and the V2.R research spec written. When that holds, report completion and propose flipping ADR-0024 and ADR-0025 from Proposed to Accepted.
