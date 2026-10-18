# 0611. Epicenter is only the data layer its apps reach over Git

- **Status:** Accepted
- **Date:** 2026-10-18
- **Supersedes:** [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md), [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md), [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md), [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md), [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md), [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md), [ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md), [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md), [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md), [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md), [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md), [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md), [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0596](0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [ADR-0602](0602-folderapp-names-its-app-by-the-last-segment-of-its-address.md), [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md), [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md), [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md), and [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md), the desktop app host: the desktop app hosts, installs, builds, and approves no app and gives a website no native capability.
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at its command set, the `app` group, and "`sync --to` is Connect": the CLI is `login`, `logout`, `repos`, `clone`, `sync`, `status`, `check`, and `query` over plain Git, with `auth key` and `send` kept for bring-your-own-key AI ([ADR-0618](0618-epicenter-hosts-no-ai-service.md)); [ADR-0586](0586-you-open-a-folder-never-an-app.md) at everything but its Folders window and "Show files": no folder opens in an app, and no app is installed or handed a folder; the window that lists the clones on disk and shows a repository's files survives as the data browser.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the repository), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (the table), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (an app's identity and grants), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge `epicenter sync` runs), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the sync schedule), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (`epicenter status`).
- **Unbuilt:** almost all of it: the `@epicenter/data` package; `epicenter login` installing Git's credential helper; `epicenter sync` committing every path `.gitignore` does not ignore and merging with Epicenter's TypeScript merge over the local `.git`; `epicenter status`; `repos` and `clone` over the one listing route; `check` listing broken links and row folders that have no row; Epicenter Captures on `@epicenter/data`; `apps/epicenter` reduced to the data browser over the CLI; one reader and writer of a clone on disk, plain files with no Git engine, that `check`, `query`, and the data browser share; the deletion of the CLI's `app` group; and Whispering as its own Tauri app. Which platforms the data browser ships for is not decided.

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
kept the desktop app as a browser of that data, without the host, and
chose one merge for every host: the TypeScript merge a browser sync runs
also runs in `epicenter sync` on disk.

## Decision

**Epicenter is a Git service, a CLI, one browser library,
`@epicenter/data`, and a desktop data browser.**

```txt
THE GIT SERVICE    git.epicenter.so, the front door to every repository
  accounts                      who signs in
  repositories and members      the access list (ADR-0612)
  consent and grants            one per app origin and repository, and an account grant
                                per signed-in device (ADR-0614)
  Git smart HTTP                authorized on every request, then served from
                                Cloudflare Artifacts (apps/api/worker/git-repositories.ts)
                                or a disk store when self-hosted (packages/server/src/git-disk-store.ts)
THE CLI            epicenter login · logout · repos · clone · sync · status · check · query,
                   plus auth key · send (ADR-0618)
THE LIBRARY        @epicenter/data, imported by any website
THE DATA BROWSER   apps/epicenter, over the clones on disk, through the CLI
```

**An agent's commit and an app's save edit the same repository, and Git is
the only record and the only sync format.** An agent commits with `git`; an
app saves through `@epicenter/data` into its own clone, which commits at
sync
([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md));
both reach every other client only as commits on `main`. Epicenter keeps no
CRDT store. A live co-editing channel for one row's body may come later as a
transport that starts and ends at a commit and stores nothing.

**The desktop app is a data browser, never an app host.** It lets a person
clone, inspect, browse, and manage repositories from `git.epicenter.so` or
another Epicenter-compatible Git service, and shows each table as a typed
table from its `table.json`
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).
It is a visual companion to the CLI, which stays primary and agent-first,
and it works through the CLI: it has no sign-in of its own and reaches the
Git service through the CLI's credential helper, lists and clones with
`epicenter repos` and `epicenter clone`, and syncs each clone by running
`epicenter sync` on the schedule a browser clone keeps
([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md)).

```txt
the clones it lists    every clone under ~/Epicenter, and every directory the person adds
each one known by      its remote URL
what it writes         working files, each save one merge of the whole file (ADR-0622);
                       epicenter sync commits them
```

Kept from [ADR-0586](0586-you-open-a-folder-never-an-app.md): a window that
lists the clones on disk and shows a repository's files and rows.
Withdrawn: opening a folder in the app its `epicenter.json` names,
installing an app, handing a window a folder, and the generic editor as an
installed app.

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

**The CLI is these ten commands, over plain Git.**

