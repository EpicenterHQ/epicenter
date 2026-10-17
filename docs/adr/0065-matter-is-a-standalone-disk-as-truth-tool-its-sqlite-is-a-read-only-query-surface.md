# 0065. Matter is a standalone disk-as-truth tool; its SQLite mirror is a first-class read-only query surface under `epicenter matter`

- **Status:** Superseded
- **Superseded by:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), which deletes Matter.
- **Date:** 2026-06-25
- **Relates:** [ADR-0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md) (the mirror is a read-only projection, never a verdict source; this ADR promotes that same mirror to the headline query surface without changing its read-only contract)

## Context

Matter turns a folder of markdown into a typed SQLite database: one `.md` file per row, its YAML frontmatter typed by a per-folder `matter.json`, its body the rich field. ADR-0026 settled the internal architecture: the per-vault `matter.sqlite` is a read-only projection of disk, and `assess` (not SQL) owns every reference verdict. But the mirror stayed hidden behind a single `WHERE` box, so the word "SQLite" in Matter's pitch mapped to nothing a user could see or run. The launch that prompted this ADR promotes SQLite to the headline: a read-only SQL console, sortable columns and full-text body search over one query path, a visible Database panel, and a `matter check` lint command in the shipped `epicenter` binary. That promotion forces three positioning questions that outlive the launch. Is Matter its own product or a feature of the workspace? Is the mirror still read-only once it is the headline? And where does its CLI live?

## Decision

Matter is a standalone, disk-as-truth tool, and its SQLite mirror is a first-class but read-only query surface shipped under `epicenter matter`.

- **Disk is the source; SQLite is a disposable projection.** Markdown files on disk are the only truth. Editing a cell writes the `.md` file, and the watcher reprojects. `matter.sqlite` (under `.matter/`) is rebuilt from disk on every change and is never a write target, so deleting it and reopening yields an identical database. This is ADR-0026's contract, unchanged, now load-bearing in public.
- **The mirror is the query engine, not a second source.** The grid's filter, sort, and full-text search are builders for one read-only SQL query; the console is the same engine with raw SQL. SQL decides which rows, in what order, matching what text. It never backs an editable cell (a JOIN or aggregate row has no file to write) and never resolves a reference (ADR-0026). The default view, with no query control active, still renders synchronously from the in-memory rows and issues no SQL.
- **The CLI is namespaced: `epicenter matter <verb>`, not a bare `matter` binary.** The lint engine extracts into the published `packages/matter-core`, and `epicenter matter check` ships in the binary. The namespace keeps the disk-as-truth verbs quarantined from the daemon and Yjs verbs, and `matter` is a crowded name to claim globally.
- **No sync, accounts, or cloud.** Matter is local and standalone. It does not depend on the Epicenter daemon, a peer, or an account to do its whole job.

## Consequences

- **Matter can be explained in one sentence and shipped on its own:** turn a folder of markdown into a SQLite database you (and your AI) can query. Its tools already work, because it is just markdown and SQLite.
- **The lint engine has two consumers.** `packages/matter-core` is a published, non-private package: `apps/matter` renders from it, and `epicenter matter check` calls into it. The CLI gains a transitive `@epicenter/field` dependency. The app's whole domain layer now lives in the package, not the app.
- **Sorting lags editing by one rebuild.** Sort a column, then edit that column, and the value updates instantly in memory but resettles position only after the next reprojection. This is the cost of one read-only engine ordering the rows; ADR-0026's freshness `version` already coordinates it.
- **A standalone `matter` binary stays a future option.** If Matter is ever distributed to non-Epicenter users, ship a thin `matter` alias over `epicenter matter`. The namespaced form is reversible; a bare binary claimed now would not be.
- **What this forecloses:** SQL as a write path, SQL as a verdict source, and any feature (sync, an account, a server) that would make a folder of markdown insufficient on its own. Those are not deferred; they are out of Matter's definition.

## Considered alternatives

- **Keep SQLite a hidden mirror behind the `WHERE` box.** Rejected: the headline word stays unbacked, and the differentiator competitors lack (real SQL plus a CLI and agent surface over local markdown) stays invisible.
- **Make the mirror editable so SQL is a write path.** Rejected: a JOIN or aggregate row maps to no file, and dual-writing SQL and disk reintroduces the two-sources problem ADR-0026 killed. Edits write markdown; the mirror reprojects.
- **Ship a bare `matter` binary now.** Rejected: `matter` is a crowded global name, and a standalone binary would mix disk-as-truth verbs with the daemon and Yjs verbs. Namespacing under `epicenter matter` is collision-free and reversible.
- **Fold Matter into the workspace as a non-standalone feature.** Rejected: its whole value is that a plain folder of markdown is the database, with no daemon, account, or sync required. Coupling it to the platform would break that promise.
