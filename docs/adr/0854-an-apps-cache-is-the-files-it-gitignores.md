# 0854. An app's cache is the files it gitignores

- **Status:** Proposed
- **Date:** 2026-11-08 (revised 2026-11-11: no `.cache/` directory)
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at the context: `cache`, its directory under `~/Library/Caches`, `clear()`, and `sqlite(name)` go. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at its cache root per operating system. [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md), for an app in an Epicenter, at "Can it be rebuilt? yes → `.cache/`" and the template `.gitignore`: there is no `.cache/` line; a rebuilt file is ignored where its tool writes it.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (ignored paths are written and never committed), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (the template's `.gitignore`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (the UI and its build), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` paths, and a context of `folder` only).
- **Built:** 2026-11-09: the `cache` object, its directory under `~/Library/Caches`, `EPICENTER_CACHE_HOME`, `clear()`, and `sqlite(name)` are deleted. 2026-11-11: the view at `ui/dist/` (`packages/cli/src/ui.ts`), and the template `.gitignore` without `.cache/` (`packages/cli/src/new.ts`).

## Context

ADR-0841 kept rebuildable state outside the folder, in a cache directory per
app with its own object, and rejected `.cache/` inside the folder because it
would need excluding from Git and from backups everywhere and would be indexed
by the vault's tools. Since then the template ships a `.gitignore`, backup is
the Git remote (ADR-0851), and the vault already keeps rebuildable mirrors
(`.calendar/`, `.todoist/`) as ignored files beside its notes.

This record first gave an app a `.cache/` directory, with `.cache/epicenter/`
for generated types. Only the UI build ever used it: each app's
`svelte.config.js` pointed adapter-static at `../.cache/ui`, out of its own
project, so no app's UI matched a stock SvelteKit project, and a starter
developed outside an Epicenter needed one more ignore line (2026-11-11).

## Decision

**What an app can rebuild lives in files it gitignores, inside its own folder,
where the tool that builds them puts them.** The template `.gitignore` is:

```txt
node_modules/
*.local
*.local.*
```

The UI builds where most build tools write by default: `ui/dist/`, ignored by
`ui/.gitignore` (ADR-0860). An app that keeps another rebuildable
file, such as a search index, ignores that path in its own `.gitignore`. What
is kept on one computer but cannot be rebuilt is a `.local` path (ADR-0858).
An action reads and writes these files through `folder` like any file; Git
ignores them, so no commit includes them. A database is a file there, opened
through `folder.path`.

There is no `.cache/` convention and no `.cache/epicenter/`. If `epicenter`
ever generates editor types for an app, they go under `node_modules/`, which
every JavaScript tool already ignores.

## Consequences

- Each clone has its own rebuilt files by construction, so a worktree's new
  shape never breaks another copy's.
- Deleted: the `cache` object, its directory per operating system, its per-path
  hash for worktrees, `clear()`, and `sqlite(name)`.
- An app's UI is an ordinary SvelteKit or Vite project. `bun run build` in
  `ui/` writes `ui/dist/`; `epicenter build` keeps the last build that worked
  (ADR-0868).
- Rebuilding is the tool's job: delete `ui/dist/` and run `epicenter build`.

## Considered alternatives

- **A cache directory outside the folder (ADR-0841).** A second object, a
  second location per operating system, and a naming scheme for worktrees, for
  files Git already knows how to ignore.
- **`.cache/` inside the folder, with `.cache/ui/` and `.cache/epicenter/`.**
  This record's first decision. One ignore line covered everything rebuilt,
  but its one user, the UI, had to be configured away from its tool's default,
  and the directory carried a rule ("deletable at any time") that nothing
  enforced.
