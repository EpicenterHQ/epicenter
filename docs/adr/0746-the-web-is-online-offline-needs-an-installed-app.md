# 0746. The web is online; offline needs an installed app

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (the local web and online web variants, which stand), [ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md) (a browser variant's weaker guarantees), [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) (sync diffs state), [ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md) (an extension writes through the engine), [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) (a website needs the internet).
- **Amended by:** [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at "reads and writes the repository through `openRemote`": the repository is a place, `home({ site, account })`.
- **Amended by:** [ADR-0784](0784-whispering-is-the-webs-local-app-and-messages-is-a-program-on-this-computer.md) at "A web app holds no unsent work": a write waits in the page until it lands, behind the leave guard (ADR-0775).
- **Amended by:** [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) at "A web app is either local only or online": every web app is online.
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at "the desktop app with Epicenter": the installed app syncs its own folder.
- **Unbuilt:** two-way offline sync in a browser and installed phone apps, both deferred until the triggers below.

## Context

[ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md)
gave the web two variants. A local web variant keeps this browser's files
through `openDevice` from `@epicenter/folder/browser` and never syncs;
signing in grants capabilities such as hosted transcription, never storage.
An online web variant reads and writes the repository through `openRemote`
from `@epicenter/folder/remote`, works only online, and keeps nothing in the
browser.

Two requests keep asking for a third: a browser that edits offline and syncs
later. One comes from a person away from their desktop, often on a phone.
The other came from Tabs, which runs in a browser
([ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md)
answers it through the engine).

Offline sync in a browser needs each item's last agreed version kept as a
cache and changes sent over the server's write path
([ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md)), in storage
the browser may evict. iOS caps the storage a script may write for a site
not added to the home screen. A page cannot run work on a schedule, cannot
show its files in the Files app, and cannot run Git.

An installed phone app has each of those. The OS does not evict its sandbox.
Its folder can appear in the Files app. It can schedule background work. It
can run Git natively through a Rust library. Tauri mobile shares the Rust
folder plugin (`packages/tauri-plugin-epicenter-folder`) and the Svelte UI
with the desktop apps; the Bun engine does not run on iOS.

## Decision

**A web app is either local only or online.**

| | Local only | Online |
| --- | --- | --- |
| Data | this browser's storage | the account's repository, through the server |
| Signing in | optional; grants capabilities, never storage | required |
| Offline | works | does not work, and says so |
| Sync | none | each write is a commit |
| Copy in the browser | the only copy | none |

**Offline use with sync, agents on files, and local history need an
installed app: the desktop app with Epicenter.**

**Two-way offline sync in a browser and phone apps with a local engine are
deferred.** Each has a trigger:

| Deferred | Built when | Built as |
| --- | --- | --- |
| an installed phone app | the first app whose main use is on a phone away from a network | a Tauri mobile app with the Rust folder plugin, the Svelte UI, and Git from a Rust library |
| two-way offline sync in a browser | a person with no computer that can run Epicenter, such as a Chromebook, needs to edit offline | each item's last agreed version as a cache, with changes sent over the server's write path ([ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md)) |

A phone's need for offline use is answered by an installed phone app, never
by offline sync in a phone's browser.

## Consequences

- A web app holds no unsent work. An online write lands or fails in front of
  the person; local-only data never leaves the browser.
- On a phone or a Chromebook, a person works online, or local only in one
  browser.
- Epicenter writes no browser sync code: no cache of agreed versions, no
  recovery from eviction, no coordination between tabs.
- The browser can still evict local-only data
  ([ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md)).
- A person who wants offline use and history on a computer installs the
  desktop app with Epicenter.

## Considered alternatives

- **Two-way offline sync in every browser now.** A cache of agreed versions,
  recovery from eviction, and cross-tab coordination, for people who mostly
  have a desktop that already does this.
- **A Git clone in each web origin
  ([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md)).**
  Retired by ADR-0700; see
  [ADR-0747](0747-git-runs-only-as-git-on-the-desktop.md).
- **A web app added to the phone's home screen.** Lifts the storage cap,
  and still has no Files folder, no scheduled background work, and no Git.
