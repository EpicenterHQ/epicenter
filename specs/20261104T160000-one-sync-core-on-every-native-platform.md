# One sync core on every native platform

**Date**: 2026-11-04
**Status**: Draft
**Owner**: Epicenter

## One sentence

Every native Epicenter program, on a desktop or a phone, links one Rust sync
core and keeps its items in a folder named from its site; the web stays
online; TypeScript remains the language of what people, apps and agents write.

This is a working document for a design conversation, not a decision. It
gathers what 2026-11-04 settled, the requirements that remain, and the
recomposition under discussion, so the reasoning can be reread later.

## What is already settled

| Decision | Record |
| --- | --- |
| Derive from the site; store only data, decisions, proofs, exceptions and caches | ADR-0730 |
| Every app signs in as its site; the account asks once per app | ADR-0731, ADR-0732 |
| Your own `git` in a folder is plain Git; Git configuration holds no Epicenter path | ADR-0733 |
| Every file other than an item is kept whole in Git LFS | ADR-0734 |
| Sync gives files a history; it never merges two | ADR-0735 |
| A person's own folder takes a name with a space | ADR-0736 |
| Epicenter reconciles only states it made; elsewhere it names the state and the command | ADR-0741 |
| Items are what you keep; documents are what's live | ADR-0742 |
| Tabs is a collection of saved tabs | ADR-0743 |
| Sync diffs state, because agents edit state | ADR-0744 |
| A browser extension writes through the local Epicenter engine | ADR-0745 |
| The web is online; offline needs an installed app | ADR-0746 |
| Git runs only as Git, on the desktop | ADR-0747 |
| Epicenter ships a portable Git inside the app, after a license review | ADR-0748 |
| Epicenter draws its boundaries where people already expect them | ADR-0749 |

Experiments already run and retired, with the record that retired them:

- Yjs as the authority with a Markdown working copy (ADR-0337, ADR-0418;
  the store removed by ADR-0534, the principle stated in ADR-0450): an edit
  did not count until it was imported.
- A TypeScript Git engine in every browser (ADR-0623; retired by ADR-0700):
  two history writers, binaries without a path, and stock Git unable to join.
- Desktop sync through the server's write path (stress test, 2026-11-04):
  loses offline history and each device's own committed version.

## Requirements

People:

- R1. A person with no technical background installs an app and it works at
  once, offline, without seeing the word Git.
- R2. A technical person, or their agent, works on plain files and real Git
  history, and every refusal names the command that resolves it (ADR-0741).
- R3. An app works alone; Epicenter and the account add capabilities
  (principle 6).
- R4. Offline means: edit locally, persist, sync later. It is promised only by
  installed apps (the web-online record).

Data:

- R5. Items are files named from the app's site (ADR-0722), with history the
  person owns and can take away.
- R6. One merge rule (`settle`): fields by key, the later write winning; the
  body by line, with conflict blocks left for agents.

Platforms:

- R7. Desktop: macOS first, then Windows and Linux.
- R8. Phones: an installed app, when the first app whose main use is on a phone
  away from a network appears.
- R9. Browsers: online when signed in, local only when signed out; extensions
  write through the local engine.

## Today's composition

```txt
apps (Svelte, TypeScript)  write files through the Tauri shell's roots
epicenter engine (Bun)      sync: runs system git or bundled git, settle as merge driver
Epicenter app (Tauri)       installs the engine link, runs sync --watch, Folders window
server (Worker)             Git host; settle for web writes
```

The merge (`settle`) is TypeScript and runs in three places: the engine's
merge driver, the server's write path, and tests.

## The recomposition under discussion

TypeScript for what people, apps and agents write; Rust for what must behave
identically on every native platform.

```txt
formats       contract JSON, items (Markdown), settle          one implementation
sync core     Rust: libgit2, LFS over HTTP, settle, first      one implementation,
              contact (ADR-0735)                                linked everywhere native
hosts
  CLI (Bun)         loads the core through Node-API (napi-rs); runs scripts and contracts in TypeScript
  desktop (Tauri)   each app links the core and syncs its own folder
  phone (Tauri)     each app links the core and syncs its own folder in its container
  Epicenter app     the library view, sync for folders whose app is not running, the extension host
  server (Worker)   settle compiled to WebAssembly from the same Rust source
  browser           no sync engine (the web is online)
```

Verified facts:

- Bun implements Node-API; a napi-rs addon loads in Bun, and
  `bun build --compile` embeds `.node` addons (DeepWiki, oven-sh/bun).
- gitoxide cannot push and has no LFS yet (DeepWiki, GitoxideLabs/gitoxide),
  so the core uses libgit2 (`git2`), which links without GPL distribution
  obligations (GPLv2 with a linking exception).
- Native messaging works from a Chromium extension to the engine through a
  wrapper executable (spike `claude/spike-native-messaging`, `fb9b3d5bb9`).

What it would remove:

- bundling a Git program (dugite-native) and its license review
- `git-lfs` on any `PATH`, including Chrome's
- the engine copy or link as a precondition for an app to sync
- two merge implementations drifting (TypeScript in the engine, TypeScript on
  the server) becomes one source compiled twice

What it would change:

- ADR-0713 (an app cannot sync without the Epicenter app) reverses: every
  app carries the core and syncs its own folder; Epicenter adds the library
  view, agents, extensions, and sync for apps that are not running.
- ADR-0748 (a bundled portable Git) is replaced by the linked core.
- Two programs may sync one folder (the app and Epicenter); Git's own lock
  files serialize them.

## Phones

- iOS gives each app a sandbox that the system does not evict, visible in the
  Files app. Apps from one developer team can share an App Group container,
  so Epicenter's own apps could share one folder root on a phone; another
  team's app cannot join it.
- Android gives each app its own storage, or a folder the person grants once
  through the Storage Access Framework.
- So on a phone each app keeps its own folder in its own container and syncs
  it with its own sign-in (ADR-0731). There is no local registry: the app
  knows its folder, and across devices the account's list of repositories is
  the index. The desktop's `~/Epicenter` root is a convenience of computers,
  not a requirement of the model.

## Open questions

1. Is "every app carries the sync core" the right reversal of ADR-0713, or
   does one engine per machine still earn its place?
2. Does `settle` move to Rust now, or when the phone app arrives?
3. Does the bundled portable Git (just approved) ship first as a stopgap, or
   does a libgit2 spike go first?
4. On a phone, do Epicenter's own apps share one App Group root?

## Spikes before any decision

1. libgit2 core: clone, commit, fetch, merge with `settle` (ported or called),
   LFS upload and download, push, against the hosted server, from a Rust test
   and from Bun through napi-rs.
2. The same core in a Tauri iOS simulator build.
