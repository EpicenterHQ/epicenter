# One sync core on every native platform

**Date**: 2026-11-04
**Status**: In Progress
**Owner**: Epicenter

## One sentence

Every native Epicenter program, on a desktop or a phone, links one Rust sync
core and keeps its items in a folder named from its site; the web stays
online; TypeScript remains the language of what people, apps and agents write.

This is a working document for a design conversation. It gathers what
2026-11-04 settled, the requirements that remain, and the recomposition, so
the reasoning can be reread later.

**Decided (2026-11-04).** The libgit2 spike (branch
`claude/spike-sync-core`, commits `8dc6d63ed0` to `ca35dbe098`) answered,
and the founder accepted three records:

| Record | Decision |
| --- | --- |
| [ADR-0750](../docs/adr/0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) | Sync is like save: any program can sync a folder, and none owns it |
| [ADR-0751](../docs/adr/0751-every-native-app-carries-one-sync-core.md) | Every native app carries one sync core (supersedes ADR-0748; amends ADR-0713) |
| [ADR-0752](../docs/adr/0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) | An app's folder sits under the platform's visible root of app folders |

What remains here is the plan for building them. Tabs keeps its items flat
in its folder (`~/Epicenter/tabs/<id>.md`, contract path `{id}.md`).

## What is already settled

| Decision | Record |
| --- | --- |
| Derive from the site; store only data, decisions, proofs, exceptions and caches | ADR-0730 |
| Every app signs in as its site; the account asks once per app | ADR-0731, ADR-0732 |
| Your own `git` in a folder is plain Git; Git configuration holds no Epicenter path | ADR-0733 |
| Every file other than an item is kept whole in Git LFS | ADR-0734 |
| Sync gives files a history; it never merges two unrelated histories | ADR-0735, ADR-0761 |
| A person's own folder takes a name with a space | ADR-0736 |
| Epicenter reconciles only states it made; elsewhere it names the state and the command | ADR-0741 |
| Items are what you keep; documents are what's live | ADR-0742 |
| Tabs is a collection of saved tabs | ADR-0743 |
| Sync diffs state, because agents edit state | ADR-0744 |
| A browser extension writes through the local Epicenter engine | ADR-0745 |
| The web is online; offline needs an installed app | ADR-0746 |
| Git runs only as Git, on the desktop | ADR-0747 |
| Epicenter ships a portable Git inside the app (superseded by ADR-0751) | ADR-0748 |
| Epicenter draws its boundaries where people already expect them | ADR-0749 |
| Sync is like save: any program can sync a folder, and none owns it | ADR-0750 |
| Every native app carries one sync core | ADR-0751 |
| An app's folder sits under the platform's visible root of app folders | ADR-0752 |
| An app declares what it is and what it needs; the platform supplies where, how and when | ADR-0753 |
| A capability takes what it needs as values and shows what it can do now as values | ADR-0754 |
| Epicenter's packages are capabilities, formats, framework layers and programs | ADR-0755 |
| An app's native shell is linked from its capabilities | ADR-0756 |
| Every model is an endpoint; every model file is a cache | ADR-0757 |
| Epicenter adapts to what you already have and owns only what nothing else can | ADR-0758 |
| Epicenter is made of standards and places | ADR-0762 |
| An app's native shell is generated on every build | ADR-0759 |
| Global shortcuts are a capability | ADR-0760 |

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
  Epicenter app     the library view, sync of every consented folder while it runs, the extension host
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
  view, agents, extensions, and syncs every consented folder while it runs.
- ADR-0748 (a bundled portable Git) is replaced by the linked core.
- Two programs may sync one folder (the app and Epicenter). Git's own locks
  guard single operations, not a fetch, commit, merge and push round, so the
  core holds `.git/epicenter-sync.lock` for the whole round, as
  `packages/cli/src/sync/sync.ts` does today; a held lock returns Retry.

## The composition the council agreed (2026-11-04)

Three independent seats (two Codex, one Claude) reached the same shape.

**Sync is an operation on a folder, not a role a program plays.** The folder
holds its own consent (`epicenter.synced`), state (`.git`) and exclusion (the
round lock). Any program with a credential may run a round, and programs
never call each other: they meet only in the folder. This deletes routing
folders to a syncer, "whose app is not running", the `epicenter://init`
hand-off, and "Syncing needs Epicenter".

```txt
crates/
  epicenter-formats   item codec, settle, conflict blocks; native and wasm32 (Worker, page)
  epicenter-folder    paths, admission, put/read/list/watch, and sync: git2, LFS, round lock, first contact
  epicenter-account   the credentials file (ADR-0740): the only reader, writer and refresher
  epicenter-napi      Node-API binding for the CLI
  epicenter-host      the native messaging host: the extension's shell
```

