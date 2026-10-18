# 0592. A folder's `.gitignore` decides what stays on one machine

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) at the `local` key, the engine's rule table, `publishLocalPatterns`, and the consequences about `local` merging: audio stays on the machine while the folder's `.gitignore` ignores it, and whoever edits that line decides for every device. [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at "Paths the opened definition declares local never enter a commit": `.gitignore` decides what a commit leaves out. [ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md) at "`audio/`, which its definition declares local": Whispering's template `.gitignore` ignores `audio/`.
- **Amended by:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) at "Every repository Epicenter creates or clones gets `info/attributes` unsetting each attribute that changes bytes before anything is checked out": Epicenter writes no `info/attributes`.
- **Amended by:** [ADR-0620](0620-history-in-a-repository-only-grows.md) at "repairing it means rewriting history in Git, by a person or an agent": a repair is a revert, and a rewritten history is a new repository.
- **Amended by:** [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) at "Audio stays on this machine while the folder's `.gitignore` ignores it" and "Whispering's template ships `.gitignore` with `audio/`": Whispering keeps audio in the app's own storage, outside the repository; `.gitignore` deciding what a commit leaves out stands.
- **Amended by:** [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) at "Sync still refuses, as `SyncError.Unrepresentable`" and its list: the only refusals are what Git or a client cannot represent, and each is a cause of `stuck`.
- **Built:** the refusals in the decision and no others. Sync and a native checkpoint refuse no line-ending or encoding attribute (`core.autocrlf`, `text`, `eol`, `ident`, `working-tree-encoding`) and find a filter by reading `.gitattributes` lines (`declaredFilter`, `packages/folder/src/git/attributes.ts`), with no `git check-attr --source`. Every repository Epicenter creates or clones gets `info/attributes` unsetting each attribute that changes bytes before anything is checked out (`neutralizeAttributes`, `packages/folder/src/git/neutral-attributes.ts`), and every `git` Epicenter runs sets `core.autocrlf=false` and `core.eol=lf` (`packages/folder/src/git/native-host.ts`).
- **Unbuilt:** plain Git ignore semantics on both backends with no `local`, Whispering's template `.gitignore`, and the deletions below.

## Context

`local` in the Definition (`packages/definition/src/declaration.ts:99`)
lists `.gitignore` patterns, and the engine leaves every match out of every
commit whatever `.gitignore` says (`localMatcher` and `sourceFiles`,
`packages/folder/src/git/scope.ts`), including a file committed before the
rule and one a `!` line in `.gitignore` re-includes (ADR-0577). `localNow`
(`packages/folder/src/git/history.ts:322`) joins the Definition's patterns
with the file's and refuses a save version or a sync when `epicenter.json`
does not read. A read-through handle also passes the reading app's patterns
as `appLocal`, which the desktop sends to the CLI as `--app-local`
(`app_local_options` in `apps/epicenter/src-tauri/src/history.rs`). Only
that handle passes them (`createCliHistory` in
`packages/folder/src/tauri-history.ts`): the Folders window's Save version,
the CLI run by hand, and an agent's plain `git` commit the same folder
without them.

## Decision

**Audio stays on this machine while the folder's `.gitignore` ignores
it.** The engine follows plain Git ignore semantics on both backends, and
the Definition has no `local`. Whispering's template ships `.gitignore`
with `audio/`, so a folder made from it ignores audio from its first byte,
and Whispering runs no check of its own. Whoever edits that line decides
for every device. A recording committed by mistake syncs; repairing it
means rewriting history in Git, by a person or an agent, which Epicenter
does not do.

**Epicenter never refuses to commit a file because of what it holds; it
refuses only what another device could not write back as plain files.**
Sync still refuses, as `SyncError.Unrepresentable`
(`packages/folder/src/git/errors.ts:93-110`), a tree holding a link, an
executable, a submodule, a Git attribute filter, an invalid path, or two
paths only their case tells apart. A folder outside the Epicenter folder
inside another repository's working tree still gets no repository of its
own (ADR-0585).

## Consequences

- ADR-0577's two engine guarantees end, and each becomes a change to the
  folder's policy:
  - A `!` line that re-includes audio, or a removed `audio/` line, makes
    every device commit audio, including audio recorded before the edit.
  - A file committed before its ignore line stays tracked; the engine no
    longer drops it from the next commit. A folder made from Whispering's
    template never tracks audio, since `.gitignore` is in its root commit.
- No released build reads these folders. A development folder that holds
  committed audio or a `local` key is made again from its template or
  cleaned by hand; no code handles either.
- ADR-0581's storage commands carry no `local` and are unchanged. The
  history commands `status`, `save_version`, and `sync` lose their
  `app_local` argument.
- Deleted: the `local` key in `Definition` and its checks in
  `prepareDefinition`, `localMatcher` and `sourceFiles`' `isLocal` and
  `isAppLocal` (`packages/folder/src/git/scope.ts`), `localNow` and its
  refusal, `appLocal` through the openers, `--app-local` in the CLI, and
  `app_local_options` with each history command's `app_local`.

## Considered alternatives

- **Template lines in `.gitignore` the engine refuses to let a person
  override.** The engine would have to remember which lines came from a
  template, which is the `local` key under another name.
- **A reserved `local/` directory the engine never commits.** An exception
  Epicenter invented, which plain `git` needs a `.git/info/exclude` line to
  follow; and "local" names nothing in a local-first product, where every
  file is local.
- **A `.nosync` suffix.** Another invented exception, and renaming a file
  changes whether it syncs.
- **`.git/info/exclude`, alone or written per recording beside the
  template's line.** It is a second, per-device policy that overrides the
  folder's, which is the `local` key again; and alone it does not travel
  with a clone.
- **A check before recording that `audio/` is ignored and untracked.** The
  line is the folder's policy, and a check at record time would override a
  change its owner made.
- **Audio in app data, outside the folder.** It breaks ADR-0544's rule that
  a blob is a file in its folder, and separates a recording's audio from its
  row.
- **Leave binaries out by kind.** A PDF a person drops into a folder would
  silently not sync.
- **Leave large files out by size.** Any threshold is arbitrary, and a file
  that grows past it stops syncing without a word.
