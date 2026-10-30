# 0633. Apps open local data before connecting services

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amended by:** [ADR-0636](0636-an-app-opens-local-files-through-one-folder-handle.md) at runtime selection: browser origins reopen their local default; native apps supply their default or chosen directory; a later runner grants a directory to its window. Local identity remains independent of account and remote.
- **Amends:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) at apps entering through hosted repositories; [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) at repository consent as a prerequisite for browser use; [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) at every browser dataset having a remote; [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) with a `local` state for data without a sync destination; [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at `open` returning `undefined` without a hosted grant and its use of hosted identity to select local data; and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) at local opening and optional synchronization in principles 1, 3, 5, and 8.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (hosted repository IDs), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (text writes), [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) (local publication), and [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (optional schema files).
- **Unbuilt:** persisted app-facing local-to-remote connections, first attachment of existing local work, synchronization status and account-transition handling, and migration of existing browser data. Local opening and native app integration are implemented; current Folder status reports saving and storage failure, independently of network state.

## Context

ADR-0626 makes `open({ id?, tables })` return `undefined` when a browser
origin holds no hosted repository grant. It selects the most recently
consented grant when no ID is supplied. That permits offline use after
consent, but prevents a first launch from opening data without sign-in.

The internal `openRepository` in `packages/folder/src/browser/repository.ts` already
opens IndexedDB without authentication. `createSync` in
`packages/folder/src/browser/sync.ts` separately receives that repository, a URL, and
an HTTP transport. Local saving and network exchange have separate owners.
Neither constructor is a public app API yet.

Whispering must start with local data on desktop and in a browser. A person
may later connect synchronization, use only hosted inference, or never
sign in. The local dataset must survive each of those choices.

## Decision

**Apps open, read, save, close, and reopen local data before first sign-in.**
Desktop apps use ordinary local folders. Browser apps use their origin's
durable local storage. Opening and saving require no account, remote,
`epicenter.json`, or `table.json`. App code supplies its own read schemas;
generic tools may select a schema file (ADR-0632). Browser storage guarantees and
phone release checks remain those of ADR-0628.

**A local dataset has an identity independent of its sync destination.**
The app remembers which local dataset it opened. A hosted repository ID,
remote URL, account, or displayed name cannot substitute for that local
identity. An app can suggest its name for a new hosted repository without
making that name a lookup key or an exclusive claim to the data.

**Connecting synchronization attaches existing local work to one chosen destination.**
The person creates a hosted repository or selects one they can access.
Consent names its stable ID (ADR-0612 and ADR-0614). A name match may be
suggested but never silently attaches data. Connecting a nonempty dataset
to a nonempty remote explains that their contents will be combined and
requires that choice before applying the normal save and sync merge rules.
Selecting another dataset opens it separately; it does not combine datasets.

Desktop synchronization uses native Git through the Epicenter CLI with
the repository's configured remote and that host's credentials. It supports
Epicenter and other supported Git hosts without an Epicenter account for
those other hosts. Browser synchronization initially supports Epicenter's
Git service. No proxy, automatic mirroring, or second remote is required.

**No destination is a normal `local` state.** The app reports local saves
without suggesting a failed connection or work awaiting upload. Once a
destination is configured, `synced`, `pending`, `disconnected`, and `stuck`
retain their meanings from ADR-0624. Local save failures remain visible
regardless of connection state. A successful save acknowledges local
persistence; it does not acknowledge a commit or remote receipt.

**Authentication changes network access without deleting local work.**
Sign-in alone attaches no repository. Sign-out stops authenticated requests
and automatic sync without discarding saved data or unsaved input. An
account change never silently reconnects that data to another repository.
The app identifies which dataset is open and lets the person separately
remove its local contents when needed on a shared device.

## Consequences

- Browser-first and desktop-first users can create text before choosing
  hosting. First connection must preserve that text and incoming remote work.
- Apps need explicit dataset selection and connection state. A repository
  chooser cannot replace local opening.
- Compatible apps can deliberately use the same dataset. On disk they can
  open one folder; different browser origins keep separate local copies
  and exchange changes through the selected repository.
- Migration carries saved and unsent work before deleting old storage.
  Connecting, disconnecting, and reauthenticating do not recreate the dataset.
- The text-write boundary of ADR-0621 remains: full text files can travel,
  including content outside a schema file; managed audio and attachment sync is
  deferred. Existing binary Git content is not filtered out.

## Considered alternatives

- **Require browser consent before the first local open.** Removes later
  attachment of anonymous work, but makes account access a prerequisite for
  an app that can already save offline.
- **Use the remote repository's name or ID as local identity.** A dataset
  cannot exist before connection, and changing hosting risks selecting a
  different local store.
- **Automatically attach a repository with the app's suggested name.**
  Duplicate names and unrelated existing data make the selection ambiguous.
