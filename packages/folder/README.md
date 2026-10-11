# @epicenter/folder

A folder whose current files are the saved data: Markdown rows, `kv.json`, and
any other file, with Git history beside them. There is no document store
behind it. The package does not depend on `@epicenter/app`.

```ts
import { defineFolder, defineTable, field, openFolder } from '@epicenter/folder';

const definition = defineFolder({
  kv: { theme: field.string() },
  tables: {
    todos: defineTable({ fields: { title: field.string(), done: field.boolean() } }),
  },
});

const { data: folder, error: openError } = await openFolder({ id: 'so.epicenter.todos', definition });
if (openError !== null) return show(openError.message);

const stop = folder.onFilesChanged(() => refresh());   // subscribe, then read
const listed = await folder.tables.todos.list();       // one { stem, result } per row file
const { data: created, error: createError } = await folder.tables.todos.create({
  fields: { title: 'Milk', done: false },
  body: '',
});
if (createError !== null) show(createError.message);
else {
  created.row.fields.done = true;                      // the row is yours to edit
  const { error: replaceError } = await folder.tables.todos.replace(created, created.row);
  if (replaceError !== null) show(replaceError.message); // Conflict if the file changed since
}
await folder.close();                                  // closed either way
```

## File-browser helpers

`@epicenter/folder/file-browser` provides path helpers, visible tree rows,
newline preservation, and `readTextFile(files, path, maxBytes)`. These helpers
open no storage and change no files. Apps supply their editable-byte limit and
keep their own file-name messages. Text classification preserves the file's
byte-order mark; invalid UTF-8 and NUL bytes open as binary details.

`submittedText(text)` from the main contract returns the bytes a save submits
and the exact text of those bytes. Row writes and app text editors use the same
encoding rule, including replacement of unpaired surrogates.

## Dataset names, definitions, and addresses

A folder ID names a dataset relative to its owner. In the managed native layout,
`so.epicenter.todos` names `local/so.epicenter.todos/` or
`accounts/<account-key>/so.epicenter.todos/` under the selected Epicenter root.
Reverse-DNS names provide a shared convention for compatible tools. A name such
as `so.epicenter.todos.work` denotes another dataset in a literal sibling
directory; dots do not create nested directories or inherited permissions.

A definition describes how this tool reads and edits the folder's files. It
names no folder: `defineFolder` refuses an `id`, at the type and when it runs.
Different tools can use different definitions to interpret the same files.
Compatible field meanings still matter when those tools write to the same
dataset.

Each successful browser, Bun, or Tauri acquisition attempts to overwrite root
`epicenter.json` before returning, with `formatDeclaration(definition)`. Each
table is one JSON Schema object, `{ type: 'object', properties, required }`,
whose properties are the table's fields as the prepared definition holds them;
`kv` is `{ type: 'object', properties }`, since every setting may be unset:

```json
{
  "title": "Vault",
  "kv": { "type": "object", "properties": { "theme": { "enum": ["light", "dark"], "x-field": { "kind": "select" } } } },
  "tables": {
    "pages": {
      "type": "object",
      "properties": {
        "title": { "type": "string", "x-field": { "kind": "string" } },
        "queuedAt": { "type": "string", "format": "date", "x-field": { "kind": "date" } }
      },
      "required": ["title"]
    }
  }
}
```

`required` is the one optionality marker in the file, and `field.optional` is
the one in code. The file contains no dataset identity, runtime resources, or
TypeBox `~` keys. The JSON uses two-space indentation, declared order, and a
trailing newline. Opening uses the application declaration; it never reads
this file as configuration.

Publication replaces manual descriptions and descriptions from another app
version. It migrates no saved rows or settings. A prepared definition is
plain JSON, so formatting cannot fail; a failed write is logged through
`wellcrafted/logger`, with the destination and actual failure, while the
folder remains usable. A failed attempt can leave discovery missing, stale, or
uncertain.

