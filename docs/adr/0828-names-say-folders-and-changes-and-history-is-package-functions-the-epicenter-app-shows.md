# 0828. Names say folders and changes, and history is package functions the Epicenter app shows

- **Status:** Superseded
- **Date:** 2026-11-07
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the `https://git.epicenter.so` resource (and ADR-0565's `<origin>/git`): the folders audience is `folders`, at `<api origin>/folders` on every deployment, the hosted cloud included; [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at "A commit is one statement": a write appends one change at `POST <folders>/<id>/changes`, beside `GET …/changes?since`; [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) at its Unbuilt "history": the Epicenter app shows a folder's history; [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) at "`epicenter import --git`": an import is a package function over a computer's Git, which the CLI and the Epicenter app both run.
- **Relates:** [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) (the deployment names its audiences), [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) (Rust holds the OS and Git), [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) (one table of operations), [ADR-0821](0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md) (the file-sync check).
- **Unbuilt:** "Abandon" and "Resume" for an import in the Epicenter app; `epicenter export --git` from the app.

## Context

ADR-0824 made a folder's history a log in Postgres, and Git only how it
leaves and enters. The names still said Git: the OAuth audience `git`, a
host of its own (`git.epicenter.so`, `<origin>/git`), and a write route
`POST …/commits`. History, export, and import were CLI modules, so the
Epicenter app could show none of them without running the CLI, which
ADR-0817 refuses. Nothing hosted is live, so a rename breaks no one.

## Decision

**Names say folders and changes.** The audience is `folders`, its resource
`<api origin>/folders` on every deployment, and that is also where the
folder routes are: `POST|GET <folders>`, `<folders>/<id>/…`. A write is
`POST <folders>/<id>/changes`; the server's `appendChange` runs
`epicenter_append_change`. Words that mean Git (an export, an import, a
commit an import read) keep it.

**History, export, and import are package functions.**
`@epicenter/folder/platform` holds a folder's history (`folderLog`,
`fileHistory`, `fileAt`, `folderAt`, `folderDiff`, `restoreFolder`,
`markFolder`, `folderMarks`) and `importGit`, which runs on a `GitHost`
(`git`, a scratch directory, an LFS object, a hand-over).
`@epicenter/folder/node` holds what only Bun runs: its `gitHost`,
`exportGit`, and `abandonImport`. The CLI's operations call them.

**The Epicenter app shows them.** A synced folder's History lists its
changes, a file's versions, one shown as it was, a restore, and a mark.
"Import from Git…" runs `importGit` over the shell's Git, a few commands
that only run `git` and touch the paths an import names.

## Consequences

- Every token, route, and client says folders; a grep for Git finds Git.
- The CLI and the Epicenter app run the same history and import code.
- The Epicenter app's shell runs `git`, for an import alone.

## Considered alternatives

- **Folders at `<origin>/folders/folders/<id>`:** the audience as a prefix
  above unchanged routes; it doubles the word for no gain.
- **The app running the CLI for history and import:** ADR-0817 refuses it.
