# 0890. A program's folder is its own, and holds only what its app's contract declares

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) at where Whispering's folder lives (`~/Whispering` by default, not `~/Epicenter/whispering`) and at preferences in the folder: only those the app's contract declares.
- **Relates:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files, the Keychain for a program's sign-ins), [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) (connecting), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (programs and contracts).
- **Unbuilt:** all of it, in Whispering 8.

## Context

ADR-0858 put Whispering's folder at `~/Epicenter/whispering` and listed
`settings.md` among the files that outlive the program. ADR-0885 then moved
apps to `~/Epicenter/apps/`, and a program that works alone should not need
an Epicenter's folder to exist. A `settings.md` that no collection declares
is a file a clone would push and the host would hold, which no app reads.

## Decision

**A program's folder is the program's: `~/Whispering` by default, any folder
the person picks. It holds only files its app's contract declares.**

```txt
~/Whispering/                       what the contract declares
  recordings/k3x9.md
  recordings/k3x9.local.webm        audio, kept on this computer (ADR-0887)
  transcriptions/p8d2.md
  .git/                             once connected

~/Library/Application Support/so.epicenter.whispering/   (macOS; each system's app data directory)
                                    the microphone, the shortcut, window state
Keychain                            API keys, sign-ins
```

- **One device's state is the program's own,** in its data directory, and its
  secrets are in the Keychain (ADR-0870).
- **A preference that should follow the person is a collection** in the
  app's contract, and travels like a record.
- **Alone, the folder never mentions Epicenter.** The program's only mention
  is the setting that connects it.
- **On the host,** a person may pick `~/Epicenter/apps/whispering/data` as
  the folder and not connect. The program then writes as any editor on the
  host does, and `serve`'s clock snapshots it (ADR-0850). The program's code
  is the same: its Git part is off.

## Consequences

- A person and their agents open recordings in Finder or a terminal; nothing
  is hidden in an app data directory.
- Uninstalling the program leaves the folder.
- A folder the person picks inside a synced folder, such as iCloud Drive,
  syncs its `.git` too once connected; Whispering warns when connecting such a
  folder.
- Device settings do not follow the person to a second computer unless the
  contract declares them.

## Considered alternatives

- **`~/Epicenter/whispering` (ADR-0858).** A program that works alone would
  create an Epicenter's folder, and apps now live under `apps/`.
- **The program's app data directory.** Hidden from the person and their
  agents, and some systems remove it with the program.
- **On the host, connect to `localhost` like any other device.** A second copy
  on disk, a dependency on `serve` for a local write, and a branch that can
  wait unfiled.