Publication always writes through `files.overwrite`, including on unchanged
reopening. It uses `commitOnEdit`: opening awaits the file attempt while
history settles separately, and identical trees create no additional commit.
Publication never explicitly commits or pushes. Opening an empty folder before
pulling an existing remote changes bootstrap behavior: with history disabled,
the uncommitted `epicenter.json` blocks incoming updates; with history enabled,
its local initial commit creates unrelated history. Get the remote's history
before the first opening: a browser account folder uses
[`downloadFolder`](#downloading-a-browser-folder), and a runtime with a clone
operation clones first. The current Todos browser startup opens first and
requires a separate remote-bootstrap repair.

```ts
const personal = await openFolder({ id: 'so.epicenter.todos', definition });
const work = await openFolder({ id: 'so.epicenter.todos.work', definition });
```

Both openings use the same prepared definition at different addresses. The
browser and desktop openers require `id`, and refuse a missing one before they
acquire anything. An application keeps its usual folder ID beside the code
that opens it, not in the definition. An application can open several
datasets, and several compatible applications can reach the same dataset. Its
app ID and private SQLite namespace are separate choices even when they use the
same string.

The complete managed address includes the channel, owner, and folder ID.
Browser storage also belongs to one origin. Opening captures the address for
the handle's lifetime; signing in later does not move its data or retarget its
writes. Browser callers select `browser.scope`; a native shell registers the
selected directory. The Bun opener instead receives an explicit directory and
no folder ID.
The managed native layout is described in
[ADR-0461](../../docs/adr/0461-portable-data-folders-live-under-local-and-derived-account-scopes.md).

## Entries

| Import | Opens | Use it when |
| --- | --- | --- |
| `@epicenter/folder` | The desktop app's folder when the page runs in Tauri, this browser's storage otherwise. Decided when `openFolder` is called, and only the chosen adapter is loaded. | Ordinary application code. |
| `@epicenter/folder/browser` | This browser's origin private file system (OPFS) only. Refuses inside the desktop app. Also exports `downloadFolder`. | A web-only build, a browser account folder downloaded before its first opening, or a test that injects an OPFS stand-in with `browser.opfs`. |
| `@epicenter/folder/tauri` | The desktop shell's folder only. Refuses outside it. | A desktop-only build. |
| `@epicenter/folder/bun` | An existing directory, in Bun. | Command-line tools, recovery scripts, and tests that are given a directory. |

The first three export the same `openFolder` signature and the same contract,
so one application source builds against any of them. `downloadFolder` is
the browser entry's alone; import it from `@epicenter/folder/browser`. Importing an entry opens
nothing. On a server, opening returns a refusal.

```ts
openFolder({
  id,        // required: which folder, such as 'so.epicenter.todos'. Never a path.
  definition,
  browser,   // optional: { scope, author, remote, httpFetch, commitOnEdit, createIfMissing, opfs }
}): Promise<Result<Folder, OpenFolderError>>
```

`browser` applies to a browser folder only. A browser folder uses a local
author by default. Complete saves request automatic commits; requests made
before a checkpoint starts share it. A `remote` needs an explicit `author`.
`httpFetch` supplies a fetch-compatible HTTP function for Git fetch and push.
It defaults to regular fetch; applications can supply an authenticated relay.
It receives the canonical remote URL and the operation's abort signal. It does
not replace global fetch or change the stored remote. Credentials belong to
the transport, outside the folder's files and Git configuration.
In the desktop app the shell owns the directory, the
author, the remote, and the history policy. The policy in effect is on
`folder.git.snapshot` either way.

Browser storage ownership can be supplied explicitly:

```ts
openFolder({
  id,
  definition,
  browser: { scope: { channel: 'development' } },
});
// For an account: scope: { channel: 'release', account }
// account is the captured { authorityId, principalId }, without credentials.
```

The browser derives the folder's directory, its Web Lock names, and its hint
channel from the same captured channel, scope, account key, and folder ID.
Later login changes do not retarget an open handle. Omitted scope and explicit
release Local open `Epicenter/local/<id>`; development uses `Epicenter Dev/`,
and an account `accounts/<account-key>/` in place of `local/`. A folder ID or
account key is one directory name: `/`, `\`, `%`, and control characters are
escaped, so distinct IDs stay distinct directories. Development and account
scopes do not change private app SQL.

A scoped folder starts beside the release Local folder of the same ID and
never reads it. The package does not infer which account owns Local data,
move it, or provide an assignment UI. Apps must choose their scope
explicitly; existing callers are not automatically switched to development
or account storage.

A desktop page whose folder cannot be opened (no plugin, no permission, an
unregistered ID, another protocol version, a folder another process holds)
gets that refusal. It is never given browser storage instead.

### Browser storage

A browser folder is one OPFS directory. Each literal path is one stored file,
each directory, empty ones included, is one stored directory, and `.git` in it
is the folder's private Git state: no path can name it and no listing shows
it. There is no inventory beside the files: a file's identity is the SHA-256
of the bytes read from it, so a same-size rewrite in the same millisecond is
still a change. `open(path)` returns a Blob of the bytes read, which keeps
them after the path is replaced.

Opening requires `navigator.storage.getDirectory`, writable file streams, and
Web Locks; without one it returns `NoFileSystem` and never falls back.
IndexedDB is not required and is never read or written. A folder an earlier
version kept in IndexedDB is not opened, copied, or removed.

Every file mutation holds the folder's files Web Lock, so the conditions of
`create`, `replace`, `remove`, and `move` are checked and published without
interleaving across tabs. Reads take no lock. New bytes publish when a file's
stream closes, so a reader sees the old bytes or the new ones; a new file is
visible, empty, from its creation until its stream closes.

| What happened | Outcome |
| --- | --- |
| A step failed before its stream closed | `Io`. A file the step created is removed again; when its absence cannot be established, `Unconfirmed`. |
| A stream's close threw | `Unconfirmed`, whatever the path holds afterward: matching bytes do not prove which write put them there. The path is hinted, the history observation turns stale, and an automatic commit records whatever the path holds. |
| A move landed its destination and could not remove its source | `SourceNotRemoved`. The destination is hinted. |

Saves are ordered by the lock alone, not by when their methods were called.
A save that hashes or waits longer can land after one asked for later, from
the same page or another, and whichever lands last on a path stays. A save
that must not overwrite bytes its caller did not review names them with
a capture and is refused as `Conflict` instead.

### Which directory is the folder

A directory is a folder only while its ready marker,
`.git/epicenter-folder.json`, names that folder's captured address. Opening
decides this under the address's open Web Lock, so two tabs never decide it
at once.

| The directory holds | Opening |
| --- | --- |
| A marker naming this address | Opens it. Other properties the marker records are kept and ignored. |
| Nothing (or it does not exist), or only an empty `.git` with at most an empty marker | Writes the marker, then opens it. With `createIfMissing: false`, `Absent` and nothing is written. |
| A marker naming another address, or one that names none | `Unavailable`. |
| A marker recording an unfinished download (`{ download: { address, remote } }`) | `Unavailable`, naming the download. Downloading again finishes it. |
| Anything else without a marker, or the path is not a directory | `Unavailable`. |

A pending download record has no top-level `address`, so an opener that
predates it refuses it as a marker naming no address.

`browser.createIfMissing` defaults to `true`. With `false`, opening decides
under the same open lock and creates nothing where no folder exists: no
directory, marker, `.git`, or `epicenter.json`. `Absent` names the
directory. A folder that exists opens as usual, offline too, and publishes
its `epicenter.json`; every refusal above is unchanged. An opener queued
behind one that creates sees the folder it made. Nothing remembers an
`Absent` answer, and nothing polls; each opening decides again.

Identity refusals write nothing, so no marker is replaced and no unknown file is
adopted. A marker write that fails, or whose stream close is unconfirmed, is
`Unavailable` too, and no folder is started. Opening again starts over only
where the marker is absent or empty; a marker the close did publish opens,
and one naming another address stays refused.

### Downloading a browser folder

A fresh browser signed into an account whose folder already has a paired
remote gets that history before the folder is first opened:

```ts
import { downloadFolder, openFolder } from '@epicenter/folder/browser';

const scope = { channel: 'release', account };   // the captured { authorityId, principalId }
const { data: landed, error } = await downloadFolder({
  id: 'com.bradenwong.zhongwen',
  scope,
  remote: { url, branch: 'main' },               // the paired repository
  httpFetch,                                     // the session-bound transport
  signal,
});
if (error !== null) return show(error.message);
const opened = await openFolder({ id, definition, browser: { scope, author, remote, httpFetch, createIfMissing: false } });
```

Account startup that must not make a folder before the person chooses opens
with `createIfMissing: false`:

```text
openFolder(createIfMissing: false) -> Ok           use the folder
                                   -> Absent       offer Download, or start empty
                                   -> Unavailable  show the cause; an unfinished download continues when downloaded again
Download    -> downloadFolder -> Ok           -> openFolder(createIfMissing: false)
                              -> Exists       inspect the refusal before opening
Start empty -> openFolder (default), which creates the folder
```

Only an explicit call downloads. Sign-in, discovery, and opening never do.
A download needs an explicit scope; without one it is `InvalidBrowserScope`
and nothing is created. `{ channel: 'release' }` targets Local. Adding the
captured `account` targets its separate directory. A launcher can download a
fresh Local folder before opening it, using the same protocol as an account
download. An ordinary Local opening still makes no network request.

Downloading opens no folder, publishes no `epicenter.json`,
and writes no settings. It first records the pending download in the marker
file, `{ download: { address, remote: { url, branch } } }`, and confirms that
write before any Git state exists. It then fetches the remote branch into the
address's `.git`, fast-forwards the unborn local `main` to it through the
ordinary incoming publication, and replaces the record with the ready marker
`{ address }` last. `landed.head` is the
downloaded commit. Opening afterward publishes `epicenter.json` as an
ordinary save over that history, so its commit has the downloaded head as
parent, or there is none when the bytes match.

A remote without the branch is downloaded as `head: undefined`: local `main`
stays unborn, `origin` names the remote, and the folder is marked ready with
no files. No fast-forward checks the folder then, so a folder file the
download did not write, such as one put beside a pending record, is
`Incomplete`, named and kept, and the record stays. The first opening
publishes `epicenter.json` as the root commit, and the first push creates
the branch.

| The directory holds | Download |
| --- | --- |
| Nothing, or it does not exist, or only an empty `.git` with at most an empty marker | Records the pending download, then downloads. |
| A pending record with this exact address, URL, and branch | Continues: recovers an incoming update left pending, fetches again, fast-forwards, and marks it ready. |
| A pending record for another address, URL, or branch | `Exists`, naming that download. Nothing is written. |
| A ready marker, for this address or another, or one that names nothing | `Exists`, with its `origin`. Nothing is written. |
| Any entry without a marker, or the path is not a directory | `Exists`, naming the entry and any `origin`. Nothing is written. |

Only the record decides ownership. A configured `origin` is reported in
`Exists` and never makes Git state or files without a record continuable.

After `Exists`, only `reason: 'is this folder'` confirms a ready folder at
this address. Other refusals must not be treated as a successful download.
A caller that opens with a remote must also check the reported `origin`:
opening with a different URL would replace that configuration. A launcher
may attach a remote to an unconnected Local folder, but must refuse a
different existing origin. Use `createIfMissing: false` after downloading
or accepting a ready folder, so a vanished directory does not become a
new, unrelated history. Ready folders, including ready folders with no
files, are outside download ownership; synchronize them explicitly.

The download holds the address's open Web Lock throughout. An opener of the
same address waits, then opens what landed; a second download gets
`Exists`. No handle can be open on the directory meanwhile, because the
opener refuses a pending record and an unmarked directory that holds anything.

A download that fails, or whose `signal` aborts, is `Incomplete`, and nothing
is rolled back. What landed stays for inspection: the record, Git objects,
refs, configuration, an incoming record, and any files it wrote. The
transfer is cancelled. Usually the record still stands, so opening refuses
the directory as `Unavailable` and publishes nothing there, and calling
`downloadFolder` again with the same address, URL, and branch continues.

`Incomplete` does not always mean the folder is not ready. Two marker writes
can end unconfirmed:

| Write | Did not publish | Published, unconfirmed |
| --- | --- | --- |
| The pending record | Nothing else was written; at most an empty marker remains. Opening without creating is `Absent`; downloading again starts over. | The record stands alone. Opening refuses it; downloading again continues. |
| The ready marker | The record stands beside the complete download. Opening refuses it; downloading again marks it ready. | The folder is ready. Opening with `createIfMissing: false` opens the complete history; downloading again is `Exists`. |

Opening with `createIfMissing: false`, or downloading again, shows which
state is durable. A path that holds neither an incoming update's before nor
its after state, such as an empty file a closed tab never finished writing,
is named in the `Incomplete` cause, and nothing is written. Remove that path;
the next download continues. Nothing removes or resets the directory, and the
folder API cannot open a pending one.

Every download fetches before it marks anything ready, and the tracking ref
`refs/remotes/origin/<branch>` must then name exactly what that fetch found.
Isomorphic-git's fetch leaves the ref an earlier attempt wrote when the
remote no longer has the branch, and a later pull would adopt that cached
commit. Such a download is `Incomplete`, naming the cached commit; the ref,
its objects, and any files stay. The next download after the remote has the
branch again replaces the ref with the fresh head and continues. If the branch
is gone for good, the cached ref is the entry to remove.

`httpFetch` is used for this download only. Credentials stay in it, and the
folder's Git configuration records only the canonical `remote.url`. A download
never rewrites the `origin` of a directory it refuses. Opening with
`browser.remote` still writes that remote's URL as `origin` at each opening.

### Building for one environment

Alias the exact bare specifier. Do not rewrite subpaths.

```ts
// vite.config.ts
resolve: {
  alias: [{ find: /^@epicenter\/folder$/, replacement: '@epicenter/folder/tauri' }],
}
```

With `/tauri`, no browser storage and no Git implementation is emitted. With
`/browser`, no desktop adapter is emitted. Without an alias, both adapters are
emitted as separate chunks and neither loads until a folder is opened.
`evidence/bundles` builds these and reads the output.

The shell's terminal uses just-bash, whose browser bundle references
`node:zlib` for gzip commands the terminal does not enable; an application
aliases that module.

### The directory entry

```ts
import { openFolder } from '@epicenter/folder/bun';

const opened = await openFolder({
  root: '/path/to/an/existing/directory',
  definition,
  git: { author: { name: 'Tool', email: 'tool@example.test' }, commitOnEdit: false },
});
```

This is a different opener: it takes the directory and the history settings
explicitly, and this process records history itself with the `git` program. It
is not the desktop adapter, and it does not watch the directory.

Its replacements need a small Node-API addon, `addon/exchange.c`, on macOS
and Linux, built before the process runs:

```sh
bun run --filter @epicenter/folder build:addon
```

`packages/folder/scripts/build-addon.ts` compiles it with `$CC` (else `cc`) against the
`node-api-headers` development dependency into the ignored `addon/build/`;
it does nothing on other platforms. These package scripts run it first: `test`
here and in `apps/whispering`, `apps/capture`, `apps/todos`,
`apps/honeycrisp`, and `packages/capture`; `test:native` in
`apps/honeycrisp`; `native` in `apps/todos`; and `harness:recovery` in
`apps/capture`. Anything else, including `bun test` run directly and other
Bun tools, needs the command above first. Without a current build, a
replacement fails as `Io`, writes nothing, and names that command; it lands
once the build exists. An addon whose source cannot be read or whose build
cannot be loaded fails the same way with the actual cause, which rebuilding
may not fix. Nothing compiles at install time or at run time, and browser,
server, and desktop builds never load the addon or need a compiler.

### Reading a data folder without opening it

```ts
import { readFolder } from '@epicenter/folder/bun';

const { data: reading, error } = await readFolder('/path/to/a/data/folder');
if (error !== null) return show(error.message); // NotDataFolder, InvalidDeclaration, or a file error
reading.definition; // the prepared declaration from epicenter.json
reading.tables.todos; // exactly what tables.todos.list() returns
reading.kv; // exactly what kv.get() returns
```

A data folder is a directory holding `epicenter.json` (ADR-0517), the
declaration an opener publishes as `DECLARATION_PATH`. `readFolder` reads it,
prepares it, and reads every declared table and `kv.json` through the same
tables, settings, and native file boundary an opened folder uses, so a tool
and an application reach the same verdict on every file. A symbolically
linked table directory is that table's `InvalidPath`, never followed.

`parseDeclaration(text)` reads the file's grammar and nothing else: a
top-level `$schema` (which only helps an editor offer completion), `title`,
`kv`, and `tables`, each table `{ type: 'object', properties, required? }`
with every `required` name declared, and `kv` without `required`. A table
without `required` has only optional fields. Any other key, a visible `~` key
on a field, or a field preparation refuses, such as one with an unknown
`format` or a `$ref` that names nothing in the field, is
`InvalidDeclaration`. The older `{ fields }` shape is refused; there is no
migration.

It writes nothing: no Git repository, marker, lock, or declaration, and it
loads no native addon. It can read a folder an application has open, or one
nested anywhere in another repository. Each file is read whole, but the
reading is not a snapshot across files: a save in progress elsewhere can show
in one table and not yet in another.

It checks files, not the root's Git layout. A folder whose `.git` is a
`gitdir:` file (a submodule) reads, though `openFolder` refuses it, so a
successful reading does not mean an application can open the folder.

## The handle

| Member | Contract |
| --- | --- |
| `tables.<name>` | Rows at `<name>/<stem>.md`, read through `parseRow` and written through `formatRow`. `get(stem)` returns a `StoredRow` (`path`, `sha256`, and a complete, caller-owned `row`), `InvalidRow` for readable text that is not a valid row, or `undefined` only for absence. `list()` returns one `{ stem, result }` per row file. `create(row, { stem? })` is exclusive. `replace`, `rename`, and `delete` take a capture and are refused as `Conflict` when its bytes are gone. `autosave(capture)` coordinates one editing session's saves. Each changes exactly one Markdown file. See [Reading a row](#reading-a-row), [Saving a row](#saving-a-row), and [Editing a row](#editing-a-row). |
| `kv` | Root `kv.json`, independent settings. `get()` returns `{ path, sha256, values, issues }`: every declared value that validated, with each broken one reported at its line, or `InvalidKv` for text that is not one strict JSON object. `set(key, value)` merges one key into the current file, keeps every other key's raw text, creates a missing file, removes a key set to `undefined`, and re-applies itself when another writer got there first. See [Reading and saving kv.json](#reading-and-saving-kvjson). |
| `files` | Ordinary files at literal paths. See below. |
| `git` | A status snapshot, `status()`, `commit()`, `commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, `mergeIncoming()`, `recoverIncoming()`, and `paths()`, `stage()`, `commitStaged(message)`, `diff()`, `log()`. |
| `sync` | `run()` commits saved files, fetches, merges, and pushes; competing settings, row fields, row bodies, and whole row files come back as a `SyncAttempt` that `resolve(attempt, choices)` settles. See [Sync](#sync). |
| `location` | `{ kind: 'opfs', directory }` or `{ kind: 'directory', root }`. For showing to a person. File paths are never joined onto it. |
| `onFilesChanged(listener)` | A hint that paths changed, so read again. Returns the function that stops listening. |
| `terminal({ cwd })` | A shell over the folder's files and history. |
| `signal`, `close()` | Closing fences the next storage call and stops network work. Git work drains before storage is released; file operations own their completion promises. It makes no final automatic commit. |

### Files

```ts
const { error: createError } = await folder.files.create('audio/take.webm', bytes);
if (createError !== null) return show(createError.message);         // refused if anything is there
const { data: file, error: readError } = await folder.files.read('notes/a.md');
if (readError !== null) return show(readError.message);             // file is { path, sha256, bytes }
const { data: next, error: replaceError } = await folder.files.replace(file, 'new text');
if (replaceError !== null) return show(replaceError.message);       // refused if it changed since
const { data: moved, error: moveError } = await folder.files.move(next, 'notes/b.md');
if (moveError !== null) return show(moveError.message);             // refused if either end changed
const { error: removeError } = await folder.files.remove(moved);
if (removeError !== null) return show(removeError.message);         // refused if it changed since
const { error: overwriteError } = await folder.files.overwrite('settings.txt', 'on');
if (overwriteError !== null) return show(overwriteError.message);   // whatever is there
```

The verb states the condition. `replace`, `remove`, and `move` act on a
**capture**: a plain, frozen `{ path, sha256 }`. The hash identifies the exact
bytes captured; byte length remains inventory metadata. A capture holds nothing
open, can be serialized, and never changes. A successful save returns a new
capture; the one passed in stays what it was. A stored row and an
`InvalidRow` are captures of their row file, a KV snapshot is a capture of
`kv.json`, and so is a `read` result.

- Strings are saved as UTF-8 with nothing added or normalized. Byte arrays are
  copied when the method is called, so reusing the array afterward changes
  nothing.
- A save's capture is computed from the bytes it was given. Nothing is read
  back. If another writer lands right behind the save, the capture still names
  what this save wrote, and the next `replace` with it is a `Conflict`. Read
  the file to observe what is there now.
- A moved file's capture is the captured hash at the new path. It is a
  receipt conditioned on that baseline, never a read of the destination:
  another program may write there afterward, and a directory's source check
  is best effort against outside programs. Read the file to know what it
  holds now.
- `create` reports `Exists` for an occupied path even when the bytes are identical.
- A stale capture is a `Conflict`. Nothing is merged, replayed, or retried.
- `autosave(capture)` saves one editing session's content, each write guarded
  by the bytes the previous one saved ([Editing a row](#editing-a-row)).

Internally, the same intention reaches each backend as `create`, `replace`,
`overwrite`, `remove`, or `move`. `replace`, `remove`, and `move` carry an
optional `expectedSha256`; `files` and tables always send one, and only
`create` and `overwrite` publish unconditionally. Without the guard, each still requires a
file at its path or source: a `replace` never creates a file and is never sent
as an `overwrite`, and a move's destination must be empty. Browser OPFS, the
Bun directory, and the desktop owner enforce this where they publish. There
is no sentinel union mixing hashes with `'absent'` or `'any'`.

A `replace` requires its file when its bytes land, not only at a check
before, so a file another program removes is never put back: the save is
`NotFound`, or `Conflict` with no actual hash when guarded. The Bun directory
and the desktop owner exchange a staged file with the file in one system call
on macOS and Linux (and, for the desktop owner, iOS and Android), and a
filesystem there that cannot exchange fails the save as `Io`. The exchange is
the only operation on the path. If what it displaced is not a regular file,
or cannot be inspected, it stays where the exchange left it under
`.git/epicenter/scratch`: the save landed, and is reported as `Unconfirmed`
(a raw batch reports `Partial`) with a message that names that location.
Inspect the file, and anything written to it since, before restoring from
it. On Windows, and any other platform without an exchange, the Bun
directory and the desktop owner have no `replace` until a mechanism that
requires the file at publication is proven: the save is `Io` naming the
platform, the staged copy is removed, and this operation does not change the
destination. The caller keeps its input to copy or export; nothing retries.
Creation, reads, overwrites, moves, and removals are unchanged by this repair;
none is verified on Windows. Replace-based native suites are expected to fail
there with `Io`. The desktop owner has not been built for Windows. Browser folders, in any browser on any
operating system, are unaffected. OPFS opens the file without creating it
and checks again once its writable stream holds the lock that, in Chromium,
refuses removing the file or a directory above it; a Chrome 142 probe showed
that, and other engines are unverified. Bytes another program writes in that
last window are still replaced: the hash check stays best effort.

`list()` inventories the whole folder; `children(directory)` lists one level
and accepts `''` for the root. Both name every entry: real subdirectories in
`directories`, and everything else in `files`, including a symbolic link or
special entry such as a named pipe. Neither is followed: a link's listed size
is its own, and a read of either is `InvalidPath`. A name that is not UTF-8,
which Linux allows, is listed by its lossy spelling, with U+FFFD for each
invalid sequence; a read of that spelling is `InvalidPath`, because no folder
path names the file. On macOS and Linux, a read opens the path without
following a link or waiting on a pipe, and checks again what it opened, so a file replaced by
either after it was inspected is refused rather than followed or left
waiting. Commits capture regular files only. `open(path)` returns a stable
`Blob` for consumption, without holding a file descriptor. `mkdir(path)` creates missing
parents; `rmdir(path)` removes an empty directory. These directory operations
do not request history through the file publisher.

### Tables own only their row files

A table reads and writes one Markdown file per row. A file that shares a
row's stem, such as `recordings/take.webm` beside `recordings/take.md`, is an
ordinary file. It is not part of the row, does not block creating the row,
and stays where it is when the row is renamed or deleted. An application that
keeps media records the path in a field or a Markdown link and manages those
files through `files`. Nothing scans references, repairs links, or collects
unreferenced files.

### Reading a row

Every read goes through one pipeline: parse the complete frontmatter, then
check every declared field (ADR-0515). A file whose text was read is either a
`StoredRow` or `InvalidRow`:

```ts
const { data: stored, error } = await folder.tables.todos.get(stem);
if (error?.name === 'InvalidRow') return openTextEditor(error); // { path, sha256, text, issues }
if (error !== null) return showReadError(error); // I/O, or InvalidUtf8
if (stored === undefined) return showMissing();

stored.path; // 'todos/abc.md'
stored.sha256; // the bytes that were read
stored.row; // { fields, body }: complete, unknown keys included, yours to edit
```

`row` belongs to the caller: it is mutable, shares nothing with another
read, and keeps every frontmatter key, declared or not, so the complete row
can be saved back. `path` and `sha256` describe the read and never change; a
guarded write takes them as its capture.

`InvalidRow` is every way readable text fails to be a row: no fences,
malformed YAML, a value with no exact JSON form, or a declared field that is
missing or does not conform. It carries the exact text, the hash of its
bytes, and `issues`, located like compiler diagnostics:

```ts
type Issue = { message: string; line?: number; field?: string };
```

`issues` is never empty. `line` is 1-based over the whole file and absent
only for a declared field the text lacks. Text with no canonical form has
exactly one issue; text that parses has one per failing field. There is no
partial row: an invalid row is repaired as text, guarded by its hash.

`list()` reads every `.md` file directly in the table's directory through the
same pipeline. Each item is `{ stem, result }`, where `result` is the
`StoredRow` or the error that `get` would return; an outer error means the
listing itself failed.

A read is a snapshot. Nothing follows the file: an application reads again
when a view opens, after its own actions, and when the person returns to it.
`onFilesChanged` (see Hints) is the low-level signal for an application that
wants to reread sooner.

### Rows as text

`parseRow` and `formatRow` are the pipeline itself, from a table of the
prepared definition and no open folder. They read an unsaved buffer as
readily as a file:

```ts
const { data: row, error: issues } = parseRow(definition.tables.todos, text);
const { data: saved, error: issue } = formatRow(definition.tables.todos, row);
```

`formatRow` writes one fixed text for a row: declared keys first in declared
order, then other keys in UTF-16 code unit order, nested keys in that order
too, and the body byte for byte. It checks representation, not the schema:
`NaN`, a `Date`, a class instance, a cycle, or a lone surrogate is refused,
and `undefined` in a mapping is an absent key. Text it writes always reads
back through `parseRow` as the same row.

The frontmatter is block-style YAML that a YAML 1.2 reader and a YAML 1.1
reader (PyYAML, Ruby's Psych, Go's `yaml.v2`) read identically:

```yaml
---
title: Buy milk
done: false
tags:
  - home
  - errand
note: "yes"
due: "2026-10-11"
notes: |
  line one
  line two
---
Two percent.
```

A string is plain only when it starts with a letter or `_`, holds only
letters, digits, spaces, and `_ . , ' ( ) / -`, ends without a space, and is
no boolean or null word in any case. Everything else is double-quoted with
explicit escapes. Multi-line strings are literal blocks when no reader can
misread them, and quoted otherwise. Floats keep a decimal point (`1.0e-7`),
and negative zero is `-0.0`. Comments, quoting, key order, a byte-order mark,
and header CRLF in source are normalized away by the first save.

### Names

A stored row's `path` is `rowPath(table.name, stem)`, and
`rowStemOf(table.name, path)` is the inverse; it returns `undefined` for a
path that is not a row of that table, including `a.MD`, which is an ordinary
file.

A stem is one literal filename segment. Nothing trims it, folds its case,
normalizes its Unicode, or strips an extension. `'bad '`, `'.hidden'`,
`'a: b'`, and the empty stem (`todos/.md`) are addresses like any other, and
a name is never a diagnostic. An empty stem is an address, so compare a stem
with `undefined` explicitly rather than by truthiness.

A stem with a path separator, a backslash, or a control character is
`InvalidPath`, so no stem can address a nested path such as `todos/a/b.md`.
Whether a name can be stored, and whether two spellings are one file, is the
backing storage's answer. Browser storage keeps names exactly, so `Plan` and
`plan` are two rows. A directory on a filesystem that holds one file for both
refuses the second with `Exists`. Incoming history has its own rule and may
refuse paths a filesystem could not hold apart; see Incoming changes.

### Saving a row

`create` is the one unconditional write. Every other write names the bytes it
replaces with a capture, `{ path, sha256 }`: a `StoredRow`, an `InvalidRow`,
a listed row, or the `file` of an autosave state passes as it is.

```ts
const created = await todos.create({ fields, body: '' }, { stem: 'milk' }); // Exists if taken
const replaced = await todos.replace(stored, stored.row); // a StoredRow of what was saved
const moved = await todos.rename(stored, 'groceries'); // the capture at the new path
await todos.delete(stored);
```

A capture whose file no longer holds those bytes is `Conflict`, and a missing
file is `Conflict` too: a guarded write never recreates a deleted row.
Nothing retries. `create` and `replace` save only a valid row: a value that
does not conform or cannot be written is `InvalidValues`, and nothing is
published. A rename to the stem it already has is `InvalidPath`; a rename
onto an occupied stem is `Exists`. A move that landed its destination but
could not remove its source is `MoveError.SourceNotRemoved`; its `moved`
capture names the destination, so the application can continue from there
and remove the leftover source under its own guard.

A host that loses a reply reports `Unconfirmed`: the change may or may not
have landed. Present it as uncertainty, never as a definite failure.

### Editing a row

An editing session owns its draft; the folder coordinates the saves it
requests. A component reads once, keeps the row in its own state, and
requests a save on input:

```svelte
<script lang="ts">
	import { untrack } from 'svelte';
	let props: { folder: TodosFolder; initial: StoredRow<Todo> } = $props();
	// Seeds for this session; the parent keys on the stem, so capturing once is correct.
	const { folder, initial } = untrack(() => ({ ...props }));

	const row = $state(initial.row);
	let save = $state.raw<SaveState<RowSaveError>>({ status: 'saved', file: initial });
	const saves = folder.tables.todos.autosave(initial, { onState: (next) => (save = next) });

	function edit(change: () => void) {
		change();
		saves.request(row); // formatted before it returns
	}
</script>
```

`request(row)` prepares the row before returning, so later typing never
changes an earlier save. One write runs at a time; requests made while it
runs replace one pending snapshot, so intermediate drafts may never be
written. A save result never assigns the draft.

Each write is guarded by the bytes the previous one saved, starting from the
capture the session began with. A change made elsewhere, such as a Git pull,
another tab, or an agent, is `Conflict`, and the other change stays.

`table.merge(path, { base, ours })` then merges the draft with that change
the way sync merges a file (ADR-0514): `base` is the row the session last
saved or read, `ours` the draft, and the file as it is now is theirs.
Independent fields and body lines combine and are written over their version
at once, guarded by its bytes (`saved`). What does not combine is `held`:
fields or a body both changed, or the whole file when it was deleted
elsewhere or is no longer a valid row or text. Its `conflicts` are the same
`SyncConflict`s sync reviews, and `resolve(choices)` settles one
`SyncChoice` for each and writes the result guarded by the bytes the merge
read, or refuses with `InvalidChoices`, naming each problem. A further change
made elsewhere is `Conflict` again. `{ restore: false }` refuses to bring
back a file deleted elsewhere. `files.merge` does the same for any text
file, by the folder's own rules: a row by field and body, `kv.json` by key,
other text by line. `@epicenter/svelte/edit-session` runs this for an
editing session.

`onState` reports the latest request: `saving`, `saved`, or the `error` that
stopped it. Every state carries `file`, the capture the session last
confirmed, which guards a rename or delete from the same view. A draft that
is not a valid row is that request's `InvalidValues` at once and is never
written; an older write that finishes afterward cannot report `saved` over
it. Nothing retries, and requesting again is the retry. `settled()` waits for
the work in flight without starting any. Nothing is saved when the session
ends unless it was requested.

A row that is not valid is repaired as text. `files.autosave(capture)` is the
same session over raw content, guarded the same way, starting from the
`InvalidRow` the read returned:

```ts
const saves = folder.files.autosave(invalidRow, { onState });
saves.request(text);
```

### Reading and saving kv.json

`kv` is one root file of independent settings (ADR-0522). A setting is an
intent, not a document: `set('theme', 'dark')` means "the theme is dark",
whatever the file held a moment ago.

```ts
const { data: settings, error } = await folder.kv.get();
if (error?.name === 'InvalidKv') return openTextEditor(error); // { path, sha256, text, issues }
if (error !== null) return showReadFailure(error);
const kv = { ...KV_DEFAULTS, ...settings?.values }; // settings: { path, sha256, values, issues } | undefined

await folder.kv.set('theme', 'dark'); // returns the reading it wrote
await folder.kv.set('theme', undefined); // remove the key, so the default applies
```

Reading is per key. `values` holds every declared key whose stored value
validated. A stored value that does not conform is left out and reported in
`issues` at its line, so one hand-broken setting falls back to its default
without hiding the others. A key the file lacks is not an issue, and an
undeclared key stays in the file unreported. The folder has no defaults: an
application spreads its own under `values`.

`InvalidKv` is only for text a folder cannot hold: not one strict JSON object
(comments and trailing commas do not parse), a key that appears twice at any
depth, an unpaired surrogate, or nesting beyond 64 containers. A value over
the nesting or width budget is an issue on read, as a set of it is refused. It carries the exact
text and its hash, so the file is repaired as text, guarded by those bytes.

`set(key, value)` changes one key:

- A value that is undeclared, does not conform, is over the nesting or width
  budget, holds an unsafe integer, or has no exact JSON form is
  `InvalidValues` before anything is read. The value is owned at the call.
- It reads the current file, merges the key into it, and publishes guarded by
  that read. Every other key keeps its raw text, so number spellings and
  unknown keys survive. The text is written in the merge format below, so a
  local save and a Git merge produce the same file.
- A missing file is created. `undefined` removes the key.
- Sets from one handle apply in the order they were called; a later set of a
  key waiting behind a running one replaces it.
- When another writer published first, or the reply was lost as
  `Unconfirmed`, the set re-reads and re-applies itself, so two windows
  setting different keys both keep their changes. After three attempts it
  reports the last refusal.

One top-level key is one fact. Settings that must change together belong in
one key with an object value, which is set and merged as a whole.

`KvReadError` and `KvWriteError` are the two error unions.

### Merging kv.json

`mergeKv({ base, ours, theirs })` reconciles three captured `kv.json` texts
without opening a folder. Each input is a JSON object string or `null` for a missing
file. Rust exposes the equivalent `kv_merge::merge_kv(base, ours, theirs)` in
`epicenter-folder-core`. Both implementations run the same fixtures.

For each root key, equal choices agree; a side unchanged from the base yields
to the other side. Competing changes return `kind: 'conflict'` with each key's
raw base, ours, and theirs values. Nested objects and arrays stay together as
one value. A missing key differs from a stored JSON `null`. Deleting the file
conflicts with a change to its values and returns `kind: 'file-conflict'`.

A successful result has `kind: 'merged'` and `text`, the complete merged file
text, which is `null` for a deleted file. It preserves selected value text and
regenerates root formatting with sorted keys. Object key order and string escape spelling do not affect
equality. Number tokens compare exactly, so `1` and `1.0` differ; large unknown
numbers never round through JavaScript. Equal values choose the same raw text
when ours and theirs swap.

Malformed JSON, duplicate keys at any depth, unpaired Unicode surrogates, and
nesting beyond 64 containers return `kind: 'invalid'` and the first invalid
`side` in base, ours, theirs order. A leading BOM is accepted and removed from
output. Callers must decode bytes without replacing invalid UTF-8.

Sync settles competing keys through the same merge (`reconcileKv` in
`kv-merge.ts`): each settled key is its raw value text, or `null` to leave
it out, and applies only where the key competes.

The function does not apply field schemas, write files, or choose a winner for
competing edits. Its module owns `kv.json` text: `kv.set` writes through the same
formatter, so a local save and a merge produce the same file. A browser folder's `git.mergeIncoming()` uses it for root
`kv.json`; see [Merging incoming changes](#merging-incoming-changes).

### One file per save

Every save changes one file, or for a move one source and one destination.
There is no multi-file transaction: an application that keeps a row beside a
media file saves the media first and the row after, and on a failure between
them reads what landed before deciding what to save next.

### Hints

`onFilesChanged` says which paths a change reached, as a request to read again.
There is not one call per save, calls are not ordered against other writers,
and a hint is never a capture. Subscribe before the first read so nothing falls
between them. Closing stops all listeners at once, including the ones still
waiting in a dispatch that a listener closed the folder from.

A listener runs inside the save that caused the hint. What it throws is
logged and goes no further: the save still returns its capture, still
requests its commit, and the other listeners still hear. The same holds for a
`git.subscribe` subscriber.

| Folder | Announces |
| --- | --- |
| Desktop | Every change the owner sees: this window, other windows, and other programs. |
| Browser | This handle's saves and incoming updates, and those of other tabs on the same origin. |
| Directory (Bun) | This handle's saves and incoming updates. Other programs are not watched. |

### Terminal

`folder.terminal()` runs a just-bash shell over the same files, loaded when
its first command runs. Its `git` command supports `status`, `diff [--cached]`,
`log`, `add`, `commit -m`, `push`, `fetch`, `pull --ff-only`, and `merge`. A
redirection is a deliberate overwrite; a rewrite of a file the same command
read is conditional on what it read. `add` and staged `commit -m` need
`commitOnEdit: false`. `git merge` merges the already fetched remote branch
(`pull --ff-only` fetches first) when it fast-forwards or merges cleanly. A
conflict, in either history mode, writes nothing: it prints Git's
`CONFLICT` lines and `CONFLICTS_NEED_SYNC`, which points to Sync, and exits
1. A command holds nothing between its steps, in the
browser or the desktop app: another tab's or window's save can land between
them, and a command that stops partway leaves its earlier steps saved. Each
save follows the folder's automatic history policy. The terminal ends with
the folder: closing stops a running command at its next step.

The filesystem adapter maps reads to `storage.read`, file mutations to
`storage.apply`, and directory changes to `storage.mkdir` and `storage.rmdir`.
File and directory metadata share an inventory read at command start and
refreshed after the command's own changes and a successful Git pull. Reads
fetch current bytes. Append reads the destination before saving, uses exclusive
creation for a missing file, and replaces an existing file conditionally.
Binary pipelines and redirection preserve bytes. Recursive copies preserve
empty directories; directory moves relocate captured paths without reading
file contents. A file added to the source during a move stays there and can
prevent the source directory from being removed.

This is a virtual filesystem over literal Folder entries. Move destinations
must be unoccupied, including directory destinations; moves refuse existing
files instead of overwriting them. Content writes and directory moves can
create missing parent directories. Permissions and timestamps are synthetic,
and entry identity does not expose native hard-link aliases.

## History

Browser handles, Bun directory handles, and the desktop app's Rust owner follow
the same history rules. Where the desktop owner differs, this section says so.

A save returns once its files are published and never waits for Git. A commit
pins the branch head, captures every source file, writes a commit with a
subject derived from the tree difference, and moves the branch only with a
compare-and-swap. A moved branch is reported and not retried. Commit and push
failures never undo a save.

With `commitOnEdit` (default `true`), each complete table, KV, or file save
this handle published asks for a commit in the background. If another tab, a
pull, a staged command, or an earlier commit holds the folder's Git work, the
request waits for it, together with every later request: when that work ends,
one commit captures the latest files without another save. Each handle keeps
at most one such waiting request, and no copy of the saved bytes. Any
whole-folder commit, including an explicit `commit()`, answers the requests
made before it started. An automatic waiter whose requests were already
answered skips capture and records nothing. A browser or Bun save racing an
admitted capture can authorize one later `unchanged` pass, which creates no
empty commit. A commit that fails is reported in
`git.snapshot.lastCommit` and is not retried; the next save asks again.
There is no timer and no commit when the folder closes: a request still
waiting then is dropped, so the last save can stay uncommitted indefinitely.
Edits made by another program or tab ask for nothing. A save that stopped
partway or whose outcome is unknown asks like any other: a commit records the
folder's files as they are, never a claim about which save put them there. `git.snapshot.files` turns `stale` when
a save lands after the last capture, and `git.status()` lists what is
uncommitted.

The browser and Bun openers use local `main`. A remote branch selects the
transfer destination; it never selects another local history. An existing
repository with `HEAD` on another branch refuses commits and incoming
adoption until its branch is deliberately reconciled.

Automatic commits and `commit()` stay local, even with a configured remote.
Only explicit `push()` or `commitAndPush()` requests upload history.
`commitAndPush()` commits and then pushes;
a caller `signal` only stops that caller waiting, and a caller that stopped
during the commit starts no push. An explicit request waits for the folder's
Git work and then reads the folder, so it includes saves made while it
waited. If the folder closes while it still waits, it is told `closed` and
nothing runs.

Source files are tracked files plus untracked files that `.gitignore` does not
exclude; private Git state is never source. SQLite filenames have no special
exclusion: an intentionally saved database follows ordinary Git rules. Plain Git
records binary files like any other file. There is no default audio ignore, no
format list, and no LFS.

### Closing

`close()` fences new file work, stops hints, refuses new Git requests, and
cancels pushes and fetches. It does not await file helpers or publication
replies. Await a save that must finish before closing:

```ts
const { error: saveError } = await folder.files.create('note.md', 'Saved before leaving');
if (saveError !== null) return show(saveError.message);
await folder.close();
```

A helper still reading or hashing can be refused at its next storage call. An
already-started application returns its actual Result, including `Partial` or
`Unconfirmed`. Closing never relabels that outcome. A browser write that
already holds the files lock can finish after close returns, although its
cross-tab hint can be lost once the notification channel closes.

A Git request still waiting for admission is refused; work that already
entered its protection
settles before storage is released. No final commit is required, and saved
files can remain uncommitted after close.

In the desktop app, closing detaches this page. The owner keeps the folder,
finishes operations it already accepted, the commit, and any push or fetch it
had already started for the page, and serves every other window. A push or fetch of the page that
the owner had not started is withdrawn and never starts. The owner makes no
commit because a page closed or the app quit: a save whose request was still
waiting when the app quit stays uncommitted there too.

### Sync

`folder.sync` is the one action an application offers for "bring this folder
and its remote together" (ADR-0514). `run()` commits the saved files, fetches
the remote branch, merges, and pushes without force:

```ts
const { data: ran, error } = await folder.sync.run();
if (error !== null) return show(error.message);
if (ran.kind === 'needsChoices') return review(ran); // nothing conflicted was written or sent
// ran.kind: 'synced', or 'saved' when the push is not confirmed
```

A folder that had no history before the run, whose first commit the run
made, adopts the remote's history by merging over an empty base; two
different files at one path are then a conflict like any other.

Its merge is `mergeIncoming`'s with two additions for paths both sides
changed:

| Path | Merged by | A conflict is |
| --- | --- | --- |
| root `kv.json` | key (`reconcileKv`) | `setting`: one key, with JSON values |
| `<table>/<stem>.md` of a declared table | field and body, through `parseRow` (`mergeRow`) | `field`: one field, with JSON values; `body`: the notes, as text |
| any other UTF-8 text file | line | `file`: the whole text, when lines compete |
| any of these, when one side deleted it or a version does not read | nothing | `file`: the whole text |

Field values compare as JSON, so quoting, key order, and frontmatter
comments never conflict; the body merges by line. A merged row is written by
`formatRow`, in the standard form. A binary file, a link, executable, or
submodule, and a file against a directory are `Unreviewable` and nothing is
written; repair them with Git outside the folder.

A `SyncAttempt` is `{ kind: 'needsChoices', id, local, incoming, conflicts }`.
Each conflict has an opaque `id`, its `kind`, `path`, `key` or `field`, and
`base`, `local`, and `incoming` versions, each `{ present: false }` or
`{ present: true, value }`. `resolve` takes one choice per conflict ID:

```ts
const choices = {
	[title.id]: { kind: 'take', side: 'incoming' }, // the captured version; an absent side removes
	[theme.id]: { kind: 'replace', value: 'dark' }, // JSON for a setting or field, text for a body or file
	[tags.id]: { kind: 'remove' },                  // not for a body; replace it with ''
};
const { data: done, error } = await folder.sync.resolve(attempt, choices);
```

- Choices are read before `resolve` first awaits. Every problem is reported
  at once as `InvalidChoices`, each `{ conflictId?, reason, message }`: a
  missing or unknown entry, a malformed or disallowed choice, or a value the
  folder refuses. A replacement setting is checked as `kv.set` checks it, and
  a resolved row must read back through `parseRow`, so removing a required
  field is refused. `InvalidChoices` writes nothing and keeps the attempt.
- A `file` choice is written exactly as chosen, or removes the file. Text that is not a valid row
  then reads as `InvalidRow` and is repaired as text, like any other.
- Otherwise the attempt is spent. `resolve` merges the captured commits
  again, never fetching, publishes the merge like `mergeIncoming`, and pushes.
  An attempt replaced by another `run()`, or a folder whose branch moved or
  whose saved files changed since the attempt, is `Stale` and nothing is
  written.
- `synced` means the push confirmed the merged head and no save landed after
  the capture. `saved` carries the push's own outcome and `changedSince`.

Browser and Bun folders sync, and `folder.sync.supported` is `true`. A
desktop folder answers `Unsupported` from both methods and says so with
`supported: false`, so an app can offer its separate Git actions there.

### Incoming changes

Browser fetch uses isomorphic-git 1.38.5, which fails when a non-default
remote branch exists but the server advertises no resolvable `HEAD`. This
failure leaves local files and history intact.

`fetch()` records the remote head. `pullFastForward()` applies it only when
the whole folder, including staged changes, is clean and the update is a
fast-forward. Ignored and untracked files are left alone; an incoming path
that would overwrite one is a `Collision`.

A fast-forward writes each blob's bytes as they are stored. An incoming commit
whose own `.gitattributes` declare a filter or a byte conversion (`filter`,
`text`, `eol`, `crlf`, `ident`, `working-tree-encoding`) for any file in its
tree is refused as `Unrepresentable` before a file, the index, or the branch
changes. That includes a commit that only adds the attribute over files it
does not touch, attributes in nested files, and attributes the folder's
current files would mask. This is refusal, not Git LFS support: pointer-shaped
text with no declared filter is ordinary bytes. The desktop owner and the
directory entry ask `git check-attr --source`; the browser evaluates the
commit's attribute files the same way, matching patterns as a case-insensitive
checkout does.

A browser folder publishes an incoming update in steps, under its Git Web Lock
and then its files lock. Ordinary saves take only the files lock. They wait
while an incoming update publishes or recovers its working tree, index, and
branch, but not for fetching or preparing the incoming Git objects.

1. Admission. Every portable file must still have the hash the update
   captured, no new file may have appeared, and the index must be the bytes
   its clean check left; otherwise nothing is written and the update is
   `Refused` or `StagedChanges`. A path the update writes a file at that holds
   a directory the update does not empty is refused here as `NotAFile`, as is
   one holding a file no portable path names, such as `.DS_Store`. A folder
   with no index first gets a valid empty one. Both commits are pinned under `refs/epicenter/incoming/`, and
   the record `.git/epicenter-incoming.json` is written: an operation ID, the
   branch, the head it was admitted over, and the commit it publishes.
2. Only after the record's stream closed: removals (pruning only the
   directories they emptied; empty directories a person made stay), then the
   directories the update emptied where it writes files, then writes, then
   the index, then the branch, compared with the pinned head.
   So `a/b` can become a file `a`, and a file `a` a directory `a/b`.
3. Once everything reads back as the published commit, the record and pins
   are removed.

A step that fails reports the steps that landed (`Partial`), or `Unconfirmed`
when its outcome is unknown; either way the record stays. The desktop Rust
owner retains its equivalent record at `.git/epicenter/incoming.json` and
recovers explicitly from pinned commits under the same rules.

The Bun directory opener applies ordered file steps, updates the index, and
moves the branch last. A failure reports the
steps that completed, marks the saved-files observation stale, and requests
no commit. It does not retain an incoming recovery
record: its `pendingIncoming` is absent and `recoverIncoming()` returns
`none`. Durable incoming recovery is implemented for the browser and desktop
Rust owner.

### Interrupted incoming updates

A browser record that remains, because a step failed or the tab closed, is
pending. `git.snapshot.pendingIncoming` shows it, and nothing resumes it on
its own. File saves continue; `stage()` is `IncomingPending`, a commit is
`blocked`, and pulls and merges are `IncomingPending` until it is resolved.

| `pendingIncoming.state` | Meaning |
| --- | --- |
| `recorded` | `{ operationId, branch, expectedHead, nextHead }`: the update was admitted and may have changed files. |
| `unadmitted` | The record is empty: its admission never finished, so no authored file was changed by it. |
| `unreadable` | The record holds bytes that are not a record, including one an earlier version wrote for a merge left unfinished. It is never deleted automatically. |

`git.recoverIncoming()` resolves it explicitly:

| Result | When |
| --- | --- |
| `none` | Nothing was pending. |
| `admissionCleared` | The empty record was removed. Status is observed again. |
| `cleared` | The branch already names the published commit. The record is removed without writing files; status is observed again, not assumed clean. |
| `completed`, with `changedPaths` | The branch is at the admitted head. Each changed path is at its before or after state; those at their before state are written, then the index and the branch, and the record is removed. |
| `RecoveryRefused`, with `paths` | A path holds a third value (another file, an empty file where there was none, a file where a directory belongs, or a directory where the update writes a file that the update did not empty), or the index, the branch, or the record is not what the update left. A directory counts as emptied by the update only when it, and each directory in it, held a file the update removes. The paths are named, nothing is written, and the record stays. Restore them and recover again. |
| `Partial` or `Unconfirmed` | A recovery step failed or its outcome is unknown. The record stays. |

### Merging incoming changes

`mergeIncoming()` applies the already fetched remote head when histories
diverged. It pins the branch head and the fetched head, requires the same
clean folder as `pullFastForward()`, and refuses the same incoming commits. A
branch that is behind fast-forwards; a branch that is ahead or equal changes
nothing. It never fetches or pushes, and `pullFastForward()` still refuses
divergence.

Diverged histories normally need exactly one merge base; none or several is
`UnsupportedHistory`. `mergeIncoming({ allowUnrelatedHistories: true })`
explicitly combines histories with no common commit over an empty base. Both
heads remain parents of the merge commit. Several bases are refused either way. The merge writes one commit whose parents are the pinned
head and the pinned fetched commit, and publishes its files, a clean index,
and the branch the way a fast-forward does, with the same record.

- Root `kv.json` changed on both sides merges by key with `mergeKv`, and is
  saved with sorted keys. A nested `kv.json` is an ordinary file.
- Every other path follows Git's rules through isomorphic-git's merge.
  Unchanged, identical, and one-sided changes keep their exact bytes.
- A file both sides changed merges by lines only when all its versions are
  UTF-8 with no NUL byte and no line break the line merge would drop: a lone
  carriage return, U+2028, or U+2029. isomorphic-git 1.38.5 would otherwise
  replace bytes, so such a file is a `binary` conflict.
- A `merge` attribute other than Git's default on such a file is
  `Unmergeable`, as is a link, executable, or submodule among its versions.

Competing changes are `Conflicted`, with one entry per reason: `kvKey` with
the raw base, ours, and theirs values of the key; `kvFile` when one side
deleted `kv.json` and the other changed it; `kvInvalid`; `content` for
competing lines; `binary`; `deleted` for a delete against a change; and
`shape` for a file against a directory. A conflict or refusal writes no
file, index entry, or ref; unreachable objects may remain. A conflict is
never left in the files: [Sync](#sync) is how a person settles one. With
`versions: true`, `Conflicted.versions` carries the exact committed bytes of
both sides at each conflicted file path, with `null` for an absent file. Shape
conflicts have no file versions. The native snapshot records conflict reasons
without broadcasting these bytes to other windows.

Browser folders, Bun directory folders, and the desktop app's Rust owner all
merge under these rules. The desktop owner merges a file both sides changed
with `git merge-file` and root `kv.json` with `kv_merge`, the Rust
counterpart of `mergeKv`.

A merge another Git program began in the repository (`.git/MERGE_HEAD`), or
unmerged index stages it left, blocks whole-folder commits, staged commits,
pulls, and merges, writing nothing, until it is finished or abandoned with
Git. The folder never begins or finishes such a merge.

A whole-folder commit or fast-forward on disk writes every file as plain
`100644` bytes, so it is refused in a repository it would misrepresent:
symbolic links, executables, submodules, nested `.git` data, `core.autocrlf`,
or a normalizing attribute on a source file. Reads and file saves still work.

## Declaring a folder

`defineFolder` checks the definition where it is written. `defineTable` and
`field` are the vocabulary every Epicenter storage shares
(`@epicenter/definition`). A field is any native TypeBox schema; the `field.*`
helpers build common ones. A folder refuses a table that declares a body
conversion, because a row's body is the file's Markdown text. An opener given
such a definition returns `InvalidDefinition` before it acquires anything.

`epicenter.json` holds each table, and `kv`, as one JSON Schema object whose
properties are the fields. A field's references must mean the same there as
in the field alone, so a folder also refuses two fields of one table that
define the same `$id`, such as two recursive types both named `Node`, and a
`#` reference outside any `$id`, which the file would resolve against the
table. Rename one definition, or give the field an `$id`. Definitions are not
renamed when they are published, so the file holds exactly the fields a
reader prepares.

A definition is `{ title?, kv, tables }` and nothing else. `defineFolder`
throws on an `id`; an opener given an untyped definition with one returns
`InvalidDefinition`. Its type is `FolderDefinition`, the identity-free
`DataSchema` of `@epicenter/definition`, prepared with `prepareSchema`. A store
definition keeps its required `id` and its own `prepareData`.

`defineFolder` returns the prepared definition. It has the shape and type of
what was declared: `kv` and each table's `fields` are records of native
schemas, and a table's key is its name. Each table's type also carries the
`PreparedFolderTable` mark that `parseRow` and `formatRow` require; the
mark is a type, not a property. Each schema is an owned, frozen snapshot, so
editing a schema after `defineFolder` changes nothing an opened folder
accepts. An opener handed any other declaration prepares it first and reads
the snapshot.

A field's editor hint decides nothing about what a folder stores.
`field.reference('lists')` is a nonempty string whose hint names a table. The
folder does not check that the table or the row exists, and renaming or
deleting a row rewrites nothing that names it, so a stored identifier may
dangle.

## Layout

| Path | What it is |
| --- | --- |
| `src/contract.ts` | Everything an application names besides the opener. Every entry exports it unchanged. Loads no storage, Git implementation, or runtime module. |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts` | The entries. |
| `src/browser-adapter.ts`, `tauri-adapter.ts` | The adapters the automatic entry loads lazily. The browser adapter also decides which OPFS directory is the folder and downloads an account folder before its first opening. |
| `src/folder.ts`, `table.ts`, `kv.ts`, `markdown.ts` | The handle and its interpretation of files, shared by every adapter. |
| `src/row-text.ts`, `canonical.ts` | `parseRow` and `formatRow`, and the row codec under them: the one parser and the one writer of row text. |
| `src/autosave.ts` | One editing session's snapshot saves, shared by `table.autosave` and `files.autosave`. |
| `src/svelte/` | Svelte boundary tests and the sync review's mounted tests. |
| `src/reading.ts` | KV's reading diagnostics: `ParseError`, `FieldIssue`, `DeepReadonly`, and the ownership every checked value has: parsed values frozen and supplied values copied before a field sees them. |
| `src/opfs-store.ts`, `git/opfs-git.ts`, `git/browser-backend.ts` | OPFS storage, private `.git`, and isomorphic-git. |
| `src/native-store.ts`, `git/native-*.ts` | The directory entry's files and `git` program. "Native" here means an ordinary directory in Bun, not the desktop shell. |
| `src/native-exchange.ts`, `addon/exchange.c`, `packages/folder/scripts/build-addon.ts` | The directory entry's atomic exchange for replacements: the Node-API addon, its loader and errno mapping, and the script that builds it. |
| `src/native/bindings.gen.ts` | Commands and events generated from the `tauri-plugin-epicenter-folder` crate. Internal. Do not edit. |
| `evidence/` | Tests that build real bundles and read real import closures; `evidence/opfs`, a page that runs the browser checks in a real browser. |

## Commands

```sh
bun run test              # build the addon, then native/core and mounted Svelte tests
bun run build:addon       # compile the Bun directory's exchange addon
bun run test:svelte       # only the mounted Svelte tests; they need --conditions=browser
bun run typecheck         # svelte-check: TypeScript and the .svelte test fixtures

EPICENTER_FOLDER_BRIDGE=1 bun test --isolate src/tauri-native.test.ts   # against the Rust owner
bun evidence/bundles/inspect.ts main tauri   # print the chunks a build emits
bun evidence/opfs/serve.ts   # the OPFS page on 127.0.0.1:5181; --build only compiles it
```

The browser suites run on an in-memory OPFS stand-in
(`src/opfs.test-support.ts`). They show the folder's protocol, not that a
browser's OPFS behaves like the stand-in; the evidence page checks that.
Application tests import `src/browser-storage.test-support.ts` by path:
`createTestStorage()` owns one fresh stand-in tree, `browserStorage(storage)`
opens it, and `testBrowserStorage()` does both in one call.

## Limits

A reference field has no integrity: nothing checks its target, and rename
repairs no references. `kv.set`
writes each value it sets as compact JSON. Browser bytes are stored whole.
A whole-folder checkpoint or status scan reads and hashes the whole folder.
Version checks on disk are best effort
against other programs. File bytes cross the desktop bridge as JSON number
arrays, which is slow for large audio.

In a browser, OPFS quota exhaustion and eviction surface as the failing
step's `Io` or `Unconfirmed`; nothing reserves space. Nothing abandons a
pending incoming update: a record recovery refuses stays until the named
paths are restored. Pages of other origins or browser profiles are outside
what the Web Locks can see.


## Internal composition

Files, tables, KV, and the terminal use one storage API. Its `apply`
accounts for content changes, so a domain method cannot accidentally choose a
write that skips history or change hints.

```ts
createFiles({ storage })
createTable({ storage, onFilesChanged }, name, definition.tables[name].fields)
createKv({ storage }, definition.kv)
createTerminal({ storage, git }, options)
```

Browser and Bun openers wrap raw storage with publication accounting. The
Tauri owner already performs that accounting. Assembly fences the resulting
storage with the handle's close signal. These wrappers retain no file-operation
collection.

Git keeps raw storage because incoming fast-forwards update files and history
under their own policy. They must not trigger an automatic commit as a new
local save. Saves are not ordered by when their methods were called: the last
to land on a path wins. Terminal writes apply separately; a
recursive removal or directory move applies its captured file steps together.
