# 0611. Epicenter is only the data layer its apps reach over Git

- **Status:** Proposed
- **Date:** 2026-10-18
- **Supersedes:** [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md), [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md), [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md), [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md), [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md), [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md), [ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md), [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md), [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md), [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md), [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md), [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md), [ADR-0586](0586-you-open-a-folder-never-an-app.md), [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0596](0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [ADR-0602](0602-folderapp-names-its-app-by-the-last-segment-of-its-address.md), [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md), [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md), [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md), and [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md), the desktop app host: the desktop app hosts, installs, builds, and approves no app and gives a website no native capability, and what survives of ADR-0586's Folders window and "Show files" is the data browser over clones on disk.
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at its command set, the `app` group, and "`sync --to` is Connect": the CLI is `login`, `sync`, `check`, `query`, and `mv`, over plain Git.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the repository), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (the table), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (an app's identity and grants), [ADR-0625](0625-epicenter-mv-renames-a-row-in-one-commit.md) (`epicenter mv`).
- **Unbuilt:** almost all of it: the `@epicenter/data` package; `epicenter login` installing Git's credential helper; `epicenter sync` over plain Git; Epicenter Captures on `@epicenter/data`; `apps/epicenter` reduced to the data browser; one reader and writer of a clone on disk, plain files with no Git engine, that `check`, `query`, and the data browser share; the deletion of the CLI's `app` group; and Whispering as its own Tauri app. How the data browser signs in, and which platforms it ships for, are not decided.

## Context

Epicenter was to be a desktop host. `apps/epicenter`, a Tauri shell,
installs each app as the person's fork, builds it, and serves it at its own
origin
([ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md));
an installed app opens any data folder by its id
([ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md)),
reaches native code through Tauri plugins granted to every installed window
([ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md),
[ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md)), and
records audio through Rust
([ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
All desktop Git runs in the CLI
([ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)),
whose `packages/cli/src/commands.ts` carries `check`, `query`, `generate`,
`status`, `history`, `save-version`, `sync --to`, `clone`, `repos`, the
`app` group with `packages/cli/src/installed-apps.ts`, the `auth` group,
`auth key`, `send`, `declare-epicenter-folder`, and `install-command`
([ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md)).
The shell's Folders window lists the folders on disk and opens each in the
app its `epicenter.json` names, or in the generic editor through "Show
files"
([ADR-0586](0586-you-open-a-folder-never-an-app.md)).
Twenty-six records decide that host.

On 2026-10-18 the owner chose to build only what every client of a person's
data shares: the place the data is kept, the access list in front of it, a
command line for agents, and a library for websites. On 2026-10-19 the owner
kept the desktop app as a browser of that data, without the host.

## Decision

**Epicenter is a Git service, a CLI, one browser library,
`@epicenter/data`, and a desktop data browser.**

```txt
THE GIT SERVICE    git.epicenter.so, the front door to every repository
  accounts                      who signs in
  repositories and members      the access list (ADR-0612)
  consent and grants            one per app origin (ADR-0614)
  Git smart HTTP                authorized on every request, then served from
                                Cloudflare Artifacts (apps/api/worker/git-repositories.ts)
                                or a disk store when self-hosted (packages/server/src/git-disk-store.ts)
THE CLI            epicenter login · sync · check · query · mv
THE LIBRARY        @epicenter/data, imported by any website
THE DATA BROWSER   apps/epicenter, over the clones on disk
```

**The desktop app is a data browser, never an app host.** It lets a person
clone, inspect, browse, and manage repositories from `git.epicenter.so` or
another Epicenter-compatible Git service, and shows each table as a typed
table from its `table.json`
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).
It is a visual companion to the CLI, which stays primary and agent-first.
It works on the same clones on disk as the person and their agents,
and writes as the person does, like an editor: what it writes is a working
file until `epicenter sync` commits it. Kept from
[ADR-0586](0586-you-open-a-folder-never-an-app.md): a window that lists the
clones on disk and shows a repository's files and rows. Withdrawn: opening a
folder in the app its `epicenter.json` names, installing an app, handing a
window a folder, and the generic editor as an installed app.

**Epicenter hosts, installs, builds, and approves no app, and gives a
website no native capability.** The data browser downloads no app source,
clones or builds no app, and approves nothing. Deleted: `apps/epicenter`'s
installed-app windows, the `epicenter-app` origin, the `app` group and
`packages/cli/src/installed-apps.ts`, grants by app id, Rust's microphone,
local model management, and the Trash. Cost: an app that needs a
microphone outside a tab, a local model, or the file system ships that
capability itself.

**A first-party app is an ordinary client.** It signs in by its origin and
opens a repository through `@epicenter/data`, with no access an outside
site lacks. Epicenter Captures (`apps/capture`) is the first. Whispering
later becomes its own Tauri app that links transcribe-cpp itself and reaches
the Git service as a client.

**The CLI is `login`, `sync`, `check`, `query`, and `mv`, over plain Git.**

```txt
epicenter login    signs in and installs Git's credential helper for the Git service,
                   so plain git clone, fetch, and push work
epicenter sync     in a clone: git add -A, git commit, git pull --no-rebase, git push
epicenter check    lists every file that does not fit its table, and every conflict marker
epicenter query    one read-only SQL statement over the tables
epicenter mv       renames a row and its folder in one commit (ADR-0625)
```

`git pull --no-rebase` merges with Git's own rules. A merge driver that
applies Epicenter's merge to plain Git is deferred until conflict markers
are a problem in practice; until then `check` lists the markers Git leaves.
Withdrawn: `generate`, `status`, `history`, `save-version`, `clone`,
`repos`, `sync --to`, the `app` group, `auth key`, `send`, and
`declare-epicenter-folder`. Whether `auth logout`, `auth status`,
`auth token`, and `install-command` remain beside `login` is not decided.

## Consequences

- An agent on a Mac works on a clone with plain `git` and five commands; a
  website works on its own clone through the library; both read the same
  files.
- The person, their agents, and the data browser write one clone on disk as
  one writer, the person. A file two of them write at once keeps the last
  write, as with two editors, and none of them commits outside
  `epicenter sync`.
- `check`, `query`, and the data browser read and write a clone through one
  reader and writer of plain files, with no Git engine; Git runs only in
  `git` and `epicenter sync`.
- The CLI needs a system `git`, as the desktop host did.
- Recording into a repository from Rust, local transcription, hidden
  windows, and the Trash leave Epicenter. Whispering takes back what it
  needs in its own Tauri app; whether that app reuses
  `packages/tauri-plugin-epicenter-recorder` is not decided.
- A compromised first-party origin reaches only the repositories its grants
  name, as an outside site would.
- The twenty-six desktop records stay as history, superseded; ADR-0586's
  Folders window lives on as the data browser.

## Considered alternatives

- **No desktop app.** A person then sees a repository's tables only through
  an app that names them or through a terminal.
- **The desktop host first.** It puts a native shell, installed apps, and
  per-app grants ahead of the data model every client shares, so the
  browser apps and the CLI wait on it.
- **A host that installs and builds apps
  ([ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md)).**
  Epicenter then fetches, builds, approves, and serves other people's code,
  which no rule about the data needs.
- **First-party apps with access an outside site lacks.** Two classes of
  client, and a compromised first-party origin reaches more than one
  grant.
