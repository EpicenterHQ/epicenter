# 0592. Git controls which working files enter commits

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) at the `local` key, the engine's rule table, `publishLocalPatterns`, and the consequences about `local` merging: audio stays on the machine while the folder's `.gitignore` ignores it, and whoever edits that line decides for every device. [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at "Paths the opened definition declares local never enter a commit": `.gitignore` decides what a commit leaves out. [ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md) at "`audio/`, which its definition declares local": Whispering's template `.gitignore` ignores `audio/`.
- **Amended by:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) at "Every repository Epicenter creates or clones gets `info/attributes` unsetting each attribute that changes bytes before anything is checked out": Epicenter writes no `info/attributes`.
- **Amended by:** [ADR-0620](0620-history-in-a-repository-only-grows.md) at "repairing it means rewriting history in Git, by a person or an agent": a repair is a revert, and a rewritten history is a new repository.
- **Amended by:** [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) at "Audio stays on this machine while the folder's `.gitignore` ignores it" and "Whispering's template ships `.gitignore` with `audio/`": Whispering keeps audio in the app's own storage, outside the repository; `.gitignore` deciding what a commit leaves out stands.
- **Amended by:** [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) at "Sync still refuses, as `SyncError.Unrepresentable`" and its list: the only refusals are a non-text write from the library, a push that would rewrite history, and what Git cannot represent; a browser clone carries untouched any tree entry it cannot represent, and on a disk clone what its file system cannot represent is a cause of `stuck`.
- **Amended by:** [ADR-0653](0653-ignore-rules-select-git-source-without-a-declaration-policy.md) at outside-repository audio placement and migration: ignored bytes can remain in W, and declaration privacy policy is removed without migration.
- **Amended by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at browser synchronization and "purging committed bytes requires a new repository": the web never syncs, and the owner may replace `main`.
- **Unbuilt:** removing legacy schema-owned local patterns and app-local arguments from the folder engine and its callers.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

`local` in the Definition (`packages/definition/src/declaration.ts:99`)
lists `.gitignore` patterns, and the engine leaves every match out of every
commit whatever `.gitignore` says (`localMatcher` and `sourceFiles`,
`69d33c135926:packages/folder/src/git/scope.ts`), including a file committed before the
rule and one a `!` line in `.gitignore` re-includes (ADR-0577). `localNow`
(`c87a47f8783f:packages/folder/src/git/history.ts:322`) joins the Definition's patterns
with the file's and refuses a save version or a sync when `epicenter.json`
does not read. A read-through handle also passes the reading app's patterns
as `appLocal`, which the desktop sends to the CLI as `--app-local`
(`app_local_options` in `944d86823af5:apps/epicenter/src-tauri/src/history.rs`). Only
that handle passes them (`createCliHistory` in
`9d13dd25854e:packages/folder/src/tauri-history.ts`): the Folders window's Save version,
the CLI run by hand, and an agent's plain `git` commit the same folder
without them.

## Decision

**Git ignore rules control which untracked working files enter ordinary Git commits.**
A tracked file remains tracked when an ignore pattern is added. A schema
file contributes no local patterns, and opening an app grants no exception
to the repository's Git configuration.

**Whispering stores its original audio outside the data repository.**
This follows ADR-0621. Its synchronized recording rows and its device-local
audio have separate lifetimes. An ignore file is not an audio-storage or
attachment-synchronization mechanism.

**Git content is not filtered by the library's text-write restriction.**
The library writes text. Ordinary Git can carry existing binary content,
symlinks, executable entries, and submodules. Browser synchronization carries
untouched entries; a disk client reports a path its filesystem cannot
represent. Schema nonconformance does not refuse a commit.

**Repairs preserve hosted history.**
A revert adds a commit. Purging committed bytes requires a new repository
under ADR-0620, not an automatic history rewrite.

## Consequences

- The legacy local key, publication of local patterns, appLocal, and
  --app-local require migration. Their removal is not a schema rename.
- A browser has no filesystem working tree; its explicitly saved content
  is not an automatically imported set of ignored disk files.
- Epicenter writes no private attributes that neutralize the repository's
  Git attributes (ADR-0619).
