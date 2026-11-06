# 0819. Every program keeps the folders it has open in sync, and the Epicenter app has them all open

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0806](0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md) at "nothing runs once it closes": a folder keeps syncing while any program has it open, and the Epicenter app has every folder open; [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) at "The Epicenter app syncs every consented folder in the library at the same moments" and "Agents sync before they start and after they finish": the Epicenter app keeps every folder in sync while it runs, and `epicenter mcp` keeps the folders it writes in sync; [ADR-0816](0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md) at its jobs: it also keeps every folder in sync, and opens a folder in any app that fits.
- **Relates:** [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) (one engine per computer, which 0750 retired), [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) (one sync function), [ADR-0808](0808-a-files-version-is-its-git-blob-id-on-every-store.md) (writes that expect a version), [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) (attached apps), [ADR-0812](0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md) (the fit check), [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) (programs compose packages), [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) (MCP from a contract).
- **Unbuilt:** sync in `epicenter mcp`; apps publishing a view and a way to open a window on a folder; Open with, New folder for, and attaching an app by choosing it, in the Epicenter app (a folder is attached to an app by its client id today).

## Context

An app syncs its folder while its window is open (ADR-0806), so with every app
closed nothing syncs: a recording made before a laptop closes reaches no other
device until an app opens again. ADR-0713 once gave every computer one engine
that synced every folder, and ADR-0750 retired it because apps then could not
sync without Epicenter. A service that apps talk to would bring that dependency
back, with a protocol between programs and its versions.

Two programs can already sync one folder at once without losing an edit: a
local write names the version it replaces (ADR-0808), the manifest is written
the same way, and the server refuses a commit on a stale base, so the slower
sync runs again.

## Decision

**Every program keeps the folders it has open in sync, for as long as it has
them open.**

| Program | Keeps in sync | For as long as |
| --- | --- | --- |
| an app's window | its folder | the window is open |
| the Epicenter app | every folder in the Epicenter folder | it runs |
| `epicenter mcp` | the folders it writes | the agent runs it |
| `epicenter sync` | the folders named | the command runs |

No program coordinates with another. A folder's sync state is kept in its
`.epicenter/`, so every window shows the same marks whichever program synced.

**The Epicenter app has every folder open.** It starts at login, keeps every
folder in sync while it runs, with or without a window, and asks the server in
one request what changed across a person's folders.

**The Epicenter app knows an app only as data**: the view the app publishes and
the address that opens its window on a folder. From these it offers Open with
(the apps whose view fits a folder), New folder for an app, and, per folder, the
apps attached to it and a way to detach one. Its code names no app; a special
case for one app means a primitive is missing. It hosts no app.

**An agent reaches every folder by grant.** `epicenter mcp --all` gives an
agent every folder in the Epicenter folder, because the agent acts as the
person; an app reaches only the folders attached to it.

## Consequences

- A folder keeps syncing while its computer runs the Epicenter app, with every
  other app closed.
- An app needs no Epicenter to sync, and syncs alone where Epicenter is absent.
- Two programs syncing one folder make redundant requests; neither loses an
  edit.
- A new app appears in Open with once it publishes its view, without a change
  to Epicenter.
