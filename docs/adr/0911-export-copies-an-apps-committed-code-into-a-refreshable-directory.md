# 0911. Export copies an app's committed code into a refreshable directory

- **Status:** Superseded
- **Date:** 2026-11-15
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md): settles local code export; the private root and publication histories stay separate.
- **Amended by:** [ADR-0944](0944-an-app-builds-its-own-ui-and-serve-only-serves-it.md): export refuses every link that leaves the app's `code/`; nothing outside is copied by value.
- **Superseded by:** [ADR-0955](0955-no-command-makes-or-copies-an-app.md): `export` no longer exists; no command copies an app's code.

## Context

A person develops and uses apps inside their private Epicenter, then shares
code for others to copy. A local collection lets them inspect those copies
side by side and review changes before pushing. An app can later become an
independent project.

Trying to preserve handwritten edits and Git metadata inside each exported
app introduced content hashes, per-app replacement, rollback, stale-output
handling, and recovery directories. Those responsibilities follow from mixing
replaceable code with files that have no other owner.

## Decision

Export owns one directory of replaceable code. Git and anything maintained
separately live outside it.

`epicenter export <app> <directory>` regenerates that app at the exact directory,
with `epicenter.ts` at its root. `epicenter export --all <directory>` regenerates
one complete collection with one child per committed app. Future committed
apps appear and removed apps disappear. One invocation reads one source commit.
It reports omitted uncommitted code and never imports apps or changes the live
repository's index, refs, or working files.

A collection uses `shared-apps/apps/` as its generated directory, beside the
publication's `.git/` and README. A standalone project can use `code/` beside
its `.git/` and README. Recipients select `#apps/tasks` from a collection;
`new --from` also accepts a standalone repository's `code/` subtree. Export
creates no repositories or remotes and keeps no destination registry.

The export and `new --from` share the code-file filter and checkout operation.
Neither copies records, local paths, dependencies, build output, source
provenance, or export markers. Git preserves modes and binary bytes and
materializes LFS content. Included internal links remain links. A relative
link to a committed regular shared file outside `apps/` is copied by value, so
a root theme can travel with an app. Links to private or excluded paths,
another app, a shared directory, or outside the Epicenter are refused. Export
does not bundle arbitrary external imports.

A root marker identifies an all-app or named single-app export. It grants
permission to replace contents; it tracks no digest, private commit, or local
path. Destinations must be missing, empty apart from Finder metadata, or have
a matching marker. Collection children have no individual markers. Export
refuses any `.git` directory, file, or link within the destination, including
nested repositories and worktrees. It also refuses symlinked destinations
and overlap with the private Epicenter.

Export prepares all code in temporary storage before changing the destination.
A preparation failure leaves the previous output untouched. It then locks the
destination directory, rechecks ownership, writes a marker if absent, and
clears and refills everything except that marker. Edits inside the generated
directory are overwritten. The directory and marker stay in place. Filling is
not atomic: an interrupted refresh can leave incomplete generated output,
which the next run repairs. No Git metadata moves, and no rollback copies or
recovery journal are maintained.

## Consequences

- One collection includes current and future committed apps without tracking
  a separate selection. Git shows app removals as ordinary deletions.
- The person reviews the outer repository after a successful export, then
  commits and pushes deliberately. An interrupted fill must be rerun first.
- Contributions to generated code must return to the live app before refresh.
  Export performs no merge and preserves no independent edits inside its target.
- Committed source is reproducible, but an automatic checkpoint does not
  establish that its code is finished. The person chooses when to export.

## Considered alternatives

- **Preserve edits and Git inside each exported app.** Separating their owners
  removes hashes, Git relocation, and recovery for valuable publication files.
- **Replace apps independently with partial success.** A collection is one
  snapshot. A bad app leaves the complete previous output untouched during
  preparation rather than producing a mixture of source revisions.
- **Atomically swap generated output with rollback.** Publication is deliberate.
  Rerunning repairs disposable output after interruption without backup machinery.
- **Always create one repository per app.** The person chooses repository
  boundaries independently of the code destination.
- **Export the working tree or checkpoint implicitly.** A pinned commit keeps
  private checkpointing independent of export and avoids mixed source revisions.
- **Automatically push.** Local output remains reviewable before publication.
