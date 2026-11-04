# 0750. Sync is like save: any program can sync a folder, and none owns it

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) at the Epicenter app owning `sync --watch` and at "Syncing needs Epicenter" with its download link: any program with a credential runs a round at the moments below, and no app shows that message; [ADR-0328](0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md) at running from login so that work continues in the background, and at Pause, as they apply to sync: sync runs at moments a person causes, so it needs no program running between them and has nothing to pause; [ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md) at "Sync, history, and agents come from the desktop: Git, `epicenter sync --watch`": the native host syncs the folder at the extension's moments; [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) at its "when sync runs" row: people expect sync where they expect save, when an app opens, after a save, on return, and on request.
- **Relates:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md) (the core that runs a round), [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (turning on sync is the consent), [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) (sync diffs state), [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) (the folder's `AGENTS.md` note), [ADR-0725](0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md) (every write goes through the shell).
- **Unbuilt:** the moments in each app's shell and in the Epicenter app; the round lock in any program other than the CLI; the sync instruction in the generated `AGENTS.md` block.

## Context

Today one program syncs a machine's folders. The Epicenter app runs
`epicenter sync --watch --json` for as long as it runs and restarts it
whenever a folder is added (`run_service` in
`apps/epicenter/src-tauri/src/synced_folders.rs`). `--watch` runs a round,
then another half a second after a file in a watched folder changes, and
another every 30 seconds (`watch` in `packages/cli/src/sync/commands.ts`).
[ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md)
made this the Epicenter app's job: it "owns consent screen, sync --watch,
the root scan", and any other app "shows 'Syncing needs Epicenter' and a
download link".
[ADR-0328](0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md)
has Epicenter start at login so background work keeps running, with one
Pause for the machine.

[ADR-0751](0751-every-native-app-carries-one-sync-core.md) gives every
native app the code to run a round itself. Sync then needs a rule for who
runs it and when. A design pass first gave each program a handle that keeps
a folder synced while it is held, then moved the timing into each app's
shell: after a save, every 30 seconds, and on reconnect. Both still treat
sync as a process that runs between a person's actions.

A person already knows an operation with the same shape: save. Any program
can save a file, saving happens when they act, and no program owns the file.

## Decision

**Sync is an operation on a folder, not a role a program plays.** The folder
holds everything sync needs to be shared:

| The folder holds | As | Today |
| --- | --- | --- |
| consent | `epicenter.synced = true` in the folder's `.git/config` | written by `epicenter init` (`packages/cli/src/sync/setup.ts`) |
| state | `.git`, with `refs/epicenter/last-seen` as the last agreed version ([ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md)) | as today |
| exclusion | `.git/epicenter-sync.lock`, held for a whole round | held by `epicenter sync` (`packages/cli/src/sync/sync.ts`) |

**The round lock covers a whole round.** A round is commit, fetch, merge,
Git LFS transfer, and push. Git's own locks, such as `.git/index.lock`,
guard one operation each, so two programs could interleave their rounds
between them. A program that finds the round lock held waits its turn, as
`epicenter sync` waits today (`TURN_WAIT_MS`, two minutes), and reports
`Retry` when the holder runs longer.

**Any program with a credential may run a round, and programs never call
each other.** An app, the Epicenter app, the CLI, and the native host meet
only in the folder. No program routes a folder to another, and no app asks
whether Epicenter is running.

**Sync runs at the moments a person expects, and only then.**

| Moment | What the person expects | What the program does |
| --- | --- | --- |
| the app opens | to see what other devices did | runs a round |
| after a save | the change to reach their other devices | runs a round a few seconds after the last save in a burst |
| they return to the app's window | to see what changed while they were away | runs a round |
| they press Sync | it to sync now | runs a round |

Each round both pulls and pushes; the middle column is why the moment
exists. A program knows its own saves because every write goes through its
shell ([ADR-0725](0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)).
No program runs a file watcher, an interval timer, or a background service
to sync.

**Agents sync before they start and after they finish.** Each folder's
generated `AGENTS.md` block (between `<!-- BEGIN epicenter -->` and
`<!-- END epicenter -->`, written by `packages/folder/src/agents-note.ts`)
says so and names the command, `epicenter sync <dir>`.

**The Epicenter app syncs every consented folder in the library at the
same moments:** when it opens, after a save it makes, when the person
returns to its window, and when they press Sync.

**`epicenter sync --watch` survives only as a CLI option** for a person who
wants it in a terminal. No app or Epicenter runs it.

## Consequences

- A standalone app syncs its own folder; "Syncing needs Epicenter", the
  `epicenter://init` hand-off, and the question of whose app is running are
  deleted.
- An idle app in the background does not show another device's change until
  the person returns to its window. This is the accepted cost: no app polls.
- A save made offline syncs at the next moment after the network returns,
  and a closed app's last saves wait until it next opens. Nothing is lost:
  unsent work is the files ([ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md)).
- Two programs can sync one folder in the same second, such as Whispering
  after a save and Epicenter on return. The second waits on the lock and its
  round finds little to do.
- A save makes one round a few seconds later, not one round per file write.
- A machine with no Epicenter program open makes no network requests for
  sync.
- An agent that ignores its `AGENTS.md` block leaves its edits unsynced until
  the folder's app or Epicenter next reaches a moment.

## Considered alternatives

- **One program owns sync (ADR-0713, today).** Every other app needs that
  program installed and running, and must route its folder to it.
- **A file watcher and a 30-second timer in every program (today's
  `--watch`).** Each open program fetches every 30 seconds and holds a
  watcher on its folder, though every write it makes already passes through
  its shell.
- **A handle that keeps a folder synced while a program holds it.** App code
  then manages a syncing object, which is sync as a role again.
- **A background service started at login (ADR-0328).** Keeps another device's
  change visible at all times, at the price of a process a person did not
  open and a Pause to stop it.
- **Git's own locks only.** They guard single operations; two rounds could
  interleave a fetch from one with a merge from the other.
