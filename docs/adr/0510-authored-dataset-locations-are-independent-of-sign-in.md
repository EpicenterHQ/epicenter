# 0510. Authored dataset locations are independent of sign-in

- **Status:** Proposed
- **Date:** 2026-10-08
- **Amends:** [ADR-0497](0497-browser-folders-use-scoped-opfs-directories.md), removing account and Local segments from authored OPFS addresses while preserving literal files, Git state, channel separation, locks, and incoming recovery.
- **Unbuilt:** stable-location application startup, transition of existing scoped folders and markers, connection controls, selected-dataset persistence, and browser/native account-change acceptance.
- **Relates:** [0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) retains exact account identity; [0489](0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md) describes explicit transfers; [0509](0509-folder-remotes-and-http-fetch-have-separate-contracts.md) separates destination from transport.

## Context

Todos can edit and record local Git history without authentication. Its browser
opener selects `so.epicenter.todos` in release Local OPFS. The browser folder
library also accepts account scopes. The native host's `prepare_folder` selects
`local/<id>` or `accounts/<account-key>/<id>` from its boot account. Signing in
can therefore change which dataset a native app opens while leaving the previous
files on disk.

Someone who starts locally wants to connect that same work later. Copying current
files into an account folder loses the original history and leaves two datasets
to maintain. Authentication should authorize a requested transfer without
choosing the files the person edits.

## Decision

**One dataset has one stable local directory containing its authored files and Git history.**

The default directory uses the application's existing folder ID. Another dataset
uses another explicitly selected folder ID. An application can interpret several
datasets with the same definition; an account name or email does not name a
dataset. Release and development remain separate.

```text
Native home/                         OPFS root, per origin/profile/
  Epicenter/                          Epicenter/
    so.epicenter.todos/                  so.epicenter.todos/
      todos/example.md                    todos/example.md
      definition.json                     definition.json
      .git/                               .git/
    so.epicenter.todos.work/             so.epicenter.todos.work/
  Epicenter Dev/                      Epicenter Dev/
    <folder-id>/                        <folder-id>/
```

These trees contain independent local copies with matching relative file paths.
OPFS's root is browser-private and cannot alias the native home directory. An
explicit native root override remains supported. Each captured dataset address
determines its directory, locks, and notification names without a current-login
component.

**Signing in, signing out, or changing accounts leaves the selected dataset and its remote unchanged.**

Authentication supplies a runtime capability for explicit transfers. A transfer
captures its account and destination and cannot borrow a successor account's
credentials. Switching from A to B does not upload A's files or replace them
with B's files. Opening another dataset is an explicit selection. Selection
metadata belongs to the device and contains no session credential.

Existing guarded departure and native process restart remain until their private
runtime lifetimes can support replacement. Restart reopens the same selected
authored dataset. Private SQLite, pending provider work, and provider credentials
retain their app/account ownership outside the authored tree.

**Connect chooses a destination for the selected dataset and preserves its files and history.**

The managed Connect action shows the selected folder, destination account,
repository, and that uploads include Git history. Confirmation captures that
target. Connection verifies access and configures the canonical `origin`; it
does not itself upload, replace files, merge histories, or reinitialize `.git`.
Sign-in and Sync never silently assign another origin. Changing the captured
destination requires closing and reopening its owner; native owners retain the
supported full-process departure boundary.

An empty remote can receive existing local history through explicit Sync. Getting
an existing remote into an unused local destination is explicit Download followed
by Open. Download refuses an occupied destination and offers a separate folder
ID. Connecting two independently established histories leaves reconciliation
visible; it grants no overwrite, force-push, or automatic conflict resolution.

**Git stores destination configuration; authentication remains outside the portable dataset.**

Browser `.git/config`, objects, refs, and index are literal OPFS files. Native Git
and isomorphic-git use their respective execution and recovery mechanisms; equal
relative paths do not promise byte-identical repository internals or full Git CLI
feature parity. `httpFetch` and credentials are runtime capabilities, never
serialized into `definition.json`, `.git/config`, or remote URLs.

Disconnect removes the configured destination through a supported owner-close
operation and preserves files and local history. It does not prove the retained
history is new or safe to publish elsewhere. Every subsequent managed connection
gets the same history disclosure. No account-provenance registry is introduced to
prohibit an explicitly confirmed publication to another account.

**Existing data changes location only through an explicit, verified transition.**

The flat layout is a target, not permission to initialize empty replacements.
Inventory old Local and account directories, origins, history, and pending
recovery before moving anything. Multiple existing copies remain distinct;
matching folder IDs do not authorize merging or choosing one silently.
Preserve source bytes and history until the destination reopens and is verified.
OPFS transition must account for unavailable portable directory rename and marker
addresses. Remove old lookup paths only after this transition is proven.

## Consequences

Local work can connect in place without a second copy or history loss. Account
changes stop retargeting authored files. Account-derived authored directories,
locks, discovery, and copy-only connection branches can be retired after the
transition. Exact account identity remains necessary for private runtime and
authorization.

Independent apps can calculate the usual default folder. They cannot infer which
additional dataset the person selected; selection needs an explicit path or
device-owned selection state. Multiple accounts no longer imply separate
authored datasets automatically. Separate browser origins still hold separate
copies even when folder IDs match.

People must review the history they publish when connecting. The app does not
claim software-enforced prior-account isolation. Shared-device visibility and
explicit local reset have separate contracts. Files and history remain locally
inspectable after authorization ends.

## Implementation gates

1. Preserve saved bytes, commit ancestry, origin, and selected folder across the
   existing-layout transition, including collisions and interruption.
2. Create/edit while signed out, connect, sign out, edit offline, sign in as B,
   and reopen. Verify the same location/history and no implicit upload or origin
   change in both browser OPFS and the exact native instance.
3. Exercise account change during connection confirmation and an admitted
   transfer. The request must retain its confirmed target or abort.
4. Download before opening, refuse occupied destinations, and demonstrate
   existing remote history and reconciliation without claiming unsupported merge
   behavior. Inspect saved files and settled Git history alongside the UI.

## Considered alternatives

- Account identity selects authored storage: separate account directories help
  discovery, but login changes the visible dataset and local-to-account copying
  duplicates work.
- One mutable repository replaced on each login: discards or combines unrelated
  work and makes account switching a content migration.
- A provenance registry refusing cross-account publication: enforces a stronger
  restriction than explicit destination confirmation, with additional policies
  for imported history and shared repositories.
- Live remote and account replacement: requires coordinating active writes,
  transports, and private work; closing and reopening is the initial boundary.

## Source evidence

- [Todos browser opener](../../apps/todos/src/lib/platform/folder.browser.ts).
- [OPFS addressing and publication](../../packages/folder/src/browser-adapter.ts).
- [Native folder selection](../../apps/epicenter/src-tauri/src/installed_apps.rs).
- [Account retirement](../../packages/auth/src/create-session-auth.ts).
- [Hosted connector](../../apps/api/worker/git-connector/README.md).
