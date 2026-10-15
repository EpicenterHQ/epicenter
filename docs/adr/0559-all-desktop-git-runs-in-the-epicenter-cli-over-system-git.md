# 0559. All desktop Git runs in the epicenter CLI, over system git

- **Status:** Proposed
- **Date:** 2026-10-16
- **Built:** the Bun Git runner's hook rule: an empty checked `core.hooksPath` and `core.fsmonitor=false`.
- **Unbuilt:** the rest. It can start now: the field edits of [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md) have landed (`1ab1bdb028`). MinGit ships with the first Windows release.
- **Amends:** [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) at "history through the system `git`, which the shell runs for it" (`run_git`): the `epicenter` CLI runs whole Git operations for the page, one child each, under the same rules. Files through the shell's read and checked change commands are unchanged.
- **Relates:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the CLI owns Git, the network, and credentials), [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) (`status`, `sync`, `clone`, `auth git-credential`), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (the merge), [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md) (Git's lock files and `casBranch` referee commits), [ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md) (LFS in TypeScript, `filter.lfs` off).

## Context

The engine has two Git backends behind one interface
(`packages/folder/src/git/backend.ts`). The browser's
(`packages/folder/src/git/browser-backend.ts`) is isomorphic-git over the
folder's private `.git` in OPFS, including fetch and push. The native one
(`packages/folder/src/git/native-backend.ts`) is a hybrid:

```txt
isomorphic-git   reads objects from .git; builds trees, commits, and the merge in memory
system git       writes every object (hash-object -w), the index (add, reset), and refs
                 (update-ref with the expected old value); fetch, push, status, diff, log
```

Sync's merge is TypeScript on every host: each path both sides changed is
offered first to ADR-0551's rules, root `kv.json` merges by key (`mergeKv`),
and isomorphic-git's merge assembles the tree and merges any unclaimed path by
Git's ordinary rules (`packages/folder/src/git/merge.ts:1-24`). There is no
`git merge` and no `git commit`.

That system `git` runs in two places. A desktop page sends each command to the
shell's `run_git` (`packages/folder/src/tauri-git.ts`), which checks it against
an allowlist, pins `core.hooksPath` to an empty directory, scrubs the
environment, and allows push and fetch only to `origin`
(`packages/tauri-plugin-epicenter-folder/core/src/page_git.rs`, with
cancellation in `packages/tauri-plugin-epicenter-folder/src/git_runs.rs`). A
Bun process spawns `git` through `createGitRunner`
(`packages/folder/src/git/native-host.ts`), which scrubs the environment and,
like `run_git`, sets `core.hooksPath` to an empty checked directory and
`core.fsmonitor=false`. Two gaps remain in Bun: an aborted fetch does not kill
`git-remote-https`, which runs in its own process group, and the repository
layout check (`verify_layout` in the shell) runs only when the folder opens,
not before every run.

Both spawn the bare name `git`. A Finder-launched app gets launchd's `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`) and never finds a Homebrew or git-scm
install. On a Mac without the Command Line Tools, `/usr/bin/git` is the xcrun
shim: it exits 1 and macOS shows an install dialog, once per attempt. On
Windows without Git the spawn fails with "program not found".

## Decision

**All desktop Git runs in the `epicenter` CLI, over system `git`, one child
per operation.** Status, history, Save version, and Sync each run as one
`epicenter` child that holds the engine and spawns `git` as it needs. A page
calls a fixed Rust command (`status`, `history`, `save_version`, `sync`), each
mapped to one fixed CLI invocation (ADR-0556). The shell runs no `git`.

**Only the plumbing differs between hosts; the merge is always ours.** On
every host Sync merges with the TypeScript above. On the desktop, system `git`
writes objects, the index, and refs, and does every transfer, taking Git's own
lock files, so the CLI is safe beside terminal `git`, agents, and editors on
the same repository. In the browser, isomorphic-git does all of it over a
private OPFS `.git` that no other program touches, which is why it may skip
lock files there.

**Sync saves first.** `epicenter sync`, and the Sync button, commit any edits
not yet in a version as one automatic version, then fetch, merge, and push.

**The safety rules live in one runner.** `createGitRunner` already sets an
empty checked `core.hooksPath`, `core.fsmonitor=false`, no terminal prompt,
and a scrubbed environment (built). It takes the rest of what `run_git`
applies: the engine's operation allowlist, a `.git` that is the folder's own
directory checked before every run, push and fetch only to an `origin` that is
a network URL, and an abort that ends the whole process group, helpers
included. Credentials come from Git's helpers, with
`epicenter auth git-credential` for `git.epicenter.so` (ADR-0558).

**The CLI finds `git`.** It tries `PATH`, then `/opt/homebrew/bin` and
`/usr/local/bin` on macOS, and confirms the binary runs (`git --version`)
before using it, so the xcrun shim's dialog appears only when a person asks
for it.

**A missing `git` is a typed error the Folders window explains.** The CLI exits
2 with `{ "error": "GitMissing" }` under `--json`. On macOS the window offers a
button that starts the Command Line Tools install, a one-time step. Reading
and editing files keep working without `git`.

**Epicenter bundles `git` only on Windows, as MinGit.** macOS has the Command
Line Tools and Linux distributions ship `git`, so neither bundles one. On
Windows the release carries MinGit, which Git for Windows publishes as "an
intentionally minimal, non-interactive distribution of Git for Windows, with
third-party applications as its intended audience" (gitforwindows.org/mingit):
no localized messages, interactive commands, help, Perl, or Tcl/Tk.
`MinGit-2.56.0.2-64-bit.zip` is 39,806,486 bytes. Git is GPL-2.0; Epicenter
runs it as a separate program and ships its license and source offer with it.

**Deleted:**

- `run_git` and `cancel_git` (`packages/tauri-plugin-epicenter-folder/src/commands.rs:262-330`).
- `packages/tauri-plugin-epicenter-folder/core/src/page_git.rs` (572 lines, and 591 of tests).
- `packages/tauri-plugin-epicenter-folder/src/git_runs.rs` (128).
- The page's `packages/folder/src/tauri-git.ts` (68).

## Consequences

- One set of Git safety rules, in TypeScript, for the app, the terminal, and
  agents. Its two open gaps are closed in that one place.
- Each Git operation costs one CLI start, 25 to 50 ms measured on macOS arm64,
  plus about 7 ms per `git` it spawns. Typing never pays it: reads and saves
  stay the shell's commands.
- A page cannot cancel a single `git` process; it cancels the operation, which
  ends its child.
- SSH remotes, credential helpers, `info/attributes`, and the person's Git
  configuration keep working, because system `git` does the transfers.
- Pressing Sync with unsaved edits makes a version the person did not name.
- The Windows installer grows by about 40 MB compressed.
- A Mac without the Command Line Tools can read and edit folders and cannot
  keep versions or sync until they are installed.

## Considered alternatives

- **isomorphic-git on the desktop too, made safe in TypeScript.** The engine
  makes few writes, so it could take Git's lock-file protocol itself:
  `<ref>.lock` created with `O_EXCL` and renamed into place for `update-ref`
  with the expected old value, and `index.lock` for the index. That removes the
  dependency on system `git`, at the cost of SSH remotes, delta-compressed
  pushes (isomorphic-git 1.38.5 packs objects undeltified), and slower status
  checks. Deferred, not rejected.
- **isomorphic-git as it is, everywhere.** It takes no `index.lock` or ref
  lock files (it locks in process only), so it is unsafe beside terminal `git`
  and agents.
- **Bundle `git` on every platform.** macOS and Linux already have it, or get
  it in one step.
- **Refuse Sync while edits are unsaved.** One more step for a person who
  pressed Sync to keep their work.
- **Keep `run_git` in Rust beside the CLI's runner.** Two runners in two
  languages, kept in step by hand.