```rust
pub struct Library;
impl Library { fn at(root: &Path) -> Self; fn folders(&self) -> Vec<Result<Folder, FolderError>>; }
impl Folder {
    fn open(path: &Path) -> Result<Folder, FolderError>;   // creates when empty (ADR-0726)
    fn sync_state(&self) -> SyncState;                      // Local | Synced | Refused { command }
    fn preview_sync(&self, remote: &Url, auth: &dyn Bearer) -> Result<FirstContact, SyncError>;
    fn turn_on_sync(&self, approved: FirstContact, auth: &dyn Bearer) -> Result<Round, SyncError>;
    fn sync(&self, auth: &dyn Bearer) -> Result<Round, SyncError>;   // Synced | Retry | Stopped { command }
    fn keep_synced(&self, auth: Arc<dyn Bearer>) -> Syncing;         // dropping it stops it
}
pub trait Bearer { fn token(&self, remote: &Url) -> Result<Option<String>, AuthError>; }
```

- A standalone app holds `folder.keep_synced(account)` while it runs; quitting
  drops it (ADR-0749: quitting stops what an app does).
- Epicenter holds one `keep_synced` per consented folder in
  `Library::at(~/Epicenter)`; a held lock returns Retry.
- The CLI's `sync` is the same call through Node-API.
- The native host serves the same list, read, put and watch commands as the
  Tauri plugin, plus sync: the extension is an app page whose shell is the
  host.
- Credentials: each program keeps its own file in its AppData;
  `epicenter-account` is its only refresher (today there are two, in
  `packages/cli/src/auth.ts` and `packages/tauri-epicenter-account`).

**Where folders live: under the platform's visible root of per-app folders.**
iOS and Android show each app's folder ("On My iPhone > Whispering"), so the
operating system supplies the root. A computer has no such root, so Epicenter
names `~/Epicenter`. AppData is refused for items: it is hidden, it is the
place a reset deletes (ADR-0740), and discovering other apps' AppData needs a
registry or permission prompts.

Counted removal: about 7,300 non-test lines (`cli.rs` and `synced_folders.rs`
2,532; `packages/cli/src/sync` 2,481; the native host, node store and
Epicenter hand-off 980; the TypeScript and Rust credential code 1,232; the
SQLite lock 107). Estimated addition: 3,000 to 4,500 lines of Rust.

New obligations: LFS clean, smudge and batch inside the core (CI proves stock
`git fsck` and `git lfs fsck` accept its output); `settle` in Rust with the
TypeScript property tests as shared fixtures; an `epicenter.format` key so an
older core refuses a newer folder ("update Whispering"); a lock compatible
with today's during migration (`fcntl` locks on Linux); sign-in and the
consent screen in every app; the napi and iOS build matrix.

### Refinement: the shell syncs, app code never does (2026-11-04)

`keep_synced` handles made app code babysit a syncing object, which is sync
as a role again. Instead `folder.sync()` runs one round, and the shell that
already opens the Data root decides when. The timer and reconnect first
proposed here were dropped: ADR-0750 settles the moments as open, a few
seconds after a save, return to the window, and Sync, with no watcher,
interval, or background service. That timing lives once, in
`tauri-plugin-epicenter`. App code contains no sync code; Epicenter's shell
runs a round over every consented library folder at the same moments; the
CLI runs one round, or `--watch` for a person in a terminal. A
program's account is fixed for its lifetime and passed once to
`Folder::open`, so `sync()` takes no arguments.

```rust
let folder = Folder::open(path, &account)?;
folder.sync()?;   // Synced | Retry | Stopped { command }
for folder in &held { folder.sync()?; }   // an app holds one; Epicenter holds the library
```

Two crates, one per boundary: `epicenter-core` (items, settle, roots, sync,
credentials; built native, as WebAssembly with only settle and the item
codec, and as a Node-API library for the CLI) and `tauri-plugin-epicenter`
(commands, events, the shell's sync timing; replaces today's folder plugin).
The native host stays the CLI subcommand `epicenter native-host`.

## The package map (audit, 2026-11-04)

Decided in ADR-0755 (the map and the moves) and ADR-0754 (the composition
rule); ADR-0760 adds `shortcut`, and ADR-0757 gives `ai` its endpoint
shape.

Three seats (one Codex, two Claude) audited the 22 packages by kind, callers
and caller code. The founder accepted the experience seat's map: 11
TypeScript packages and 4 Rust crates (plus the transcription build helper).

