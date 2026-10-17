# 0026. The Matter vault's SQLite mirror is a read-only projection, never a verdict source

- **Status:** Superseded
- **Superseded by:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), which deletes Matter.
- **Date:** 2026-06-18

## Context

Matter treats a directory of typed markdown as a relational database: per-table
conformance, cross-table references, and a SQLite mirror for `WHERE` filtering.
With the vault (not the folder) now the primary object, that mirror moved to one
hidden `<root>/.matter/matter.sqlite` per vault, one SQL table per folder, which
makes cross-table `JOIN`s expressible for the first time. That raises a fork:
should those JOINs *resolve references*, making SQL the source of `dangling` /
`missing-target`? Matter already has a reference engine: `assess`
(`src/lib/core/integrity.ts`), the JS index the grid and integrity panel render
from.

## Decision

`assess` is the sole owner of every reference verdict (`resolved` / `dangling` /
`missing-target`). The per-vault SQLite mirror is a read-only **projection of
disk** and an external query surface only; SQL never resolves references.

The mirror is owned in JS as a single-writer primitive (`createMirror`, a
reset-headed promise write-chain): its head is the open-time reset, and every
link is a per-table rebuild (full DROP + CREATE + INSERT of one changed folder,
not a whole-db rebuild) or a per-folder drop on leave. It is rebuilt fresh on
every vault open. Rust owns only the on-disk `.matter/matter.sqlite` layout and
executes the JS-built SQL; it is schema-blind.

## Consequences

- One verdict engine, so the grid and the integrity panel cannot disagree. The
  two-vocabularies problem the vault redesign set out to kill stays killed.
- Cross-table JOIN *queries* ship for a human or an agent, but they are a
  convenience, never the app's truth. A SQL read would also lag the grid (the
  mirror rebuilds async behind the in-memory rows), so a verdict from SQL would
  be stale.
- The mirror stays disposable: delete `.matter/matter.sqlite`, reopen, get an
  identical db. It is always a pure function of current disk.
- Content folders stay pure markdown (the db is hidden under `.matter/`),
  preserving "your folder of markdown IS the database."
- The single-writer chain makes ordering structural, deleting the per-call
  coordination an inline version carried (no await-the-reset gate, no
  left-before-write guard, no off-paint `setTimeout`, one freshness bump in the
  chain tail). The cost is a chain that swallows a failed link and self-heals on
  the next rebuild, rather than surfacing per-write errors.
- **Trigger to revisit:** a resolution rule the JS index cannot express
  (transitive closure, aggregate constraints). Then SQL becomes a *computed
  input to* `assess`, never a parallel verdict source.

The full design exploration lived in the spec
<!-- doc-path-check: ignore-next-line -->
`apps/matter/specs/20260616T075253-vault-as-relational-unit.md`, retired in the
same change that records this ADR; recover its body from git history.
