# 0641. Epicenter remembers folders as machine-local paths

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amended by:** [ADR-0649](0649-folders-json-selects-this-machines-folder-locations.md) at the array format and list-only purpose: the object keeps added paths in `folders` and the selected portable-records path in `epicenter`.
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) only at grouping machine-local preferences and the reserved `open` command: `folders` manages remembered paths; `open <directory>` requests desktop opening without the former `--app <id>` selector.
- **Relates:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) (explicit paths), [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) (composition through files), [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (CLI schemas), and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) (deferred desktop).
- **Unbuilt:** the shared list, its CLI commands, arbitrary-folder desktop opening and handoff, coordinated preference updates, and verification across CLI versions. These do not gate standalone apps or path-based CLI operations.

## Context

The current desktop listing searches direct children of its folder root for
`epicenter.json`. It neither lists arbitrary opened paths nor provides a
machine-local remembered-folder list. The current deep-link parser opens
built-in windows, not a supplied directory.

An app already knows where it saves. Epicenter can receive that path without
requiring a common parent, per-folder identity file, or app registration.
Remembering it helps a person or agent return to the files. It does not perform
the review that develops captures into writing in another folder.

## Decision

**Epicenter desktop and CLI share one optional list of absolute directory paths.**
The list lives at `<Epicenter app data>/folders.json`, which on release macOS is
`~/Library/Application Support/so.epicenter/folders.json`. Its contents are a JSON
array of absolute paths, with no app IDs, aliases, dataset IDs, or remote IDs:

```json
[
  "/Users/braden/Library/Application Support/so.epicenter.capture/work",
  "/Users/braden/Code/vault"
]
```

These are remembered paths, or bookmarks in explanations. They are shortcuts,
not filesystem permission grants or an automatic relocation mechanism. Losing
the list loses shortcuts. Standalone apps determine their own save locations
without reading or updating this list. Epicenter does not scan a shared root to
populate it automatically.

**The `folders` group manages the list; path commands operate on the work.**
This is future command grammar, not implemented CLI help:

| Command | Effect |
| --- | --- |
| `epicenter folders add <directory>` | Remembers an existing directory. Repeating the same stored path adds no duplicate. Creates no directory, schema file, or Git repository. |
| `epicenter folders list [--json]` | Lists remembered paths, including unavailable ones, and identifies their availability. |
| `epicenter folders forget <directory>` | Removes only the remembered entry. The target need not exist. Deletes no files and changes no Git configuration. |
| `epicenter open <directory>` | Requests that Epicenter desktop open the directory. The desktop remembers it after accepting the opening. |

`list` exposes the stored absolute path so `forget` can match it after the target
has moved or disappeared. Forgetting that exact address requires no successful
filesystem resolution. An already absent entry is a no-op. Path normalization
must preserve this repair route; it introduces no alias or portable folder ID.

`check`, `query`, `status`, and `sync` continue to take explicit directories.
They do not resolve names through this list or require an entry. Adding a path
does not connect sync. Forgetting it does not disconnect sync. `repos` lists
hosted repositories; `folders list` lists this machine's remembered paths.

**A handoff requests an opening; it does not grant access.** A native app's
**Open in Epicenter** action passes its current document directory to the
desktop app through the operating system. It does not search for a public CLI
on `PATH`. Receiving an external link alone must not read a new directory or
grant another app access. The desktop applies its opening and window-grant policy
before accessing the supplied files and remembering the path.

The CLI's `open` reports dispatch of the request, not an unobserved successful
opening. A failed bookmark write must not undo an accepted opening; it reports
that remembering failed. The desktop is optional, so these handoffs remain
deferred with it.

**Remembered paths and schemas have separate files and lifetimes.**

| File | Meaning |
| --- | --- |
| `<Epicenter app data>/folders.json` | Paths useful on this machine; never automatically synchronized with authored content. |
| `<directory>/epicenter.json` | Static table schemas for CLI `check` and `query` under ADR-0632; may travel with that directory's Git history. |

There is no new `folder.json` marker inside every directory. Neither JSON file
identifies data, chooses a remote, establishes app ownership, or authorizes access.
Apps and ordinary file access need no schema file.

**List persistence remains repairable machine-local preferences.** An absent
list is empty. Writers coordinate read-modify-write updates and replace the file
whole. Unreadable or unsupported contents are reported and left intact. A person
or agent can inspect and repair the JSON; explicit-path operations remain usable.
An older CLI must not rewrite a format it cannot preserve. This requires no
daemon or folder-registration service.

## Consequences

- Data can stay in app data, an existing Vault, or another chosen directory.
  There is no required `~/Epicenter` parent or registration step.
- An unavailable entry remains visible and removable. Relocating data may require
  repairing both an app's selection and Epicenter's remembered path.
- The list does not make browser-private work accessible on disk. That needs
  synchronization or export.
- The list adds one convenience concept. Most removal of app ownership,
  declaration gates, and the full desktop platform was already chosen in earlier
  records; it is not a new deletion prize from bookmarks.
- Implement the list when a CLI or desktop caller needs it. A hypothetical future
  screen does not require every app to register itself today.

## Considered alternatives

- **A universal dataset registry.** Adds identity, copy-versus-move semantics,
  location reconciliation, and registry recovery to eliminate occasional path
  repair. The current workflows do not require that bargain.
- **List children beneath a common root.** Adds a location convention and a second
  discovery source while still needing explicit paths for existing outside work.
- **Top-level `add`, `remember`, or `forget`.** Hides which collection changes.
  `folders` groups machine preferences without moving `sync` or `check` beneath it.
- **`folders remove`.** Makes deletion of a directory a plausible reading.
  `forget` states the consequence for this saved shortcut.
- **Both `folder` and `folders`.** Two spellings add no capability. Use the plural
  for operations on the remembered collection.
- **A shared root Git repository for preferences and work.** Combines machine
  paths with authored data and imposes one history and access boundary.
