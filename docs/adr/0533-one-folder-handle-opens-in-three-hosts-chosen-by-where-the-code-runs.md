# 0533. One folder handle opens in three hosts, chosen by where the code runs

- **Status:** Proposed
- **Date:** 2026-10-14
- **Relates:** [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) runs the engine in a desktop page; [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) names the directory a page opens.
- **Unbuilt:** one way to replace a file on disk: `@epicenter/folder/bun` swaps a staged copy in with an atomic exchange (`native-exchange.ts`, `addon/exchange.c`), a desktop page with a plain rename (`page_files.rs`).

## Context

`@epicenter/folder` runs in three places. A web app runs in a browser tab. A
desktop app runs in a Tauri webview. Tests, recovery harnesses, and scripts
such as `scripts/epicenter.ts` and `apps/capture/scripts/recovery-harness.ts`
run as Bun processes. They differ in who may touch the disk: a browser tab
reaches only its origin private file system, a desktop page reaches a
directory only through the shell, and a Bun process reaches the disk itself.
A Bun process has no webview, so it cannot call the shell's `invoke()`
commands.

## Decision

**Every host returns the same `Folder` handle.** `folder.ts` defines it and
every entry re-exports it through `contract.ts`; tables, `kv`, files, history, and Sync behave the same whichever host opened
the folder.

```text
host            entry                        storage                         history                       disk reached by
browser tab     @epicenter/folder            <OPFS root>/<id>/               isomorphic-git, OPFS .git     the page
desktop page    @epicenter/folder            ~/Epicenter/<id>/               system git via run_git        the shell (fs plugin reads, Rust writes)
Bun process     @epicenter/folder/bun        the root it is given            system git, run itself        the process (node:fs)
```

**A page imports `@epicenter/folder`, and `openFolder` picks its host when it
is called.** `isTauri()` chooses `tauri-adapter.ts`, otherwise
`browser-adapter.ts`, and only the chosen adapter is loaded. A desktop page
whose folder cannot be opened gets that refusal, never browser storage. Both
take `{ id, definition }`. A build for one environment aliases the exact
specifier `@epicenter/folder` to `@epicenter/folder/browser` or
`@epicenter/folder/tauri`.

**A script imports `@epicenter/folder/bun`, and the bare entry never picks
it.** `openFolder({ root, definition, git })` takes the directory, the
definition, and the commit author from the caller, because no app or shell
supplies them. A script kept inside a folder can import that folder's
`epicenter.json` as its definition and pass its own directory as `root`.

## Consequences

- A table, row, or Sync rule is written once and runs in all three hosts.
- A page bundle never contains `node:fs` or the Bun opener, and a script never
  contains OPFS storage or isomorphic-git.
- Pages that share a folder coordinate through Web Locks named from its ID. A
  Bun process takes none, so a script and an open desktop window on one
  directory are two writers. Git's `index.lock` and the engine's best-effort
  checks of the observed version keep them apart, and a lost race is a
  visible refusal or a changed file
  ([ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md)).
- Neither the Bun opener nor a desktop page watches the directory, so an open
  window shows a script's edits only after it reads again
  ([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
- A script and a desktop page write the same disk, so a different file
  replacement in each gives a race two outcomes.

## Considered alternatives

- **Let the bare entry detect Bun too.** A page bundle would have to resolve
  the Bun opener's `node:fs` imports, and one signature would hide that a page
  names a folder ID while a script names a directory.
- **Route a script's writes through the desktop shell.** A script has no
  webview to call `invoke()` from, and would need the app running.
- **Let scripts edit plain files and run `git` without the engine.** Row
  formats, `kv.json` merging, and the declaration would be reimplemented or
  skipped by every script.