| Package | One sentence |
| --- | --- |
| `definition` | what an app's files are, how two versions settle, and the names its site derives |
| `folder` | open an app's folder as its contract's client, and this device's place |
| `account` | this app's credentials: its Epicenter sign-in and the person's provider keys |
| `recorder` | recordings written into the folder as they record |
| `ai` | requests to a model the person chose, and the agent loop |
| `transcription` | models on this computer (`null` in a browser) |
| `shortcut` | global shortcuts (`null` in a browser; ADR-0760) |
| `svelte` | contract reactivity, startup and recovery, status |
| `ui` | components |
| `vite-config` | the base config and the desktop condition |
| `cli` | the `epicenter` command |
| `server` | the API |
| Rust: `epicenter-core`, `tauri-plugin-epicenter`, `tauri-plugin-epicenter-recorder`, `tauri-plugin-epicenter-transcription` (with its build helper as a sub-crate) | |

Moves: `agent`, `agent-protocol` and `client` merge into `ai` (the protocol
is the type contract the loop and the model client shared; inside one package
it needs no package of its own); `principal` merges into `account` (renamed
from `auth`); `capture` moves into apps/capture; `constants` splits by owner
(site names into `definition`, providers into `ai`, ports into `vite-config`,
routes into `server`); the three desktop shell crates become
`tauri-plugin-epicenter`; a capability keeps its TypeScript and its Rust
plugin in one directory and may export `./svelte` for its own settings UI;
the copied startup and chrome components collapse into `svelte`.

**Composition rule: values in, availability out.** A capability takes what it
needs as values and never imports another capability; what it can do right
now is a value that is present or `null`. The account is live
(`account.current()` returns `Account | null`), so capabilities receive the account,
never a snapshot, and follow sign-in without a reload (only the online web,
whose data depends on the account, reloads).

```ts
export const account = connectAccount();
export const folder = await openFolder(whispering);
export const ai = openAi([hosted(account), ...keys.map(custom), localServers(), localSpeech()]);
// hosted: empty until signed in; localSpeech(): null on the web (ADR-0757)
```

