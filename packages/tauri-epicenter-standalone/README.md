# Standalone desktop apps

A standalone Epicenter app is its own small Tauri program over a folder it
owns (decisions 79 to 82, 88 to 97). This crate is the Rust every such app
shares, so each app's `src-tauri/src/main.rs` stays a few dozen lines.
On the page, `openFolder(contract, home({ site }))` from `@epicenter/folder`
opens the data folder in a Tauri window, and `settings` from
`@epicenter/local` is this computer's settings in AppData. A desktop app
does not sync
([ADR-0822](../../docs/adr/0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md)).
The page's recovery UI is in `@epicenter/svelte`.

## Two named roots

Startup names two roots, which the page opens by name through the folder
plugin; nothing is granted or stored
([ADR-0725](../../docs/adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)).

- **AppData** is the operating system's application data directory, used by
  apps with machine-local settings such as shortcuts or connections. The
  page's first open makes it. An app that signs in keeps its secrets there
  too: [`epicenter-account`](../tauri-epicenter-account/README.md) writes
  `credentials.json`, which no page reaches, and `account.json`, who is
  signed in, which the page reads like any setting.
- **Data** is `<Epicenter folder>/<name>`. The name comes from the app's bundle
  identifier, the reversed host of its site (`so.epicenter.whispering` is
  `~/Epicenter/whispering`). The Epicenter folder is `~/Epicenter`, or
  `~/Epicenter Dev` in development (ADR-0816; the Rust code and its comments
  still call it the library root). A folder the app already opened is found
  by its identity wherever it is in the Epicenter folder (below).

The environment is stated, never guessed from the identifier. Only the
development configuration (`tauri.dev.conf.json`, used by
`bun dev:<app>:desktop`) states one:

```json
"plugins": { "epicenter-standalone": { "environment": "development" } }
```

Its identifier is the production one with `.dev` appended, and the shell
removes that suffix in development alone, so a production site whose first
label is `dev` keeps it. A configuration that states something else, or a
development identifier without `.dev`, fails startup
(`StartupError::Environment`, `StartupError::Identity`).

## Finding the data folder

An app finds its folder by its identity (ADR-0822). Each time the page
opens Data, the shell remembers the folder's inode and birth time in
`data-folder.json` at the top of AppData (`data_identity::remember`), a
file the folder plugin keeps from every page. At the next start, before it
names Data at its derived path, it looks for the directory those prove: the
derived path itself, then each directory directly inside the Epicenter
folder (links followed, hidden names skipped). A folder the person renamed
in the Epicenter folder opens by its new name, and an empty folder made at
the old name meanwhile is not taken for it. An identity without a real birth
time proves nothing, so on a file system without birth times a renamed
folder is not followed and the derived path opens.

Any directory directly inside the Epicenter folder can be the app's folder.
Launched as `<app> --folder <name>` or `--folder <absolute path>` (or
`--folder=<...>`), the app names Data at that directory, which must be in the
Epicenter folder (a link there included), and remembers it once the page
opens it. Any other argument stops startup with its reason
(`StartupError::Folder`). Finder's Open With sends an open event rather than
an argument, which nothing handles yet.

## Opening

Startup names both roots before the window opens. The page then opens Data
off the window thread. Whatever is at its path is the app's
([ADR-0726](../../docs/adr/0726-an-apps-path-is-its-claim.md)): the folder is
made when nothing is there, and a link there is followed. A link whose target
is gone makes nothing and answers `Disconnected`. A data root that resolves to
the person's home folder, a folder holding it, or the Epicenter folder itself
answers `Refused` (`refusal`, the one refusal). The page shows either failure
in Recovery with Retry. `open_root` also answers the named path the page shows.

## Window and Quit

Startup opens one plain window, `<page>:main`, which the app's capability
selects (`<page>:*`). Quit quits (on macOS, the default menu's Quit and
Cmd-Q), and a window closes at once: nothing waits for the page. Every
plugin still hears the window's `Destroyed` and the app's `Exit`, where the
recorder finishes a recording in progress. WebView files live in the app's
cache directory, outside both roots. A configuration or window failure
(`StartupError`) shows one dialog saying why, with only Quit.

```rust
const CAPTURE: StandaloneApp = StandaloneApp {
    page: "capture",
    title: "Capture",
    size: (760.0, 720.0),
};

epicenter_standalone::builder(CAPTURE).run(tauri::generate_context!())
```

The builder registers the folder plugin and the dialog plugin, whose only
use is the startup failure dialog. The app's capability grants
`epicenter-folder:default` and nothing for a folder, and each configuration
lists it in `app.security.capabilities`, so nothing in `capabilities/` is
enabled implicitly (Tauri replaces, not appends, the list a `--config` file
gives). The folder plugin must also be a direct dependency of the app, so
`tauri-build` finds its permissions. The crate is a member of the root
Cargo workspace (`cargo test -p epicenter-standalone`).

## Giving a web app a desktop window

The desktop window loads the web app's own build: one build and one
typecheck serve both
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
Nothing in the app chooses by surface; each capability package decides when
the page runs (see the `platform-seams` skill), and the routes stay the same.

1. **Capabilities.** The store needs nothing: `src/lib/app.ts` calls
   `openFolder(contract, home({ site, account }))`, and in a Tauri window
   `home` is the data folder. Where a view differs, branch on what a
   capability offers: `folder.reveal` is there for a folder on this
   computer, so the header shows `FolderChrome` there and
   `RepositoryChrome` otherwise. `apps/todos` is the smallest worked
   example.
2. **Build.** `src-tauri/tauri.conf.json` loads `../build` and builds it
   first (`"beforeBuildCommand": "bun run build"`); `tauri.dev.conf.json`
   loads the app's dev server (`"devUrl": "http://localhost:<port>"`,
   `"beforeDevCommand": "bun run dev"`). The app's `dev:desktop` is
   `tauri dev --config src-tauri/tauri.dev.conf.json`, and `build:desktop`
   is `tauri build --bundles app`.
3. **Guard.** `scripts/first-load.test.ts` holds the app's first load in a
   browser to no desktop module; add the app to its list.
