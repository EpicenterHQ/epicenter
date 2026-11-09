# 0854. An app's cache is the files it gitignores

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at the context, which becomes `folder` and `secrets`: `cache`, its directory under `~/Library/Caches`, `clear()`, and `sqlite(name)` go. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at its cache root per operating system.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (ignored paths are written and never committed), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (the template's `.gitignore`), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (`.cache/` beside `.local` paths).
- **Built:** 2026-11-09: the context is `{ folder, secrets }`; the `cache` object, its directory under `~/Library/Caches`, `EPICENTER_CACHE_HOME`, `clear()`, and `sqlite(name)` are deleted.

## Context

ADR-0841 kept rebuildable state outside the folder, in a cache directory per
app with its own object, and rejected `.cache/` inside the folder because it
would need excluding from Git and from backups everywhere and would be indexed
by the vault's tools. Since then the template ships a `.gitignore`, backup is
the Git remote (ADR-0851), and the vault already keeps rebuildable mirrors
(`.calendar/`, `.todoist/`) as ignored files beside its notes.

## Decision

**What an app can rebuild lives in files it gitignores, inside its own folder.**
The template ignores `.cache/`; an app may ignore other paths. `.cache/`
holds only what can be rebuilt and may be deleted at any time; what is kept on
one computer but cannot be rebuilt is a `.local` path (ADR-0858). An action reads
and writes them through `folder` like any file; Git ignores them, so no commit
includes them. A database is a file there, opened through `folder.path`.
The context is `{ folder, secrets }`.

## Consequences

- Each clone has its own cache by construction, so a worktree's new cache shape
  never breaks another copy's.
- Deleted: the `cache` object, its directory per operating system, its per-path
  hash for worktrees, `clear()`, and `sqlite(name)`.
- Clearing a cache is deleting `.cache/`.

## Considered alternatives

- **A cache directory outside the folder (ADR-0841).** A second object, a
  second location per operating system, and a naming scheme for worktrees, for
  files Git already knows how to ignore.