Build-time selection: a capability's `.` export is
`{ "tauri": ..., "default": ... }` (`tauri` first; the web leaf is `default`,
not `browser`, because `desktopVariant()` keeps Vite's `browser` condition);
explicit `./tauri` and `./browser` subpaths stay for tests and for shared code
that needs one side (Vocab's dictation). An intermediate package takes
capabilities as values so its own typecheck covers one leaf honestly.
`#platform/*` remains only for app-owned native features and the web
sign-in callback; Whispering's shortcut is now the `shortcut` capability
(ADR-0760).

Open: Whispering's web build is local only even when signed in, which
differs from R9. Unifying the two HTTP relays (Whispering's `http.rs` and
the account crate's `relay.rs`) into the shell's one fetch, which moves
Whispering's provider keys from the page into the shell, is decided in
ADR-0757.

## Proposals decided (2026-11-04)

The founder accepted the proposals made here as four records:

| Record | Decision |
| --- | --- |
| [ADR-0753](../docs/adr/0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) | An app declares what it is and what it needs; the platform supplies where, how and when (amends ADR-0719) |
| [ADR-0754](../docs/adr/0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) | A capability takes what it needs as values and shows what it can do now as values, including AI's sources in the order local, hosted, custom (the AI example amended by ADR-0757) |
| [ADR-0755](../docs/adr/0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) | Epicenter's packages are capabilities, formats, framework layers and programs (the map above) |
| [ADR-0756](../docs/adr/0756-an-apps-native-shell-is-linked-from-its-capabilities.md) | An app's native shell is linked from its capabilities: autolinking, `native/`, the app layout, and `epicenter new` in place of a wrapper (`native/` and the layout amended by ADR-0759) |

## Decided later (2026-11-04)

The founder accepted six more records:

| Record | Decision |
| --- | --- |
| [ADR-0757](../docs/adr/0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) | Every model is an endpoint; every model file is a cache: `openAi([...endpoints])`, an endpoint is `{ id, fetch, models() }` with a Fetch API `fetch`, one client posting the OpenAI-compatible vocabulary through it, `localSpeech()` an in-process fetch, model files in the Hugging Face cache (amends ADR-0754) |
| [ADR-0758](../docs/adr/0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md) | Epicenter adapts to what you already have and owns only what nothing else can: syncing folders and the merge rule |
| [ADR-0759](../docs/adr/0759-an-apps-native-shell-is-generated-on-every-build.md) | An app's native shell is generated on every build and never committed; app-specific native code lives in `modules/<name>/`; a development host for `bun dev:<app>` (amends ADR-0753, ADR-0756) |
| [ADR-0760](../docs/adr/0760-global-shortcuts-are-a-capability.md) | Global shortcuts are a capability, `@epicenter/shortcut` (amends ADR-0753, ADR-0755) |
| [ADR-0761](../docs/adr/0761-sync-never-merges-two-unrelated-histories.md) | Sync never merges two unrelated histories; offline commits merge as branches of one history (amends ADR-0735) |
| [ADR-0762](../docs/adr/0762-epicenter-is-made-of-standards-and-places.md) | Epicenter is made of standards and places: interfaces are standards someone else maintains, and programs meet only in shared places |

Open, not decided: whether the agent loop speaks the OpenAI vocabulary
directly instead of its own message types (`packages/ai/src/agent/engine.ts`,
translated by the 280 lines of `packages/ai/src/openai/agent-engine.ts`),
pending a measurement of that translation code (ADR-0762).

**Execution.** Two independent tracks in separate worktrees: package moves
(`ai` merge, `account` rename with `principal`, `capture` into its app,
`constants` split, one shell crate), now running on branch
`claude/package-moves`, and the core (transport, async binding,
repack, lock, `settle` port). They meet in the wiring; autolinking and the
template follow; a phone app waits for the first app whose main use is on a
phone away from a network.

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
  the index. One folder per app on phones (founder, 2026-11-04, 70/30); an
  App Group root waits for the first phone use that needs another app's data
  offline.

## Questions this document asked, and their answers

1. Every app carries the sync core, reversing ADR-0713 (ADR-0751).
2. `settle` moves to Rust in the core's first commits; the server keeps the
   TypeScript `settle` until a single source is wanted (ADR-0751).
3. The libgit2 spike went first, and the portable Git never ships (ADR-0751
   supersedes ADR-0748).
4. One folder per app on a phone; an App Group root waits (ADR-0752).

## Plan

Each step is a set of standalone commits. The spike's code on
`claude/spike-sync-core` (`packages/sync-core`) is the starting point, not a
dependency.

### 1. The core's first commits

In `epicenter-core`, each closing an item of ADR-0751's `Unbuilt` line.

**Built (2026-11-04, branch `claude/sync-core`, merged into phase 2):**
steps 1 to 3 and 5, plus the lock half of step 4, as
`packages/epicenter-core` (commits `41b002da22` to `3450eb30ec`): ureq with
rustls sharing one connection pool for Git and LFS, the token sent only to
the remote's origin; `fcntl` locks on the bytes SQLite locks, so the core and
the CLI exclude each other; repacking above 8 packs or 256 loose objects; the
`filter.lfs.*` settings without paths; an async Node-API binding (2.54 MiB)
with `settle` passed in from TypeScript. Remaining here: the working-tree
recheck, paths and renames (step 6), and `settle` in Rust (step 7). Known
limits: a redirecting remote stops the round as refused, because the token is
not resent after a redirect; certificates are verified against Mozilla's
roots, not the system's.

1. **Transport.** A Rust smart-HTTP transport registered with libgit2 in
   place of its HTTPS: one TLS stack, no OpenSSL (5.5 MiB to 2.5 MiB for the
   addon), and the blocker for iOS removed.
2. **Async binding.** The Node-API binding runs a round off Bun's event
   loop, so `epicenter native-host` keeps answering during a round.
3. **Repack.** libgit2 cannot `gc`; the core keeps a folder's loose objects
   bounded itself. The spike already writes a round's objects as one pack
   (`bf40d8d988`).
4. **Lock and recheck.** The round holds `.git/epicenter-sync.lock`, taken
   the same way `packages/cli/src/sync/sync.ts` takes it while both exist
   (`fcntl` locks on Linux), and rechecks the working tree before merging,
   so a save that lands during a round is not overwritten.
5. **Git LFS settings.** The core writes `filter.lfs.clean`,
   `filter.lfs.smudge`, `filter.lfs.process`, and `filter.lfs.required`
   (ADR-0733), so a person's own `git` reads the folder.
6. **Paths.** Paths that differ only in case, and renames, which reach
   `settle` as two new items.
7. **`settle` in Rust.** A port of `packages/definition/src/merge`, with its
   TypeScript tests (including `settle.properties.test.ts`) run as shared
   fixtures against both.
8. **iOS build.** Proven 2026-11-04 (branch `claude/spike-sync-core-ios`):
   with git2 `default-features = false, features = ["vendored-libgit2"]` the
   core builds for `aarch64-apple-ios` and `aarch64-apple-ios-sim`, passes all
   native round tests, and links at 2.56 MB with no OpenSSL (5.77 MB with
   it). A Rust transport registered for `https` through
   `git2::transport::register` carries a whole round
   (`packages/sync-core/tests/transport.rs`); it takes the bearer token in
   its factory, because `FetchOptions::custom_headers` never reaches a
   registered transport. The device build sets `IPHONEOS_DEPLOYMENT_TARGET`
   (17.0). Remaining: running inside a Tauri iOS simulator app, which needs
   a simulator runtime download.

### 2. Wiring

1. **`tauri-plugin-epicenter`.** Replaces
   `packages/tauri-plugin-epicenter-folder`: the shell's list, read, put, and
   watch commands, `Folder::open`, and the moments of ADR-0750 (open, a few
   seconds after the last save, window focus, Sync).
2. **The CLI on the core.** `epicenter sync` and `epicenter native-host`
   load the core through Node-API; the Git runner in `packages/cli/src/sync`
   retires.
3. **The Epicenter app on the core.** It syncs every consented folder in the
   library at its moments through the plugin, and its CLI spawning is
   deleted: `apps/epicenter/src-tauri/src/cli.rs` and
   `apps/epicenter/src-tauri/src/synced_folders.rs`.
4. **Agents.** The generated `AGENTS.md` block
   (`packages/folder/src/agents-note.ts`) tells agents to run
   `epicenter sync <dir>` before they start and after they finish.

### 3. Phase 2's remaining work, on `Folder`

Move, Restore, and sign-in, recast on the core's `Folder`
(`Folder::open`, `preview_sync`, `turn_on_sync`, `sync`) instead of the
CLI's commands. Each app shows sign-in and the first-contact consent screen
itself (ADR-0735, ADR-0751).

### 4. Tabs

The extension plus its native host, `epicenter native-host`, writing a flat
folder: `~/Epicenter/tabs/<id>.md`, contract path `{id}.md`. The host syncs
after the extension's saves and on its Sync button (ADR-0750).

### 5. Capabilities and the generated shell

1. **`@epicenter/ai` as endpoints (ADR-0757).** `openAi([...])`, the
   endpoint shape `{ id, fetch, models() }` with per-model capabilities
   (`chat`, `transcribe`, `embed`), `hosted(account)` (`account.fetch` at
   `<origin>/v1`), `custom(key)` (the shell's fetch on the desktop) and
   `localServers()` (plain `fetch` to localhost), and one client,
   `@epicenter/ai/openai`, posting OpenAI-shaped requests through
   `endpoint.fetch`. On the desktop keyed requests go through the shell's
   one fetch: Whispering's
   `apps/whispering/src-tauri/src/http.rs` and
   `packages/tauri-epicenter-account/src/relay.rs` become one relay.
   Whispering's per-provider routing (about 620 lines in
   `apps/whispering/src/lib/platform/browser.ts` and
   `apps/whispering/src/lib/platform/services.tauri.ts`) collapses into its
   `openAi([...])` array.
2. **`@epicenter/transcription` exposing `localSpeech()`.** The
   transcription plugin's package, renamed from
   `@epicenter/transcription-native` and moved to `packages/transcription`;
   its endpoint's fetch answers
   `/audio/transcriptions` by calling transcribe.cpp in the app's process,
   and its handle carries download, remove, load, and unload. `docs/guides/self-hosted-transcription-speaches.md` is stale
   after the package moves (it imports `transcribe` from
   `@epicenter/client`) and is rewritten here, with a Speaches server as a
   `custom(key)` endpoint.
3. **`@epicenter/shortcut` (ADR-0760).** TypeScript plus
   `tauri-plugin-global-shortcut`; Whispering's `shortcut.rs` and the
   Epicenter app's direct registration go.
4. **The generated shell and `modules/` (ADR-0759).** The generator writes
   `tauri.conf.json`, `Info.plist`, entitlements, permissions, `main.rs` and
   the Cargo project from the site, the app's capabilities, and `icon.png`
   into a gitignored directory; each app's committed `src-tauri/` is
   deleted. Adding a capability is
   `bun add '@epicenter/<capability>@workspace:*'` (a bare
   `bun add @epicenter/<capability>` queries npm and fails for a private
   workspace package, checked with Bun 1.4.3).
5. **The development host.** After the generator: one prebuilt shell with
   every capability's plugin, so `bun dev:<app>` needs no Tauri build.
   Release builds still generate each app's own shell.
