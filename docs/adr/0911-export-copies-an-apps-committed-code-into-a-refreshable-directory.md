# 0911. Export copies an app's committed code into a refreshable directory

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md): settles local code export; the private root and publication histories stay separate.

## Context

A person develops and uses apps inside their private Epicenter, then shares
their code for others to copy. A persistent local collection lets the person
inspect those copies together and review changes before pushing. An app can
later become an independent project without changing its exported format.

## Decision

`epicenter export <app> <directory>` writes that app's committed code into the
exact directory. `epicenter export --all <directory>` applies the same operation
to one child per app, including future committed apps. Repeating either command
refreshes its output, including deletions. One invocation reads one source
commit and reports omitted uncommitted code. It never imports an app or changes
the live repository's index, refs, or working files.

The exported directory has `epicenter.ts` at its root. The live `code/` wrapper
separates code from private `data/`; an export contains only code. A collection
and a standalone app repository use the same format. Ordinary Git determines
repository boundaries and owns review, commits, and pushes. Export keeps no
destination registry and creates no repositories or remotes.

The export and `new --from` share the code-file filter and checkout operation.
Neither copies records, local paths, dependencies, build output, source
provenance, or export markers. Git preserves modes and binary bytes and
materializes LFS content. Included internal links remain links. A relative link
to a committed regular shared file outside `apps/` is copied by value, so a
root theme can travel with an app. Links to private or excluded paths, another
app, a shared directory, or outside the Epicenter are refused. Export does not
bundle arbitrary external imports.

Export owns each app directory; the person owns the collection's root files
and Git metadata. A marker containing the app name and a content digest
identifies output and detects later edits independently of the destination's
Git status. The marker contains no private commit identity or local path.
Unchanged output receives no writes. Refresh refuses changed or unrelated
output, preserves the app's top-level `.git`, and stages replacement before
moving the previous output aside. Failure during replacement restores the
previous directory; an unsuccessful restoration preserves its recovery copy.

Destinations cannot overlap the private Epicenter or replace a symlink.
`--all` continues after an app fails and reports partial completion. It reports
stale exports whose source apps disappeared and leaves their removal to the
person. Adding a future committed app includes it on the next `--all` export;
the subsequent diff review and Git push remain deliberate.

## Consequences

- One collection gives the person a persistent view of all exported apps.
- Recipients use `new --from <url>#<app>` for a collection or `--from <url>`
  for a standalone repository.
- Contributions made to a publication copy must return to the live app before
  its next export. Refresh performs no merge.
- Committed source is reproducible, but automatic checkpoints do not establish
  that its code is finished. The person chooses when to export and reviews it.

## Considered alternatives

- **Always create one repository per app.** Repository ownership is independent
  of copying an app's code; a directory target supports either grouping.
- **Mirror the live `apps/<app>/code/` layout.** The extra wrapper serves no
  purpose in a copy without private records.
- **Use a temporary publication checkout.** A persistent collection makes the
  publication files and their pending changes inspectable.
- **Export the working tree or checkpoint implicitly.** A pinned source commit
  avoids mixed revisions and keeps private checkpointing independent of export.
- **Refresh only previously selected apps.** The person explicitly chose all
  apps, including future ones. Collection membership is not another registry.
- **Automatically push.** Local export is reviewable before a public action.
