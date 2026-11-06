# tauri-plugin-epicenter-folder

The desktop shell's side of an Epicenter folder: the roots an app reaches,
which the shell names at startup, and the app's folder storage over them,
one command per storage method, under checks the page cannot get around. It
runs no Git, and neither does anything else on a computer: a folder's history is
its log on the server, which sync commits to from TypeScript
([ADR-0804](../../docs/adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)).

The page opens the folder itself, with `@epicenter/folder`'s engine
([ADR-0531](../../docs/adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
It names a root, such as `Data` or `AppData`, never a path, and holds no
absolute path but the one `open_root` answers for it to show
([ADR-0725](../../docs/adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)).

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the canonical directory value (`directory.rs`), the shared path rule and hidden-path rule (`paths.rs`), the reserved names of a write in progress and `.epicenter` (`state.rs`), what opening a folder clears (`sweep.rs`), a directory's identity (`identity.rs`), the page's storage (`storage.rs`), and which directories may be set up for sync (`admission.rs`). No Tauri. |
| `src/` | The Tauri plugin: the named roots and their watches (`roots.rs`), and the commands over them. |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/folder`, whose desktop opener is their only user. `read_folder_file` and `put_folder_file` are not in them (see Storage). Do not edit. |
| `fixtures/path-rules.json` | The paths the shared path rule refuses and allows, and which are hidden. `core/src/paths.rs` and `paths.test.ts` in `@epicenter/folder` both read it. |
| `fixtures/reserved-names.json` | The names a write in progress takes beside its target (`.ep-<random>.save`, `.ep-<random>-<base>.recording`), names that are not reserved, how a recording's name reads back to its final path, and the legacy `.epicenter`. `core/src/state.rs` and `@epicenter/folder` both read it. |
| `fixtures/reserved-directories.json` | Canonical paths no folder can be at, because a segment is `.git` or `.epicenter` in any case, and paths that may be folders. `core/src/admission.rs` and `admission.test.ts` in the CLI both read it. |
| `core/src/storage_outcomes.json` | Storage calls and what each answers, which `core/src/storage_tests.rs` runs over the shell's storage. Only the shell answers these edge cases; the Bun store in `@epicenter/folder` is a plain store. |

The files in `fixtures/` are the rules both languages decide by, so each is
read by a Rust test and a TypeScript test.

This crate has no JavaScript package of its own. A page reaches it through
`@epicenter/folder` (or `@epicenter/folder/tauri`).

## Naming roots

Install the folder plugin once, then name each root at startup with its
path and the rule that refuses a location it must never be:

```rust
use tauri::Manager;
use tauri_plugin_epicenter_folder::{Root, RootsExt};

tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
    .setup(|app| {
        let roots = app.roots();
        roots.name(Root::AppData, app.path().app_data_dir()?, |_| None);
        roots.name(Root::Data, data_folder, |location| refusal(location));
        Ok(())
    })
```

The apps on [`epicenter-standalone`](../tauri-epicenter-standalone/README.md)
(Capture, Honeycrisp, Todos, Vocab, Whispering) name their AppData root and
their data folder, `<Epicenter folder>/<site-derived path>`, this way (the
Epicenter folder is `~/Epicenter`, ADR-0816; the Rust code and its comments
still call it the library root). Their pages open the named Data root after the
window opens; that crate holds the one refusal (the home folder, a folder
holding it, or the Epicenter folder itself).
Nothing is granted: a capability lets a window call the plugin, and the
roots are the app's, so every window of the app reaches the same ones.

The Epicenter app names no Data root: it names the Epicenter folder
(`roots.name_epicenter(path, refusal)`, ADR-0813), and every directory
directly inside it is a root of its own, `Root::Folder(name)` (`{ Folder:
name }` to a page, `Folder/<name>` in a raw request's `root` header). The
page lists them with `list_epicenter`: the Epicenter folder's path and its
real path (`realPath`, links resolved), and each folder (links followed,
hidden names skipped) with its identity and whether Git keeps it (`git`:
`.git` at its real root, or, for a folder that is a link, in any directory
above where it leads; Epicenter never syncs a Git working tree, ADR-0822).
It makes one with `make_epicenter_folder`. Opening a folder root follows a
link at its path and never makes the folder; its location may not be the
Epicenter folder, a folder holding it, or inside `.git` or `.epicenter`,
besides the shell's own refusal. Both commands are the
`epicenter-folder:epicenter` permission set, not the default one; a shell
that named no Epicenter folder answers `NotNamed`. The page's side is
`epicenterRoot()` from `@epicenter/folder/tauri`.

The Epicenter folder keeps its own records at its root, `.epicenter/`
(ADR-0822): `synced/<folder-id>.json`, one per synced folder, and
`hashes/<key>.json`, caches named by identity. That directory is
`Root::Epicenter` (`"Epicenter"` to a page and in a raw request's `root`
header), which exists only where the shell named the Epicenter folder; the
page reads and writes it with the ordinary storage commands, and its first
open makes it. It is refused only when it is a link: the rule for a
folder's location is not asked, since it is not a folder.

A directory's identity is its inode and birth time
(`identity::FolderIdentity`, `{ inode, birthtime }`, each a decimal
string, `birthtime` null where the file system records none), never its
device number, which changes when a drive remounts. `birthtime` is
nanoseconds since the Unix epoch, as Node's `birthtimeNs` reads it. Two
identities prove one directory only with the same inode and the same real
birth time (`identity::proves`). `root_identity(root)` answers an open
root's identity, and `data_record()` the record in the Epicenter folder's
`synced/` that proves the open Data root, or null; a standalone shell names
that folder with `roots.name_library(path)`, which makes none of its
directories roots. Both are read-only and in the default set.
`roots.on_open(listener)` tells a shell each root that opens, which a
standalone shell uses to remember its Data root's identity
(`epicenter-standalone`).

A shell gives its window the plugin's commands in a capability:
`{ "windows": ["todos:*"], "permissions": ["epicenter-folder:default", "core:event:allow-listen", "core:event:allow-unlisten"] }`.
It grants no `fs` command and names no folder.

`admission::check_sync_directory`, written for the retired setup flow in which
Epicenter set a directory up for sync (nothing in the TypeScript model calls it
now), refuses a directory when any segment of its canonical path
is `.git` or `.epicenter` (`state::DIRECTORY`), in any case
(`admission::is_reserved_directory`): those belong to Git and to Epicenter's
own records. Any other hidden directory, `~/.notes` among them,
may be a folder. It also refuses a directory inside, equal to, or holding
application data, and the Epicenter folder or a directory holding it.
Containment compares canonical paths and directory identity, so a linked
parent or another spelling of a protected directory is no route around it.
`Directory` is the canonical directory value both use. What `.git` is, if
anything, does not matter to storage, as it does not to the Bun host
(`nodeStore` in `@epicenter/folder/node`): a directory with no `.git`, with a `.git` file or
link (a linked worktree or submodule), or with a repository opens and saves
alike, and the shell never changes `.git`. A computer runs no Git, so nothing
here depends on it.

## Opening

The page's `@epicenter/folder` adapter listens for `folder-changed` before it
calls `open_root(root)`. Whatever is at the root's path is the app's
([ADR-0726](../../docs/adr/0726-an-apps-path-is-its-claim.md)):

1. `Disconnected { folder, target }` when the path, or a folder above it,
   is a link whose target is not there, as on a drive that is not
   connected. Nothing is made.
2. `Refused { folder, reason }` when the location the path resolves to is
   one the shell's rule refuses, asked before anything is made and again
   once the folder is there.
3. The folder is made, with its parents, when nothing is there; a file
   there is `Unavailable`.

A link at the path is followed when the root opens, and the root works in
the folder it reached until it opens again. Each call looks again, so Retry
finds a folder that came back. A root the shell did not name is
`NotNamed`, and after shutdown the answer is `ShuttingDown`. `open_root`
answers the path the shell named the root at, as a person reads it
(`/Users/me/Epicenter/whispering`, not where a link there leads). The page
shows this path; storage commands still take only a root name and relative path.

Opening starts one recursive watch per root. Changes are app events carrying
`{ root, paths }`, so every page listening for that root hears them. A page
reloads and drops its JavaScript listener. Watch setup failure is
`Unavailable`.

A window closes like any other window: nothing waits for its page. A write
still out then is lost, a small, rare loss at the edge (ADR-0702's test for
every protection); what landed is in the folder.

Every open also clears what a stopped writer left (`sweep::sweep`). It
walks the whole root, following no link and skipping `.git`, and removes
each regular file named as a staged save (`.ep-<random>.save`) last changed
more than an hour ago; a younger one may belong to a save still running in
another process. It never touches a recording in progress, which its
recorder recovers, nor any other hidden file. In a folder an older build
wrote, it then clears that build's `.epicenter`: stale files in `saves/`
go, each recording in `recordings/` over an hour old moves beside its final
path under a recording's reserved name, empty directories there go, and
`.epicenter` goes once it is empty. A recording, `synced.json`, and
`hashes.json` are never deleted: the page reads the last two with
`read_folder_file`, writes its record, and removes them with
`put_folder_file`, and the next open removes the empty `.epicenter`.

Each command clones the root's `Directory` when it arrives and works in that
folder until it ends, so nothing that happens meanwhile redirects work
already admitted. Several pages, or other programs, may write one folder:
each save is checked against the version its page read right before its
rename (see Storage), and a save another writer overtook is answered
`stale`; the page reads again and merges. Within the app's process, puts of
one path take turns from the check to the rename, so of two saves over one
version exactly one lands. Across processes no lock spans the check and the
rename; the next sync's versioned writes are the backstop
([ADR-0702](../../docs/adr/0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md)).

## Storage

A page's folder storage (`Store` in `@epicenter/folder`'s
`device/store.ts`, four verbs, through `device/tauri-store.ts`) is these
commands, each one IPC call
([ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md),
[ADR-0779](../../docs/adr/0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md)):

| Method | Command | Answers |
| --- | --- | --- |
| `list(under)` | `list_folder(root, under)` | `{ path, version, size }[]`, every file at or below each of `under`, `.git` and an older build's `.epicenter` at the root aside, and never a reserved name; other hidden files are listed for the reader to skip |
| `read(paths)` | `read_folder_file(root, path)`, once per path | the stamp, a zero byte, then the file bytes, raw |
| `write(path, bytes, over)` | `put_folder_file`, raw body and headers | `{ landed: stamp }` or `"stale"` |
| `watch(changed)` | none: the root's watch, which `open_root` started | the `folder-changed` events for the root |

A storage command answers a `FolderError`: a `RootError` when its root
cannot be used, and a `StorageError` (below) when the operation refuses or
fails; the two never share a `name`. A root whose path, or a folder above
it, is a link whose target is gone is `Disconnected { folder, target }`,
whether it never opened (as after a startup that found the drive gone) or
the drive went away after it did. A root the app has not opened is
`NotOpen`, one the shell did not name `NotNamed`, and any command after
shutdown `ShuttingDown`. None of them changes anything.

Paths are folder-relative with `/`, and must pass the shared path rule
(`paths::path_problem`, the same rule as `pathProblem` in
`@epicenter/folder`). The rule refuses an alias of `.git` in any segment (any
case, trailing dots and spaces, ignorable code points, `git~1`), `HEAD`, and
names that do not survive every desktop file system: a trailing dot or
space, a Windows device name, a Windows short name such as `GIT~1`, a
reserved or control character. Leading dots are ordinary. The shell keeps no
list of a folder's files; which data paths a folder has is the page's
business. `.git` at the root is never listed and never named.

`storage.rs` is the strict folder host. It resolves every path literally,
as its vectors (`core/src/storage_outcomes.json`) show:

- No link is followed. A path through a link, or naming one, is
  `InvalidPath`; a listing reports a link as a file.
- A name stored under another spelling, which a disk that ignores case or
  Unicode normalization would reach (`plan.md` for `Plan.md`), is another
  entry: a read finds nothing there (`NotFound`), and a put is
  `InvalidPath`. On macOS and
  Windows the stored spelling comes from resolving the path; elsewhere from
  listing each parent.
- A file where a directory should be is `NotADirectory` naming it, and a
  directory where a file should be is `NotAFile`.
- `credentials.json` at the top of the AppData root is the shell's own: the
  refresh token and provider keys
  [`epicenter-account`](../tauri-epicenter-account/README.md) keeps
  (ADR-0740). So is `data-folder.json` there, the identity of the folder a
  standalone shell opens as Data, which a page that wrote it could point
  elsewhere. A listing leaves both out, and a read or a put of either is
  `InvalidPath`. The names anywhere else are ordinary files.
- A reserved name (`state::is_reserved`, a save or a recording in progress)
  is never listed, and a put of one is `InvalidPath`.

A storage refusal or failure is a `StorageError`: `InvalidPath`, `NotFound`,
`NotAFile`, `NotADirectory`, or `Io` with the operation and the system's
message. A failure the shell reports changed nothing. The page reads
`NotFound` as no file there and any other as `Unavailable`.

### A put

`put_folder_file` publishes a file's bytes at a path, or removes its file,
only while the path holds what the page expects. It takes the bytes as the
request's raw body, so content crosses IPC as it is rather than as a JSON
array of numbers. Its arguments are headers, each percent-encoded: `path`,
`root` (`Data`, `AppData`, `Epicenter`, or `Folder/<name>`), `remove`
(`true` to remove the file, when the body is ignored), and
`expected`, the version the page read there: `absent` for a create,
`sha256:` and the SHA-256 of the file's bytes, which the shell hashes again
before the rename (`core/src/version.rs`, with the `sha2` crate), `stamp:`
and a file's stamp, or `any` for the page's own cache files
(`storage::Expectation`). A listing tags each file's version by its size,
never its path (ADR-0824): `sha256:` and the hash of a file up to 64 KiB,
read whole, or `stamp:` and the stamp of a larger one, which the page turns
into its version through its stamp cache.
There is no other unconditional put. Each case has its own spelling, so a hash is
never read as a keyword; anything else is refused as `Io`. Removing nothing
that expects nothing has landed. A new file must pass the shared path rule;
an existing name only some disks hold may be replaced or removed over the
version read, never made, so a create of one is `InvalidPath`. `HEAD` is
never written.
A JSON array of bytes, Tauri's `postMessage`
fallback, is accepted too. The generated bindings cannot type a raw request,
so the command is left out of them; the plugin dispatches it beside the
typed commands, under the same permission, and `device/tauri-store.ts` invokes it
by name. `read_folder_file` returns a raw `ArrayBuffer` to the page. Its stamp
is ASCII before the first zero byte; the remaining bytes are the file. The
stamp is formed from size, modification time in nanoseconds, and device and
inode on Unix. Reads inspect the opened file handle so a replacement cannot
pair old bytes with the new file's stamp. A landed put returns the stamp of
the published file, or `null` for a removal. Stamps detect changes;
expectations remain byte hashes.

A put of bytes first makes the path's missing parent directories, then
writes the bytes to a new file beside the path, `.ep-<random>.save`
(`state::staged_name`; opened with `create_new`, so nothing already there is
written through). On Unix each staged file is `0600` before its first byte,
so the permission bits keep a save that has not landed, or one that
stopped, from other accounts. An access control entry the folder passes on
(`everyone allow read`) is kept: it is a grant the person made on their
folder, and a file another program makes there inherits it too. Replacing a
file keeps its permission bits; a new file is `0600`. The staged file is on
its target's file system, so the rename is one step. Then the put walks
the path again (no link, every name stored as asked), checks what the path
holds, and only then renames the staged file over it. A removal walks,
checks, and removes. Within the shell's process, puts of one path take turns from
that walk to the rename or removal, so none lands between another's check
and its change. Across processes nothing holds the path between the check
and the change: a save another program, such as a Bun process opening the
same directory, lands in that instant can be replaced
([ADR-0702](../../docs/adr/0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md)).
A put expecting nothing at its path (`absent`) is the exception: it is
placed (`storage::place`, which the recorder places each recording with
too), a rename that fails when any entry has the name (`renamex_np` on
macOS, `renameat2` on Linux, `MoveFileExW` on Windows). Whatever appeared
there after the check stays, and the put answers `{ kind: "stale" }`. Where
the disk refuses that rename, it is a hard link to the path, which also
fails when the name is taken, then the staged name removed; where the disk
has no hard links either (exFAT on macOS) it is renamed only while nothing is
there, a check a racing writer can still beat.
The root itself is never made. The cost is a read and hash of the destination when
`expected` names a hash. A path that holds something else changes nothing and answers
`{ kind: "stale" }`. On every answer but `{ kind: "landed", stamp }` the put
leaves nothing behind: not its staged file, and not a directory it made,
unless another writer put something in it.

A folder has no repository on this computer, and saving makes none: a put
stages beside its target, so it makes nothing in the root but the files
saved and their directories, nothing beside the root, and nothing in `.git`
is reachable, with or without `HEAD` (`page_files.rs`).

A data file is never written in place: the rename replaces a hard link
rather than writing through it. A recording, by
`tauri-plugin-epicenter-recorder`, grows beside its path under a reserved
name and is placed at its path whole
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
It asks `app.roots().opened(Root::Data)` for the folder the app opened,
checks the path with `page_files::data_path` (the same rule and link check
as a put), and creates the file with `create_new`. A directory is removed
only when empty; nothing removes a tree whole.

### Unfinished writes

A folder holds only its content (ADR-0822). A write in progress waits
beside its target under a reserved name, laid out by `state.rs` alone (and
`@epicenter/folder`, held to `fixtures/reserved-names.json`):

```
notes/
├── a.md
├── .ep-0123456789abcdef.save          a save waiting to be renamed over its target
└── .ep-k3j9x2ab-2026-11-06 take.recording
                                       a recording of `2026-11-06 take.webm`, until stop or recovery
```

A name is reserved when its last segment is `.ep-`, at least one
character, then `.save` or `.recording`. A recording's random part is 8
lowercase base 36 characters, so its name reads back to its final path
(`state::recording_final`). A reserved name is hidden
(`paths::is_hidden_path`), so no watcher reports it, and no listing
describes it, so sync never carries it. A stale save is always safe to
delete when no app runs, and opening the folder removes it; a recording
may hold audio until the app opens once, and only its recorder removes it.

## Git

No Git runs on a computer (ADR-0804): this plugin offers file storage, and a
folder's history is its log on the server, which sync commits to from
TypeScript. The page capabilities grant no native history command.

## Changes outside the page

Each open root owns one `notify::RecommendedWatcher` over it, recursively,
without following symbolic links. It emits a typed `folder-changed` app event
with `root` and root-relative `paths`. Directory hints cover descendants;
`null` means any path may differ. Rename notifications retain both paths when
the operating system supplies them. Read/open access events and hidden paths
(`paths::is_hidden_path`, including Git state and unfinished writes) are
ignored. A rescan, unknown scope, or watch error emits `null`; the callback
reads no file content.

`@epicenter/folder/tauri` starts listening before it opens the root. The page
rereads sources held by readers or accepted input. An observation never
acknowledges a save or initiates a write. The watch stops at shutdown, outside
the roots' mutex. Native setup also runs outside that mutex; a candidate
remains inactive until installed on the same open root. No resource identifier
or filesystem permission is exposed to the page.

Delivery is best effort. Root replacement recovery is unsupported and platform
dependent; neither original-inode retention nor reattachment is guaranteed.
Terminal errors request reconciliation without an autonomous restart guarantee.
No polling fallback or file-content replica is kept here.

## Shutdown

Every put and directory change holds a clone of its root's directory while
it runs; a read holds one too. When the app exits, or the shell calls
`app.roots().shutdown()`, the plugin refuses new opens, reads, and work. It waits for no admitted storage operation. Watch release fences any
notification currently emitting, without waiting for page reads or saves
([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
Every save is an atomic rename, so a change cut off at exit leaves the old
file or the new one. A late change is refused as `ShuttingDown` and writes nothing.

## What is best effort

- A link another program swaps in between a check and the read or change
  that follows is not defended against; a page cannot make one. A put
  checks the path for links again right before its rename.
- A compromised page can read and write anything under its own roots; the
  path rule bounds it to them.
- The expectation is checked right before the rename. Within the shell's
  process, puts of one path take turns across the two; across processes no
  lock spans them. A writer in another process that changes a path in that
  instant is not seen, and its save can be replaced; the server's history keeps
  what sync committed.
- Epicenter ships for macOS only
  ([ADR-0567](../../docs/adr/0567-epicenter-ships-for-macos-only-for-now.md)).

## Commands

```sh
# from this directory
cargo test --offline --workspace          # core and plugin, real Git, mock Tauri runtime
FOLDER_WRITE_BINDINGS=1 cargo test --offline -p tauri-plugin-epicenter-folder bindings
                                          # rewrite ../folder/src/native/bindings.gen.ts
cargo build --offline                     # regenerates permissions/ for the listed commands
```
