# 0894. Whispering 8 keeps its recordings and their audio in its own data directory, and needs no Epicenter

- **Status:** Proposed
- **Date:** 2026-11-13
- **Supersedes:** [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) (a program's Git clone, filed by the host) and [ADR-0888](0888-the-host-merges-with-gits-line-merge-and-a-file-it-cannot-merge-takes-the-later-side-whole.md) (merging what a clone pushes).
- **Amends:** [ADR-0890](0890-a-programs-folder-is-its-own-and-holds-only-what-its-apps-contract-declares.md) at the default folder (`data/` in the program's local data directory, not `~/Whispering`), at `recordings/k3x9.local.webm` (audio is `recordings/k3x9.webm`), and at "holds only what the contract declares" (and the files beside a record that share its id). [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) at the `clone` noun, which goes. [ADR-0892](0892-the-cli-releases-to-npm-and-whispering-8-is-a-new-install-with-its-own-update-address.md) at "Import from Whispering 7", which goes. [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) at the `.local` row's "precious, kept here on purpose", the "Keep audio on this Mac only" setting, and the rejection of the app data directory. [ADR-0856](0856-binary-files-go-through-git-lfs.md) at Whispering's "Keep audio on this Mac only", which goes.
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (the folder sync product, whose client Whispering stops using), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) and ADR-0890 (a program's sign-ins stay in the Keychain), [ADR-0893](0893-a-records-path-is-its-path-in-the-apps-data-repository.md) (a record's path, which is its path in this folder), [ADR-0900](0900-a-program-may-hand-its-new-records-over-to-a-home-which-then-holds-them.md) (how recordings reach a home), [ADR-0943](0943-epicenters-core-invariants.md) (what a simplification removes, and who accepts it), [ADR-0950](0950-api-epicenter-so-is-a-model-api-and-every-client-reaches-it-with-an-api-key.md) (Epicenter's models, reached with an API key).
- **Unbuilt:** all of it, in Whispering 8.0.

## Context

Whispering is the one program people other than its author install. Version
8 is a new install with its own identifier (ADR-0892), and its author chose a
clean break. On the author's Mac, v7.11 keeps 15,309 recordings as Markdown
in `~/Library/Application Support/com.bradenwong.whispering`, 2.7 GB of
models beside them, and 7 GB in WebView storage (IndexedDB). The released
v7.11.0 has no sign-in and calls no Epicenter service.

On `main`, unreleased, Whispering writes through `@epicenter/folder`, the
client of the folder sync product (`apps/whispering/src/lib/app.ts:44`).
`home()` (`packages/folder/src/home.ts`) opens the data folder through
`tauri-plugin-epicenter-folder` on the desktop, and in a browser joins a
folder on the hosted server at `api.epicenter.so/folders/<id>`, which needs
the `folders` OAuth audience. The browser build is not deployed. Its
model picker merges four kinds of endpoint: Epicenter's hosted models through
a signed-in account, the person's own provider connections, local servers,
and the engine inside the app (`apps/whispering/src/lib/app.ts:72`). Only the
first uses `@epicenter/account`. This computer's settings are files at the
top of the app's data directory on the desktop and `localStorage` on the web,
through `@epicenter/local`, which `@epicenter/account` and `@epicenter/ai`
also import. `@epicenter/definition` holds Whispering's contract and ids and
the site constants (`APPS`, `localUrl`, `resolveOAuthAudiences`) that
`apps/api` and `@epicenter/account` read. Local models live in the shared
Hugging Face cache (`packages/transcription/src/lib.rs:5-8`).

ADR-0887 gave a program a Git clone of its app's data. A clone needs Git on
every device, and a phone or a browser tab has none.

## Decision

**Whispering 8 keeps its recordings, and their audio beside them, in `data/`
in its own local data directory. It writes plain Markdown notes and audio
files in a layout it declares itself, keeps no Git, and needs no Epicenter, no home,
and no account. Audio is never deleted unless the person asks.**

```txt
~/Library/Application Support/so.epicenter.whispering/   Tauri's appLocalDataDir
  data/                          the folder, by default; the person may move it
    recordings/k3x9.md
    recordings/k3x9.webm         audio, kept, sharing its record's id
    transcriptions/r7p2.md       one transcript of a recording
    settings.md                  the person's settings, as Markdown
  local/                         this computer's own; never moves with the folder
    recording/k3x9.webm          the take being recorded, until Stop places it
    .tmp/                        a save on its way into the folder; safe to delete
    local-transcription.json     the local engine's own state
Keychain                         secrets: provider API keys, Epicenter's among them
WebView localStorage             the rest of this computer's state: where the
                                 folder is, the microphone
Hugging Face cache               local models, shared with other programs
```

- **The folder is a setting on the desktop.** Settings shows it with "Show
  in Finder", "Copy path", and "Change…". The person picks it in the
  system's dialog, which grants the app that folder and nothing else
  (`@tauri-apps/plugin-dialog` with `recursive: true`);
  `tauri-plugin-persisted-scope` restores the grant at each start, and the
  path itself is kept in `localStorage`. A page cannot widen the app's file
  access, because only the dialog grants it, and every native command that
  touches a file checks the folder against that grant
  (`app.fs_scope().is_allowed`). That scope starts empty: a capability's
  grant counts only inside `@tauri-apps/plugin-fs`'s own commands. So the
  shell grants the default folder itself at startup (`allow_directory`).
  A grant names a path as the dialog gave it, so the app keeps that
  spelling. Grants persist, and a folder left by "Change…" stays granted,
  which lets Settings keep showing it. On the computer that runs the home, the folder may be
  `~/Epicenter/apps/whispering/data`: Whispering then writes its records
  there and stays their one writer. The inside app reads them and never
  writes a file Whispering writes; anything it adds is its own file, named
  by the recording's id, in a collection of its own (ADR-0896). The home's
  Git keeps the audio through Git LFS (ADR-0856). When the folder is inside
  a Git repository with no LFS rule for `webm`, Settings says the audio
  would go into Git whole. The browser build's folder is always its OPFS
  directory.
- **"Change…" moves the recordings or opens another Whispering folder,
  depending on what the person picks.**

  | Picked | Whispering |
  | --- | --- |
  | An empty folder | Moves the recordings into it: one rename on the same volume; across volumes, a copy it checks before it removes the old files |
  | A Whispering folder (one holding `settings.md` or `recordings/`), such as a home's or one synced from another computer | Opens it, and leaves the old folder where it was; Settings shows the old path so its recordings can be exported |
  | Any other folder | Refuses, and asks for an empty folder or a Whispering folder |

  Whispering never merges two folders. "Change…" is disabled while a take
  is recording, so a take is never placed in a folder Whispering has left.
- **Audio is kept.** Settings shows its size and offers "Delete audio older
  than…". Nothing deletes audio on its own.
- **A recording is its id, found from its note or its finished audio.**
  The audio sits beside the note (`recordings/{id}.{ext}`). Audio with no note lists as an untitled
  recording dated from the file; a note with no audio stays a recording.
  Before audio is deleted, its note is written if there is none.
- **A recording keeps several transcripts.** Each is its own file in
  `transcriptions/`, with its model, endpoint, and time, and transformation
  runs name the transcript they read.
- **The person's settings are one Markdown file, `settings.md`, at the top
  of the folder,** in both builds. Its front matter holds the model for
  each job, each provider connection and its endpoint (never its key), and
  the global shortcut, which the browser ignores.
  It moves, exports, and reaches a home with the recordings. A chosen model
  that this computer cannot reach shows as unavailable in the picker.
  Whispering alone reads and writes it, and passes `@epicenter/ai` the
  choices and connections it needs; the per-computer shortcut override
  goes.
- **What makes sense on one computer stays on it, outside the folder, and
  is never synced.** It names hardware or holds a secret, and the folder may
  be in a Git history or a file syncer. It is kept by kind:

  | Kind | Desktop | Browser |
  | --- | --- | --- |
  | Secrets: provider API keys, Epicenter's among them | The Keychain (the platform's credential store elsewhere), behind the shell's `Secrets` | `localStorage` |
  | Everything else: where the folder is, the microphone, a home's address (ADR-0900) | `localStorage` | `localStorage` |

  The rule is one sentence: a secret goes in the Keychain on the desktop,
  and everything else for one computer goes in `localStorage`. The Keychain
  is there because the desktop's `localStorage` is a plain file under
  `~/Library/WebKit/`, which any program running as the person, an agent
  or an install script among them, reads without asking; the Keychain asks
  before another program reads an item. A browser has no credential store
  a page can put an API key in.

  The page holds what it sends, in both builds. On the desktop it reads a
  key from the shell when a request needs one, and sends the request itself
  through `@tauri-apps/plugin-http`; in a browser it reads `localStorage`
  and uses `fetch`. Anything on Whispering's page can read what the page
  holds, so neither build loads a remote script, both set a strict Content
  Security Policy, and Settings says where keys are kept. Clearing a
  browser's site data forgets the keys and the microphone; the recordings
  in OPFS are cleared with it.
- **Epicenter's paid models are one more connection, and optional in both
  builds.** Either build works fully without them. Epicenter is a preset in
  `settings.md`'s connections, beside the person's own providers, local
  servers, and the engine inside the app; its key is an Epicenter API key
  (ADR-0950). "Connect" in Settings opens Epicenter's website, where the
  person signs in and approves this device, and the key comes back to the
  app: through `tauri-plugin-oauth` on the desktop, and from a popup in a
  browser. Settings shows "Connected as" with the account's email, the
  balance, "Buy more", and "Disconnect", which revokes the key. Whispering
  has no sign-in of its own and does not import `@epicenter/account`.
- **Settings calls it an "Epicenter account".** "Epicenter" alone names a
  person's folder of apps and the command that serves it. An account belongs
  to Epicenter, the company, lives on its website, and has nothing to do
  with a home, which signs no one in.
- **The browser build keeps its recordings in the Origin Private File
  System, in the same layout as `data/`.** Export from either build is a copy
  of the same tree. The browser build asks for `navigator.storage.persist()`,
  shows how much it stores, and offers export, because a browser may clear
  its storage. It needs no sign-in and no server. It runs where a page has
  `createWritable()`: Chrome, Firefox, and Safari 26 or later.
- **Whispering's storage is one file interface, passed in at startup.**
  Everything above it is written once:

  ```ts
  type Files = {
    read(path: string): Promise<Result<Uint8Array | null, FilesError>>;
    readMany(paths: string[]): Promise<Result<Map<string, Uint8Array>, FilesError>>;
    write(path: string, bytes: Uint8Array): Promise<Result<undefined, FilesError>>;
    list(dir: string): Promise<Result<Entry[], FilesError>>;
    remove(path: string): Promise<Result<undefined, FilesError>>;
  };
  type Entry = { name: string; size: number; modifiedMs: number };
  type FilesError = { name: 'NotFound' | 'Refused' | 'Io'; message: string };
  ```

  `tauriFiles(dir)` on the desktop, `opfsFiles(dir)` in a browser, and
  `memoryFiles()` in tests. Startup passes one as a plain argument
  (`isTauri() ? tauriFiles(dir) : opfsFiles(dir)`); there is no container.
  Paths are relative to the folder, and only plain names pass: each segment
  is letters, digits, `-`, and `_`, the last may end in one extension, and
  none starts with a dot. Both id formats (`k3x9a2f8` and
  `2026-10-30T22-41-05-123Z-k3x9a2f8`) pass; `..`, an absolute path, and a
  hidden file are refused. Recordings, transcriptions, transformations,
  runs, and `settings.md` are read and written on top of `Files`. One
  TypeScript module declares the layout: each kind of note's directory and
  its fields as a TypeBox object, and why a note does not read, by field
  and line. Nothing publishes it; the published `contract.json` and its
  compiler served the retired folder product's `epicenter check
  --contract` (ADR-0711, ADR-0717), and they go. One conformance suite runs the five operations
  against all three.
- **`readMany` is how a list loads.** Opening the folder lists
  `recordings/` and `transcriptions/`, then reads every note in one
  `readMany`. A folder of 15,000 recordings is 15,000 notes, and one
  native call per note would cross from the page to the shell 15,000
  times. `readMany` takes paths, not a directory, so it never reads audio.
  A browser reads a few files at a time. Audio plays from `read` into a
  `Blob`.
- **Rust moves bytes; TypeScript knows what they mean.** `tauriFiles` is a
  small module of Whispering's own commands in its shell, one per
  operation: `files_read`, `files_read_many`, `files_write`, `files_list`,
  and `files_remove`. Each takes the folder and a relative path, checks the
  folder against the grant and the path against the rule above, and
  refuses a symbolic link. Reads answer raw bytes rather than JSON:
  `files_read_many` answers one buffer that holds a count, each path's
  length in the order asked (or a marker for a missing file), then the
  bytes. The page is granted none of `@tauri-apps/plugin-fs`'s commands;
  the plugin is registered for its scope alone. Two more commands do what
  the page cannot do through `Files`: `files_change_folder` carries out
  "Change…", and `folder_git` tells Settings whether the folder is in a Git
  repository with an LFS rule for `webm`. No command parses a note:
  Markdown is read and written in TypeScript, so both builds share one
  reader.
- **Notes use the home's Markdown grammar from its one owner.**
  `@epicenter/app` exports its front matter reader and writer
  (`readMarkdown`, `markdownOf`, `withFields`, ADR-0924) at a
  browser-safe subpath, `@epicenter/app/markdown`, and Whispering imports
  it, so a note Whispering writes is one a home's apps read the same way.
- `tauri-plugin-epicenter-folder` goes without a replacement.
- **The folder only ever receives finished files, each by one rename.**
  Every file on its way into the folder waits outside it, in `local/` in
  the app's local data directory, and one place step, shared by
  `files_write` and the recorder, moves it in. A home's checkpoint
  (`git add -A`), Git LFS, a file syncer, and Whispering's own listing
  therefore never see a half-written file. Only when the folder is on
  another volume, where a rename cannot reach, does the place step copy to
  a temporary file beside the target (`.ep-<random>.save`), sync it, and
  rename that. A crash can leave that file behind; Whispering is the
  folder's one writer, so opening the folder removes any `.ep-*.save` it
  finds. `local/` has the shape of a home app's `local/`
  (`apps/<app>/local/.tmp/` is where the home stages its own writes), and
  stays in the app's local data directory wherever the folder moves.
  Its two directories each keep one rule: `local/.tmp/` holds saves, which
  are safe to delete at any time, and opening the folder clears it;
  `local/recording/` holds takes, which are placed and never deleted while
  they hold audio. A take a crash left with no audio in it is deleted, as
  there is nothing in it to keep.
- **`write` replaces a file whole.** On the desktop it writes and syncs the
  bytes in `local/.tmp/`, renames them over the target, and syncs the
  directory. The rename replaces the file in one step on macOS and Linux;
  on Windows it replaces the file without that promise. In a browser
  `write` uses `createWritable()`, whose changes reach the file only when
  the stream closes. A failed write keeps the unsaved text on screen and
  offers to retry.
- **A take is recorded in `local/recording/` and placed at Stop.** The
  recorder plugin keeps its capture and encoding unchanged:

  ```ts
  recorder.start({ dir, id, device }) // records into <appLocalDataDir>/local/recording/<id>.webm
  recorder.stop()                     // → { id, durationMs }, placed at <dir>/recordings/<id>.webm
  recorder.recover({ dir })           // → { recovered, unplaced }: takes a crash cut short
  ```

  Placing a take replaces nothing: the rename refuses an existing target,
  and `start` refuses an id whose audio or take already exists. If placing
  fails, `stop` answers `Unplaced` and the take stays in `local/recording/`, so
  nothing recorded is lost, and `recover` places it later. `unplaced` lists
  every take `recover` could not finish or place, so the person sees it. The path check
  is the one `Files` uses. In a browser the recorder keeps a take in memory
  and writes it once at Stop through `Files`; a tab that crashes while
  recording loses that take.
- **Whispering runs in one place at a time, so the app is one writer.** On
  the desktop, the Tauri single-instance plugin focuses the open window
  instead of starting a second. In a browser, the open tab holds a Web Lock
  (`navigator.locks`) for as long as it runs; a second tab says Whispering
  is open in another tab and waits for that lock, which it gets when the
  first tab closes. Nothing steals the lock, so nothing interrupts a
  recording.
- **Another program may write the folder, so Whispering checks before it
  replaces.** A file syncer such as iCloud Drive or Syncthing may change a
  note, and in a home a Git command such as a checkout or a revert may. Whispering lists the folder again when its window regains
  focus, and re-reads only the notes whose size or modified time changed.
  Before it replaces a note it re-reads the file; if the bytes differ from
  what it showed, it does not write, and shows the newer text.
- **The interface's state stays small, so it does not regrow
  `@epicenter/folder`.** Lists load into Svelte state at start and on
  focus, and a successful write updates that state. There is no cache
  layer, no watcher, and no store per collection.
- **No import from v7.** A person who wants their v7 recordings copies the
  Markdown files.
- **First run asks one question:** where transcription runs, a local model,
  an API key, or Epicenter's models through Connect. It asks for no home.

**In an app's data folder, a `.local` file is this computer's working file:
rebuildable or re-enterable.** Secrets, caches, locks, and temporary files
fit. A file that cannot be replaced is not `.local`. Whispering's folder needs
none.

## Consequences

- Whispering 8.0 ships without an Epicenter, a home, or Git, and commits only
  to the file format.
- A person who never connects Epicenter loses nothing but its models.
- **Six packages are deleted, three are cut down, and their surviving
  callers are recomposed:**

  ```txt
  packages/folder                       deleted
  packages/tauri-plugin-epicenter-folder deleted (and its core crate)
  packages/local                        deleted; settings.md is Whispering's, secrets are
                                        the Keychain's, the rest is localStorage
  packages/definition                   deleted:
    ids                                   move into apps/whispering
    contract                              deleted; a TypeScript module in apps/whispering declares the layout
    site (APPS, localUrl)                 apps/api and apps/whispering each name their own origins and ports
    resolveOAuthAudiences                 goes; with no folders audience, the API's audience is its origin
    merge, front-matter, folders          deleted
  packages/server                       its folder half deleted: mountFolders, routes/folder*,
                                        log/, the folder schema, authorizeFolderRequest
  packages/svelte                       deleted; reactive is copied into apps/whispering
                                        and apps/api/ui; WhenOpen, recovery, note-repair,
                                        folder onboarding go
  packages/ai                           its agent and its settings files go; Whispering
                                        passes it choices and connections; hosted() becomes
                                        a preset connection
  packages/tauri-epicenter-account      deleted; Connect uses tauri-plugin-oauth, and a few
                                        lines in Whispering's shell keep Keychain items
  packages/account                      keeps the dashboard's cookie session alone;
                                        browser-oauth.ts, tauri.ts, and relay.ts go
  ```

  The packages only Whispering uses (`@epicenter/recorder`,
  `@epicenter/transcription`, `@epicenter/vite-config`,
  `tauri-epicenter-standalone`, `tauri-plugin-epicenter-recorder`, and
  `epicenter-transcription-build`) move into `apps/whispering`, with
  `scripts/first-load.test.ts`, which reads vite-config's module graph. The
  hosted API loses its `/folders` routes, the `folders` audience and scopes,
  and the R2 binding; dropping their production tables is a later,
  separate step.
- Whispering's OAuth sign-in goes in this change. Its paid models come back
  through Connect in the change that builds ADR-0950 and ADR-0951, which
  also ends the hosted OAuth server. Whispering 8 is unreleased, so `main`
  has no paid models in between. This change removes only the hosted
  folder routes.
- The checks that guarded the
  old layout (`check-clean-break`, `check-state-paths`) go, and the `auth`
  and `platform-seams` skills lose what described them.
- `apps/whispering/AGENTS.md` changes where it says the browser keeps
  nothing and refuses streaming writes, locks, and recovery in a browser.
- No account holds data in a hosted folder (the owner, 2026-11-17), so
  nothing is migrated.
- **What this removes, and who accepts it** (ADR-0943):

  | Removed | Who loses what | Who takes on the work |
  | --- | --- | --- |
  | The browser build's hosted folder | A browser's recordings stay in that browser and go if it clears its storage; they leave it by export, and import comes later | The person, who exports; Whispering asks the browser to keep its storage, shows usage, and offers export |
  | Safari before 26 in the browser | The browser build does not open there | The person, who updates Safari or uses another browser or the desktop app |
  | A second Whispering tab or window | Two tabs side by side; the second waits until the first closes | The person, who uses one tab |
  | A watcher on the folder | A change another program makes appears when Whispering regains focus, not at once; a note changed elsewhere is not overwritten | The person, who sees the newer text |
  | `@epicenter/folder`, its plugin, `@epicenter/local`, and `@epicenter/definition` | Nothing a person sees | Whispering's maintainers: `Files`, its three implementations, the conformance suite, the recorder's own staging and repair, and Keychain items behind the shell's `Secrets`; the API's maintainers: their own origins and audience |
  | The hosted `/folders` routes and `folders` audience | Nothing; no account holds data there | The owner, who approves deleting the empty tables later |
  | A desktop key the page never sees | Code that reaches Whispering's desktop page can read a key, as in the browser; it could already spend one through the relay | Whispering's maintainers, who load no remote script and keep a strict Content Security Policy |
  | A per-computer shortcut override | Two computers sharing one folder share one shortcut | The person |
  | One store that every device opened | A recording reaches another device only by export, a file syncer, or a later sharing decision | The person |

- **It is built as one change that deletes first.** The last commit before
  it is tagged `folder-package`. The change deletes the packages above,
  then builds `Files` and its three implementations and recomposes their
  callers. Whispering may be broken on the branch; the change merges only
  when Whispering records, saves, and reopens a recording on the desktop
  and in a browser. `apps/api` deploys on every push to `main`, so merging
  removes the routes at once; no account holds data there. Production
  tables are not in the change: dropping them is a separate operation the
  owner approves.
- Each recording's id and text stay stable, so a later decision can let a
  recording's text be shared without rewriting storage. Sharing is not
  decided here. Neither is hosted Git LFS storage for a home; each would be
  a new hosted service with its own record.
- A person using Whispering alone may sync its folder with iCloud Drive or
  Syncthing: no `.git`, and each file has its own id.
- In a home, audio Whispering deletes stays in the home's Git history, so
  "Delete audio older than…" frees space in the folder, not in the home.
  Settings says so when the folder is inside a Git repository.
- Removing Whispering's app data, through an uninstaller or a cleaner, loses
  the recordings and their audio. Settings and the README say so, and say
  where the folder is. ADR-0858 rejected the app data directory for this
  loss; with no second visible place on a connected device, the owner accepts
  it. `appLocalDataDir` is not Windows' roaming profile.
- Models download again; v7's `models/` is left behind.

## Considered alternatives

- **`~/Whispering` (ADR-0890).** A second visible place on each device beside
  the home's copy.
- **Audio in `audio/` beside `data/`.** Safe from a stray `git add` only while
  a device held `.git`; with none, beside its note is simpler.
- **Discard audio after transcribing unless kept.** v7 kept audio by default,
  and its author wants it kept.
- **No Epicenter connection at all.** Leaves a person no paid model unless
  they bring a provider's key.
- **A sign-in every person passes.** v7.11.0 works with none, and a local
  model needs no service.
- **A second `Files` for this computer's state.** A file store for a few
  small values that `localStorage` holds and reads at once, which would
  bring back the wait before a page can read a setting.
- **Sign in to Whispering through OAuth, as built.** ADR-0950 gives the
  reasons a key replaces it.
- **Encrypt the browser's keys with WebCrypto.** The page that can read them
  can also decrypt them.
- **Sync API keys with the folder.** A copied folder or a Git backup would
  carry every key.
- **Provider keys in `credentials.json`,** as built
  (`packages/tauri-epicenter-account/src/credentials.rs`). A plain file on a
  laptop.
- **A settings file per capability** (`models.md`, `connections.md`,
  `shortcuts.md`). Three files because three modules kept one each; with
  Whispering the one writer, one file does.
- **The folder's path in `folder.json`, read only by the shell.** Rust that
  the dialog and persisted-scope plugins already do.
- **The shell sends every request that needs a secret, so no desktop page
  sees one,** as built. About 1,100 lines of relay that keep code in the
  page from reading a key but not from spending it, and a second request
  path the browser does not have.
- **Every secret in `localStorage` on the desktop too.** Any program running
  as the person reads it without asking.
- **Every setting beside the folder, none in it.** Settings would not move,
  export, or reach a home with the recordings, and the two builds would keep
  them in different places.
- **Settings in `localStorage` in the browser.** A second format and place
  for the browser alone.
- **A fixed folder.** Removes "Change…" and the scope grant, but a person on
  the home's computer could not write into the home directly.
- **Import from v7.** Reading v7's WebView storage for a clean break its
  author does not need.
- **IndexedDB in the browser.** One transaction can hold a note and its
  audio, but export then translates records to files, and long audio is
  stored whole rather than written in pieces.
- **Revive `@epicenter/folder`'s generic `Store`.** It keeps the package
  this record deletes.
- **One storage interface per collection.** Each platform would implement
  every collection; `Files` keeps the platform part to five operations.
- **A hidden take beside its audio (`recordings/.ep-<random>-k3x9.recording`),
  as built.** A home's checkpoint runs `git add -A`, which commits a
  half-written take, outside Git LFS because its extension is not `webm`;
  a file syncer uploads it again each time it grows.
- **`recordings/k3x9.local.webm` while recording.** Git LFS commits the
  partial take, and the listing reads its id as `k3x9.local`.
- **`local/` beside whatever folder the person picks.** Inside a synced
  folder it would be synced, growing take and all, and a person would find
  it among their recordings.
- **One staging directory for takes and saves.** Clearing it would need an
  exception for the takes it must never lose.
- **"Change…" points at the new folder without moving anything.** The
  recordings would stay behind in the app's data directory unnoticed.
- **Merge two Whispering folders.** Two settings files and possible clashes
  of ids, for a case a person can handle by exporting from one.
- **A hidden staging directory inside the folder, with its own
  `.gitignore`.** A file Whispering plants in the person's folder, and a
  file syncer still uploads the growing take.
- **A temporary file beside its target for every save.** A home's
  checkpoint can commit it mid-write or after a crash; the home's own
  writes stage in `local/.tmp/` for the same reason.
- **The inside app writes its own fields into Whispering's notes.** Two
  writers of one file, which a re-read before replacing narrows but does
  not close.
- **Staging in the home's `local/` directory beside the folder.** It exists
  only when the folder is a home's, and writes outside what the person
  picked.
- **`tauriFiles` as `@tauri-apps/plugin-fs`.** A note per native call, so
  opening a large folder crosses to the shell once per note, and the page
  holds every file command the plugin has.
- **Read the notes in Rust and answer records.** A second Markdown reader,
  in Rust, beside the one the browser build needs.
- **Copy the front matter grammar into Whispering.** Two copies of one
  format, which can drift from what a home reads.
- **Several tabs, a lock per file, and a `BroadcastChannel`.** Two writers
  made safe instead of one writer made true.
- **A second tab that steals the lock.** A stolen Web Lock leaves the first
  tab running, recording and saving.
- **A worker with sync access handles for older Safari.** A second write
  path for browsers the build can leave out.
- **The note is required, and audio without one is recovered into a note.**
  Recovery code for a state a listing can show as it is.
- **A recording's transcript in its note's body.** Whispering keeps several
  transcripts per recording, each with its own model and time, and
  transformation runs name one; the note's body is the person's notes.
- **Keep `@epicenter/definition/site` as a shared package.** Two
  constants per app, read by two apps, after the folders audience goes.
- **Keep the hosted folder for the browser build.** A server for a build
  that is not deployed.
- **Share a recording's text through Yjs now.** It needs a document service
  the company runs; that is a separate decision, made once shared
  recordings are wanted. Audio would not go in it.
