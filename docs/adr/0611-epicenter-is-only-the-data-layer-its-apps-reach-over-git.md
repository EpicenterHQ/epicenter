# 0611. Epicenter is a local-first toolkit with optional services

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amended by:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at generic table discovery: readers select schema files and retain raw file access without one. [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at account-free local app use and optional synchronization. [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) at data-only product scope and the CLI hosted inference path: optional hosted inference remains separate from Git. [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) at desktop delivery scope: generic browsing and the optional runner are deferred clients, never prerequisites for local apps or services.
- **Supersedes:** [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md), [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md), [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md), [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md), [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md), [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md), [ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md), [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md), [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md), [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md), [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md), [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md), [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0596](0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [ADR-0602](0602-folderapp-names-its-app-by-the-last-segment-of-its-address.md), [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md), [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md), [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md), and [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md), the full desktop app platform: only a local built-app runner over chosen data repositories remains, without source installation, build approvals, or general native services.
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at its command set, the `app` group, and "`sync --to` is Connect": the CLI is `login`, `logout`, `repos`, `clone`, `sync`, `status`, `check`, and `query` over plain Git, with `auth key` and `send` kept for bring-your-own-key AI ([ADR-0618](0618-epicenter-hosts-no-ai-service.md)); [ADR-0586](0586-you-open-a-folder-never-an-app.md) at mandatory app association, source installation, and its generic editor as an installed app: the data browser lists disk clones and may open a chosen local built app over a selected clone.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the repository), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (the table), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (an app's identity and grants), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge `epicenter sync` runs), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the sync schedule), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (`epicenter status`).
- **Unbuilt:** the public local-data API; schema-file input for generic CLI readers; native app integration and coordinated disk saves; and the later Epicenter desktop app and its runner.

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

**Epicenter provides a local-first data toolkit and optional hosted services.**
Apps open and save local data before first sign-in. Git synchronization and
inference connect independently afterward (ADR-0633 and ADR-0634).

| Part | Responsibility |
| --- | --- |
| Data library | File and row access, local persistence, schemas supplied by the caller, and the common content merge |
| CLI | File inspection, schema-based checking and queries, Git operations, account access, and inference requests |
| Git service | Hosted repositories, membership, authorized Git exchange, and ordinary Git content |
| Inference service | Optional authorized inference and transcription, with hosted-only billing |
| Epicenter desktop app | Deferred file browsing and a possible local app runner under ADR-0635 |

**An app's save and an agent's edit reach the same files.**
Cooperating app saves use the shared content merge with the source the draft
started from. Agents can edit files directly; those writes do not acquire
an automatic save witness. On disk, coordinated clients can open one data
folder. Different web origins hold separate local data and exchange commits
through their selected remote. Git records committed history; it does not
record every intermediate save.

**The CLI accepts a data folder by its path.**
With an explicitly selected schema file, check reports conformance issues
and query projects its named tables. Those views retain a route to raw
source and diagnostics. Schema-free SQL and automatic table discovery are
separate features; a missing schema cannot be described as successful
app-specific validation.

Git operations include repos, clone, sync, status, login, and logout in the
planned CLI. Existing auth key and send capabilities retain bring-your-own
provider configuration and optional hosted inference. Credentials remain
outside synchronized data. packages/cli/README.md documents implemented
commands; the installed CLI still has legacy auth and app command groups.
No schema-file flag or public opening signature is implied to exist yet.

**Standalone apps own their native capabilities.**
Whispering owns recording, shortcuts, local execution, and device-local
audio. It runs independently of the Epicenter desktop app. Desktop
synchronization uses native Git through the CLI; the browser engine uses
IndexedDB and Git transport.
Their shared contract is the file format, save merge, and Git exchange,
not a filesystem emulation imposed on browser storage.

**The Epicenter desktop app is a later optional client.**
A possible runner opens a built local website over selected disk data.
Runner names that capability of the Epicenter desktop app, not another product.
Host describes its runtime role only when that role matters.
App assets and data have separate locations. It acquires no source, builds
no app, approves no commits, and provides no general native-service API.
Its implementation and shared-disk coordination follow ADR-0635.

## Consequences

- Local data, Git synchronization, and inference have independent lifetimes.
- The old installer, template publication, and universal desktop host are
  unnecessary for independent apps. Existing code remains migration material.
- Schemas affect a reader's interpretation; no required schema file gates
  an app's saves or identifies its data.
- Hosted billing remains only in apps/api/worker/billing/.
