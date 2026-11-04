# 0745. A browser extension writes through the local Epicenter engine

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) at "The Chrome extension runtime is refused", which [ADR-0724](0724-a-browser-extension-keeps-its-data-in-a-document.md) had amended for documents before [ADR-0743](0743-tabs-keeps-saved-tabs-as-items-in-a-collection.md) superseded it: a browser extension may run, and it writes items through the local engine; [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at "nothing moves between stores" and "Moving files between stores can return later as an explicit action a person takes, not a background rule": items an extension holds in its own storage move into the app's folder when the engine answers.
- **Relates:** [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) (one engine per machine), [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) (the engine is a link into the Epicenter app), [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) (principle 6: apps work alone), [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (turning on sync is the consent), [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) (an extension pairs with its desktop app).
- **Unbuilt:** all of it: the native messaging host manifest and the engine's host mode; the extension's own storage and the handover; the Sync button. A spike on branch `claude/spike-native-messaging` is verifying native messaging.

## Context

A browser extension runs inside the browser. It has the browser's storage
(`chrome.storage`, IndexedDB) and no file system, so on its own its data is
an island in one browser profile. That is why
[ADR-0724](0724-a-browser-extension-keeps-its-data-in-a-document.md) put Tabs
in a document synced through the account.

Under [ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md) a
saved tab is an item in a folder
([ADR-0743](0743-tabs-keeps-saved-tabs-as-items-in-a-collection.md)). On a
desktop, folders belong to the `epicenter` engine
([ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md)),
which syncs them with Git.

Chrome native messaging lets an extension exchange JSON messages with a
program the person installed. The program registers a host manifest naming
its executable and the extension origins allowed to call it
(`allowed_origins`); Chrome starts the program for each connection and
refuses every other caller. 1Password's extension pairs with its desktop app
this way.

## Decision

**A browser extension saves through Chrome native messaging to the
`epicenter` engine, which writes items into the app's folder.**

```txt
Tabs extension --native messaging--> epicenter --> ~/Epicenter/tabs/tabs/<id>.md
```

- The Epicenter app registers the host manifest at launch, as it points
  `~/.epicenter/bin/epicenter` at its bundled CLI
  ([ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)).
  The manifest allows only the origins of Epicenter's extensions.
- The engine checks each item against the app's contract and writes it at
  its path, as any writer of the layout does
  ([ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
- Sync, history, and agents come from the desktop: Git, `epicenter sync
  --watch`, and the folder's files.

**Without Epicenter, the extension keeps items in its own storage, local
only.** Saving never waits for Epicenter (principle 6 of
[ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md)),
and the panel says the saved tabs are in this browser only.

**When Epicenter appears, the extension hands its items over.** Whenever the
engine answers and the extension holds items, it writes each through the
engine and deletes it from its own storage once the engine confirms the
write. Ids are `timeId()`, so a held item never collides with one already in
the folder.

**The extension's Sync button asks the engine to sync the folder now,** as
`epicenter sync <dir>` does. When the folder has no consent to sync, the
engine says so and the panel offers to open Epicenter, where turning on sync
is the consent
([ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md)).

## Consequences

- The extension holds no account, grant, token, or sync code.
- Every browser and profile on one machine writes into one folder.
- On a machine without Epicenter, such as a Chromebook or a work laptop,
  saved tabs stay in that browser, and clearing the extension's storage
  loses them
  ([ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md)).
- The engine gains a native messaging mode that Chrome starts for each
  connection.
- Firefox registers its own host manifest in its own location; Safari's
  extension messaging differs and is decided when Tabs is built for it.

## Considered alternatives

- **A document synced through the account (ADR-0724).** Saved tabs are kept
  data ([ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md)).
- **The server's write path from the extension.** Every save needs sign-in
  and the network, and offline saves need an outbox, which
  [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) refuses.
- **A local HTTP server in the engine.** A listening port any page on the
  machine can call, with authentication of its own; native messaging
  admits only the listed extension origins.
- **Ask the person before each handover.** The extension's storage is a
  holding place, not a store a person chose, and the items are the person's
  own saves.
