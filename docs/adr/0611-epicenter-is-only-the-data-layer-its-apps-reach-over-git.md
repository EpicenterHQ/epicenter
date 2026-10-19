# 0611. Epicenter keeps a minimal local app runner over its data layer

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amended by:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at generic table discovery: readers select lenses and retain raw file access without one. [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at account-free local app use and optional synchronization. [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) at data-only product scope and the CLI hosted inference path: optional hosted inference remains separate from Git. [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) at desktop delivery scope: generic browsing and the optional runner are deferred clients, never prerequisites for local apps or services.
- **Supersedes:** [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md), [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md), [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md), [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md), [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md), [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md), [ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md), [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md), [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md), [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md), [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md), [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md), [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0596](0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [ADR-0602](0602-folderapp-names-its-app-by-the-last-segment-of-its-address.md), [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md), [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md), [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md), and [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md), the full desktop app platform: only a local built-app runner over chosen data repositories remains, without source installation, build approvals, or general native services.
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at its command set, the `app` group, and "`sync --to` is Connect": the CLI is `login`, `logout`, `repos`, `clone`, `sync`, `status`, `check`, and `query` over plain Git, with `auth key` and `send` kept for bring-your-own-key AI ([ADR-0618](0618-epicenter-hosts-no-ai-service.md)); [ADR-0586](0586-you-open-a-folder-never-an-app.md) at mandatory app association, source installation, and its generic editor as an installed app: the data browser lists disk clones and may open a chosen local built app over a selected clone.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the repository), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (the table), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (an app's identity and grants), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge `epicenter sync` runs), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the sync schedule), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (`epicenter status`).
- **Unbuilt:** the public `@epicenter/data` integration; the CLI commands and shared on-disk reader and writer below; the minimal runner's local-folder opening workflow and repository bridge; verified concurrent saves and sync from the runner and a standalone shell over one disk clone; removal of the old app installer and general native services; and Whispering as its own Tauri app with audio outside the repository; the runner's supported platforms are not decided.

## Context

Epicenter is a convention and toolkit for local-first apps whose data lives
in ordinary Git repositories. Apps and agents edit the same files. Browser
apps and desktop tools store their local copies differently, while sharing
the file format, merge behavior, and Git exchange format.

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

Later on 2026-10-19 the owner retained a smaller runner for agent-built
personal apps. Packaging every small tool as its own native application
repeats installation, signing, and native data integration. A Tauri window
over a local website and a chosen data repository removes that repetition.
It does not require the source installer, build approvals, or general native
services of the earlier platform. The runner is optional: browser apps,
standalone apps, and agents keep using the data without it.

## Decision

**Epicenter is a Git service, a CLI, one browser library,
`@epicenter/data`, and a desktop data browser with a minimal local app runner.**

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
THE DESKTOP        apps/epicenter: a data browser and local built-app windows over chosen disk clones
                   Git and account access stay in the CLI
```

**An agent's commit and an app's save edit the same repository, and Git is
the only record and the only sync format.** An agent commits with `git`; a
browser app saves through `@epicenter/data` into its own clone, which commits at
sync
([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md));
desktop app windows save into a chosen clone's working files. Independent
clones exchange changes only as commits on `main`; windows over the same
disk clone see its saved files without a remote sync. Epicenter keeps no
CRDT store. A live co-editing channel for one row's body may come later as a
transport that starts and ends at a commit and stores nothing.

**The desktop data browser manages the clones personal tools can open.** It lets a person
clone, inspect, browse, and manage repositories from `git.epicenter.so` or
another Epicenter-compatible Git service, and shows each table as a typed
table from its `table.json`
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).
It is a visual companion to the CLI, which stays primary and agent-first.
It has no sign-in of its own and reaches the
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
lists the clones on disk and shows a repository's files and rows. A person
can also choose a local app to open a repository. The repository names no
required app, and opening an app never creates a private data copy.

**A personal app is a built local website opened in its own Tauri window.**
A person chooses a local directory containing `index.html` and its assets,
then chooses the disk repository that window opens. Epicenter remembers
the app directory and that selection in machine-local settings outside the
data repository. Several windows may select the same repository.

The person or agent builds the website with its ordinary development tools.
Epicenter serves the chosen directory locally. Rebuilding and reopening is
the update mechanism; there is no approved commit or immutable-build promise.
Reopening must preserve unsaved input if saving fails. Forgetting an app
removes its remembered launch location and leaves its source and data alone.

**The runner exposes only the chosen repository's data operations and sync.**
Its windows use the same on-disk reader and writer as the data browser,
including the whole-file save merge (ADR-0622) and change notifications.
The shell resolves the selected directory; a page receives a repository
handle, not a generic filesystem or process API. Git runs in the CLI, using
the device's existing account grant and credential helper. Pages receive no
credential. Local saves work without an account or a network connection.

The existing window creation and local file serving are implementation
material to retain and simplify. The existing broad native grant is not the
runner's API. Removed: source acquisition, dependency installation, builds
and commit approvals in Epicenter, the CLI's `app` group and
`packages/cli/src/installed-apps.ts`, app catalogs, general native grants,
Rust's microphone, local model management, and the Trash. The local serving
mechanism remains; its current shared origin is not an app identity or an
OAuth origin for the runner. Opening a tool is consent to run trusted local
code, not a sandbox guarantee. A marketplace or hostile-code isolation is
outside this runner.

**App files and data repositories have independent locations and lifetimes.**
The app's directory supplies the interface; the selected repository supplies
the records. Neither app identity nor packaging chooses the repository's
directory name (ADR-0612). This target layout illustrates two tools over one
repository; the directory names are examples:

```txt
~/Code/personal-tools/transcript-review/dist/  built website: index.html and assets
~/Code/personal-tools/meeting-notes/dist/      another built website

~/Epicenter/voice-notes/                      data repository either tool can open
  .git/
  recordings/
    table.json
    <recording-id>.md
  transcriptions/
    table.json
    <transcription-id>.md

Whispering's application data/                owned by standalone Whispering
  audio/                                     device-local recordings, outside the repository
```

Tables and rows follow ADR-0613. The tools agree on the fields they share;
hosting does not make unrelated schemas compatible. A missing app directory
can be rebuilt or chosen again without changing the data. Replacing an
interface never migrates or deletes its repository implicitly.

**Standalone Whispering can open the same disk repository independently of Epicenter.**
Its Tauri shell supplies recording, shortcuts, local transcription, and its
own device-local settings and audio. Its text records use the same file
format and save merge. It may open `~/Epicenter/voice-notes` directly or a
separate clone of the same remote; a separate clone exchanges changes through
Git. A hosted transcript-review tool needs neither Whispering's recorder nor
its native shell to read and edit those text records.

Whispering's audio remains outside the repository (ADR-0621). Moving between
shells does not copy that audio or make it available to another tool. Audio
sharing needs an explicit app-owned mechanism and is outside the minimal
runner. The current Whispering implementation still stores `audio/` inside
its folder and ignores it in Git; that is migration work, not this layout.

**Desktop tools sharing one disk clone coordinate saves and sync by its canonical path.**
Runner windows, the data browser, and a standalone shell use the same
on-disk writer and coordination rules. A save merges against the source the
editor read, serializes its read-check-write with other cooperating saves,
and preserves unsaved input on failure. Sync coordinates its working-tree
changes with that writer. Cross-process coordination is required before
claiming simultaneous runner and standalone editing works; the old folder
save lock is existing implementation material, not proof of the new merge.
Plain editors and agents may bypass that coordination; their files remain
accessible and checkable, and Git retains only versions actually committed.
No shared daemon or second Git engine is required by the runner.

**A first-party browser app is an ordinary client.** It signs in by its origin and
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
- On disk, the person and their agents write files with last-write-wins.
  The data browser and cooperating desktop apps save through the same
  coordinated merge, and commits happen at `epicenter sync`.
- Every file in a clone that `.gitignore` does not ignore reaches `main`
  at the next `epicenter sync`, inside tables or not; a file meant for one
  device is a `.gitignore` line.
- `epicenter sync` and a browser sync merge the same two commits the same
  way and write the same `Overrode:` trailers; only plain `git pull` leaves
  conflict markers.
- `check`, `query`, the data browser, and runner windows use one reader and
  writer of plain files, with no Git engine; Git runs only in `git` and the
  CLI's Git commands.
- The CLI needs a system `git`, as the desktop host did.
- Recording into a repository from Rust, local transcription, hidden
  windows, and the Trash leave Epicenter. Whispering takes back what it
  needs in its own Tauri app; whether that app reuses
  `packages/tauri-plugin-epicenter-recorder` is not decided.
- A compromised first-party browser origin reaches only the repositories
  its grants name, as an outside site would. Runner tools instead execute
  as trusted local code over the selected disk repository.
- `apps/local-books` and `apps/vocab` are kept, and each is ported to
  `@epicenter/data` later; Vocab's chat also needs a connection of its own
  ([ADR-0618](0618-epicenter-hosts-no-ai-service.md)).
- Twenty-five desktop records stay as history, superseded; ADR-0586 stays,
  amended, for its Folders window, which lives on as the data browser.
- Personal tools share one installed Tauri runtime and one data bridge.
  The runner still needs to maintain that bridge and local file serving,
  but takes on no source installer, release catalog, or general native API.
- Opening the same disk directory shares saved text immediately. A separate
  clone shares committed text through sync; neither arrangement shares
  Whispering's device-local audio automatically.

## Considered alternatives

- **No desktop app.** A person then sees a repository's tables only through
  an app that names them or through a terminal.
- **A data browser with no runner.** Every small personal tool needing disk
  access then supplies its own native packaging and data integration.
- **Every tool gets a private data directory named after its app.** Two
  tools cannot work on the same records without copying or synchronizing them.
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