```txt
epicenter login     signs in with an account grant (ADR-0614) and installs Git's credential
                    helper for the Git service
epicenter logout    signs out
epicenter repos     lists the repositories the person is on, each by id and name
epicenter clone     clones a repository by name or id; a name several repositories share asks for the id
epicenter sync      in a clone: commits every change .gitignore does not ignore, fetches,
                    merges with Epicenter's merge, and pushes
epicenter status    says why a clone is not synced: its stuck causes, its unsynced changes,
                    and the age of its last fetch (ADR-0624)
epicenter check     lists every file that does not fit its table, every conflict marker,
                    every broken link, and every row folder that has no row
epicenter query     one read-only SQL statement over the tables
epicenter auth key  keeps a bring-your-own-key endpoint and its key in this machine's keychain (ADR-0618)
epicenter send      sends one request to that endpoint with that key (ADR-0618)
```

Withdrawn: `generate`, `history`, `save-version`, `sync --to`, the `app`
group, and `declare-epicenter-folder`. Whether `auth status`, `auth token`,
and `install-command` remain is not decided.

**`epicenter sync` is the only Epicenter command that commits, and it
commits everything `.gitignore` does not ignore.**

- It commits every changed path the repository's `.gitignore` does not
  ignore, inside tables or outside them, as `git add -A` would.
  `.gitignore` is the only rule for what stays on one device
  ([ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md)).
- It fetches `main` and, when `main` moved, merges with the same
  TypeScript `merge` a browser sync runs, over the local `.git`, with the
  local work as the change
  ([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).
  It writes the merge commit itself, `Overrode:` trailers included, and
  pushes a fast-forward.
- Epicenter registers no Git merge driver: no `merge.epicenter.driver`
  config and no committed `.gitattributes` line.
- Plain `git pull` stays plain Git and merges with Git's text merge. The
  conflict markers it leaves are `check` lines, and while any file holds
  one, or any path is unresolved, `epicenter sync` commits nothing: it
  names the files and stops.

## Consequences

- An agent on a Mac works on a clone with plain `git` and these commands,
  and renames a row with `git mv` on its `.md` and its folder; a website
  works on its own clone through the library; both read the same files.
- On disk, the person and their agents write files with last-write-wins,
  the data browser's save merges against the version it read, and commits
  happen at `epicenter sync`.
- Every file in a clone that `.gitignore` does not ignore reaches `main`
  at the next `epicenter sync`, inside tables or not; a file meant for one
  device is a `.gitignore` line.
- `epicenter sync` and a browser sync merge the same two commits the same
  way and write the same `Overrode:` trailers; only plain `git pull` leaves
  conflict markers.
- `check`, `query`, and the data browser read and write a clone through one
  reader and writer of plain files, with no Git engine; Git runs only in
  `git` and the CLI's Git commands.
- The CLI needs a system `git`, as the desktop host did.
- Recording into a repository from Rust, local transcription, hidden
  windows, and the Trash leave Epicenter. Whispering takes back what it
  needs in its own Tauri app; whether that app reuses
  `packages/tauri-plugin-epicenter-recorder` is not decided.
- A compromised first-party origin reaches only the repositories its grants
  name, as an outside site would.
- `apps/local-books` and `apps/vocab` are kept, and each is ported to
  `@epicenter/data` later; Vocab's chat also needs a connection of its own
  ([ADR-0618](0618-epicenter-hosts-no-ai-service.md)).
- Twenty-five desktop records stay as history, superseded; ADR-0586 stays,
  amended, for its Folders window, which lives on as the data browser.

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
- **A data browser with a sign-in of its own.** A second credential on one
  machine for the repositories the CLI already reaches.
- **Git's text merge in `epicenter sync`.** `epicenter sync` and a
  browser sync then merge the same two commits differently, and every
  overlap on disk is a conflict marker.
- **A Git merge driver, `merge.epicenter.driver`.** Each machine registers
  it and each repository opts in with a `.gitattributes` line; Git calls
  no driver for a file one side deleted, and Git writes the merge commit,
  so it carries no `Overrode:` trailer.
- **`epicenter sync` staging only paths inside tables.** A file outside
  tables then reaches `main` only through a `git add` the person has to
  remember, and a second rule beside `.gitignore` decides what leaves a
  device.
- **`epicenter mv`, renaming a row and its folder in one commit.** It saves
  one `git mv`, and `check` already lists a row folder left behind and the
  links a rename breaks.
- **A CRDT store beside Git.** Each row then has two records, and an
  agent's commit reaches an app only through a translation between them that
  plain `git` cannot read.
- **First-party apps with access an outside site lacks.** Two classes of
  client, and a compromised first-party origin reaches more than one
  grant.
