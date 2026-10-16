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
  const edited = { ...created.row, fields: { ...created.row.fields, done: true } };
  const { data: saved, error: saveError } = await folder.tables.todos.save(created, edited);
  if (saveError !== null) show(saveError.message);     // deleted, invalid, or kept changing
  else if (saved.replaced.length > 0) say(saved.replaced); // another writer's change it replaced
}
await folder.close();                                  // closed either way
```

Declared tables are available as `folder.tables.<name>` without creating their
directories. Listing a missing table directory returns an empty list. Creating
the first row creates its parent directory if needed; apps do not need to call
`files.mkdir` to prepare a table.

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

A folder ID names a dataset. In a browser, `so.epicenter.todos` names the
directory `so.epicenter.todos/` at the root of the app's origin private file
system. On the desktop the shell maps it to a directory it registered.
Reverse-DNS names provide a shared convention for compatible tools. A name such
as `so.epicenter.todos.work` denotes another dataset in a literal sibling
directory; dots do not create nested directories or inherited permissions.

A definition describes how this tool reads and edits the folder's files. It
names no folder: `defineFolder` refuses an `id`, at the type and when it runs.
Different tools can use different definitions to interpret the same files.
Compatible field meanings still matter when those tools write to the same
dataset.

Opening writes nothing. A handle publishes root `epicenter.json`, with
`formatDeclaration(definition)`, just before its first write, through every
opener (ADR-0508). Each
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

Publication reads `epicenter.json` and, when its bytes differ from the
declaration, writes it once per handle, before that handle's first save: a
missing file is created, and a present one is saved over as read with
`{ merge: false }`, so `epicenter.json` is never line-merged. Another
writer getting there first is read once more (ADR-0551). It never commits or pushes, so the published
`epicenter.json` is recorded with the next version. A folder opened only to
read, or to take a remote's history, is never written by opening.

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

A browser folder's address is its ID alone ([ADR-0532](../../docs/adr/0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)):
each browser app is its own origin, so its storage already belongs to it.
Signing in does not move data or retarget writes. A desktop shell registers the
selected directory; the Bun opener receives an explicit directory and no
folder ID.

## Entries

| Import | Opens | Use it when |
| --- | --- | --- |
| `@epicenter/folder` | The desktop app's folder when the page runs in Tauri, this browser's storage otherwise. Decided when `openFolder` is called, and only the chosen adapter is loaded. | Ordinary application code. |
| `@epicenter/folder/browser` | This browser's origin private file system (OPFS) only. Refuses inside the desktop app. | A web-only build, or a test that injects an OPFS stand-in with `browser.opfs`. |
| `@epicenter/folder/tauri` | The desktop shell's folder only: this package's own engine over a directory the shell grants ([below](#a-directory-the-desktop-shell-grants)). Refuses outside the shell. | A desktop-only build. |
| `@epicenter/folder/bun` | An existing directory, in Bun. | Command-line tools, recovery scripts, and tests that are given a directory. |
| `@epicenter/folder/query` | Nothing: TanStack Query option factories and the text draft over a folder already open ([Queries](#queries)). | A page that reads a folder through TanStack Query. |
| `@epicenter/folder/svelte` | Nothing: `createTextDraftState` and `createBodyDraftState`, a document's draft a Svelte component reads reactively, with its save loop ([Editing a row](#editing-a-row)). Loads `svelte/reactivity`, an optional peer. | A Svelte editor of a note body or a file's text. |

The first three export the same `openFolder` and `openDataFolder` signatures
and the same contract, so one application source builds against any of them.
Importing an entry opens nothing. On a server, opening returns a refusal.

```ts
openFolder({
  id,        // required: which folder, such as 'so.epicenter.todos'. Never a path.
  definition,
  credentials, // optional: (url, signal) => Promise<{ username, password } | undefined>
  browser,   // optional: { author, httpFetch, opfs }
}): Promise<Result<Folder, OpenFolderError>>
```

`credentials` is asked right before each push and fetch with the exact URL
Git is about to reach, and its answer goes to that URL alone as an HTTP Basic
`Authorization` header (a token is the password). `undefined` sends none; a
throw refuses the transfer with its message. The folder keeps nothing it is
given: not in `origin`, its files, or its Git configuration. In the browser
the header rides isomorphic-git's request with no cookies and no redirects. In
Bun and on the desktop it reaches `git` through Git's environment, never its
arguments: `http.<url>.extraHeader`, `http.followRedirects` and
`http.<url>.followRedirects` false, so no repository or global setting turns
redirects back on, and no credential helper. Neither host sends it to a URL
that is not `https`, and the desktop shell passes it only for a push or fetch
to the folder's own `https` origin. Without one, `git`
uses the person's own credential helper or SSH key.

`browser` applies to a browser folder only. A browser folder uses a local
author by default. Saves never commit (ADR-0529). `httpFetch` supplies a
fetch-compatible HTTP function for Git fetch and push, for tests and unusual
transports. It defaults to regular fetch, receives the remote URL Git
configuration names and the operation's abort signal, and does not replace
global fetch or change the remote.
In the desktop app the shell chooses the directory; the page reads the author
and remote from the repository, with the shell's author as the fallback. The
policy in effect is on `folder.git.snapshot`.

### An existing folder, with its own declaration

`openFolder` is for an application's own data: its schema ships in the
application's code, and the handle publishes it to `epicenter.json` before
its first write (only when the bytes differ). A folder whose schema belongs to
the folder, such as a vault that generates `epicenter.json` from
`epicenter.ts` or a working copy of someone else's repository, opens with
`openDataFolder` instead (ADR-0535):

```ts
openDataFolder({
  id,          // a folder the desktop shell registered, or a browser folder's ID
  credentials, // optional, as for openFolder
  browser,     // optional, as for openFolder
  lens,        // optional: the shape this caller reads; see below
}): Promise<Result<Folder<typeof lens, FolderDefinition>, OpenFolderError>>
```

| | `openFolder` | `openDataFolder` |
| --- | --- | --- |
| Schema | the caller's `definition` | the folder's `epicenter.json`, read and prepared as `readFolder` does when the folder opens |
| `epicenter.json` | published before the first write, if its bytes differ | never written |
| No `epicenter.json` | published on the first write | no tables and no settings; files, history, and Sync work |
| An unusable `epicenter.json` | replaced on the first write | `InvalidDeclaration`, and nothing opens |
| Repository on disk | created when the folder opens | created by the first commit (Save version, or Sync's checkpoint), staging, or `sync.connect`; until then status is an empty history with every file uncommitted |
| Tables | typed by the definition | keyed by any name, rows checked at run time; with a `lens`, the lens's tables, typed by it ([below](#opening-another-apps-folder-through-a-lens)) |

Both return the same handle, and `folder.definition` is the prepared
definition it reads with, so a view can render a folder it did not declare.
History and Sync use it too: Sync merges a data folder's rows by the folder's
own declaration. The definition is read once, when the folder opens; a
declaration that changes afterward, such as one a Sync brought, is read by the
next open.

On the desktop, `id` names a folder the shell registered, until the shell
issues grants for folders a person picks. In a browser, `openDataFolder`
opens the origin-private folder named `id`; as with `openFolder`, a folder
nobody wrote to has no files, its first write creates its directory, and its
first commit creates its repository.

### Opening another app's folder through a lens

An app that reads a folder it did not create passes the shape it reads as
`lens`, a `defineFolder` definition of only the tables and fields it knows
(ADR-0538). The folder opens when its own declaration contains that shape,
and its tables and settings are typed by the lens:

```ts
const board = defineFolder({
  kv: {},
  tables: {
    todos: defineTable({ fields: { title: field.string(), status: field.select(['todo', 'done']) } }),
  },
});

const { data: folder, error } = await openDataFolder({ id: 'so.epicenter.todos', lens: board });
if (error?.name === 'ShapeMismatch') return show(error.problems); // every problem, listed
const { data: stored } = await folder.tables.todos.get('milk');
stored.row.fields.status = 'done';                  // fields the lens does not name stay on the row
await folder.tables.todos.save(stored, stored.row);
```

The folder contains the lens when, for every table of the lens, it declares a
table of that name, and for every field the lens reads, in a table or in `kv`,
it declares that field with a schema whose every value the lens's field
accepts (`schemaContainment` in `@epicenter/definition`). A lens `string`
accepts a folder `string`, a select of strings, or a date; a lens `number`
accepts an `integer`; a nullable lens field accepts a field that is never
`null`; a lens select accepts a select of some of its options. A field the
lens requires must be required by the folder; an optional one may be either.
A closed folder table (`additionalProperties: false`) contains a lens that
reads some of its fields; a closed lens table needs a closed folder table with
no other field. The check is conservative: a pair it cannot decide is a
problem with the reason, and the app widens its lens. A folder without
`epicenter.json` contains only a lens with no tables and no settings.

| | Through a lens |
| --- | --- |
| A folder that does not contain the lens | `ShapeMismatch` with `problems`: `missingTable`, `missingField`, `incompatibleField`, or `incompatibleTable`, each with its table, field, and reason. Nothing opens. |
| `tables` | the lens's tables alone, typed by it; the folder's other tables are not on the handle |
| A row read | every field the file holds, the ones the lens does not name included, so a `save` of the row read keeps them |
| A write | checked against the folder's own declaration, every field of it, a merged row included: the lens cannot save a value the folder refuses |
| `create` | `canCreate` is false, and `create` is `CannotCreate` naming the fields, when the folder requires a field the lens does not declare; rows can still be edited |
| `definition` | the folder's own prepared declaration, as without a lens |
| `epicenter.json` | never written |

Fields the lens does not name are kept only on the row the lens read. A row
built from scratch and passed to `save` drops them, and the folder refuses
it when one of them is required.

### The folder, opened lazily, and its remote

Opening a browser folder writes nothing. The folder's first write creates its
directory, and publishes `epicenter.json` just before it; each table's
directory appears with its first row. Its repository comes with its first
commit, staging, or remote, as on every host (see
[Repository creation](#repository-creation)). Reads never write: a folder
nobody wrote to lists nothing, has no history, and a commit of it writes
nothing. An ID that cannot name one directory (empty, `.` or `..`,
or with a slash, backslash, or control character) is `InvalidId`. A directory
someone else wrote under the ID is that folder.

A folder's remote is `remote.origin.url` in its Git configuration, on the
folder's own branch, `main`. `folder.git.snapshot.remote` shows it, and every
transfer reads the configuration again, so a remote another tab or program
set is used. `folder.sync.connect(url)` sets it, then syncs:

```ts
const { data, error } = await folder.sync.connect('https://github.com/you/todos.git');
if (error?.name === 'Unrelated') {
  // The remote has a history of its own. Ask, then combine both:
  await folder.sync.connect(url, { allowUnrelatedHistories: true });
}
```

| Folder | Remote | Connect |
| --- | --- | --- |
| files, no history | no branch | commits and pushes |
| empty | history | takes it |
| files, no history | history | merges them over an empty base; a differing path is a choice in the review |
| its own history | related | syncs |
| its own history | unrelated | `Unrelated`, writing nothing, until `allowUnrelatedHistories` |

The remote stays set whatever the sync answers. A sync that stopped partway
keeps no record: the files it wrote are local files, and the next sync merges
them with identical remote files cleanly. On the desktop the shell lets a page
set the remote only to a network URL.

### Repository creation

Opening a folder never creates its repository, on any host or opener. The
first commit (`git.commit`, Save version, or Sync's checkpoint), the first
staging (`git.stage`), or setting a remote (`sync.connect`) creates it. Until
then the folder reads as an empty history with every file uncommitted, and on
the desktop no `git` runs, since the shell runs only `git init` where there
is no repository. A directory inside another repository's working tree never
gets a repository of its own: its first commit is `blocked`, naming that
repository (ADR-0517).

A desktop page whose folder cannot be opened (no plugin, no permission, an
unregistered ID, a window the folder does not belong to, a folder another
process holds) gets that refusal. It is never given browser storage instead.

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
`create`, `save`, `remove`, and `move` are checked and published without
interleaving across tabs. Reads take no lock. New bytes publish when a file's
stream closes, so a reader sees the old bytes or the new ones; a new file is
visible, empty, from its creation until its stream closes.

| What happened | Outcome |
| --- | --- |
| A step failed before its stream closed | `Io`. A file the step created is removed again; when its absence cannot be established, `Unconfirmed`. |
| A stream's close threw | `Unconfirmed`, whatever the path holds afterward: matching bytes do not prove which write put them there. The path is posted to other pages and the history observation turns stale. |
| A move landed its destination and could not remove its source | `SourceNotRemoved`. The destination is posted to other pages. |

Saves are ordered by the lock alone, not by when their methods were called.
A save that hashes or waits longer can land after one asked for later, from
the same page or another. Every write after a create names the bytes it
started from, so none overwrites bytes its caller did not review: a save
merges with them, and `remove`, `move`, and a save with `{ merge: false }`
are refused as `Conflict`.

### A directory the desktop shell grants

A desktop shell registers each folder's directory for the windows that may
edit it, with the `tauri-plugin-epicenter-folder` crate. Opening it with
`@epicenter/folder/tauri` asks the shell to grant it (`grant_directory`): the
shell creates an application's directory if it is missing (a missing data
folder is `OpenFolderError.Missing`) and refuses a linked `.git`. A data
folder inside another repository's working tree never gets a repository of
its own there either: the `epicenter` CLI refuses the first commit as
`blocked`. The page then opens a directory
folder (`directory-adapter.ts`) and reads and changes that directory alone
through the shell's commands:

| | Browser folder | Granted desktop folder |
| --- | --- | --- |
| Files | OPFS | The real directory, through the shell's commands |
| History | isomorphic-git in a private OPFS `.git` | The system `git` in the real `.git`, run by the `epicenter` CLI, one child per operation (`tauri-history.ts`) |
| Identity | The directory its ID names | The shell's registration and lock |
| Remote and author | `remote.origin.url`, set by `sync.connect`, and `browser.author` | Git's own configuration: `remote.origin.url`, `user.name`, `user.email`, with the shell's author as fallback |
| Transfers | `httpFetch`, regular fetch by default, with `credentials` as a header | Git's own, in the CLI: `credentials` as a URL-scoped header, or the person's credential helper or SSH |
| Pages of one folder | Web Locks; each page tells the others the paths it wrote on a `BroadcastChannel` | Several windows may open one root; the shell checks each save where it lands, Git orders commits (ADR-0541), and the shell's watcher tells each window what changed |

Files go through the browser folder's file storage (`opfs-store.ts`) over a
directory handle (`directory-handle.ts`) built on seven calls: `readDir`,
`lstat`, `readFile`, `writeFile` with `createNew`, `rename`, `remove`, and
`mkdir`. `directory-tauri.ts` supplies them from the shell's commands and
`directory-node.ts` from `node:fs`. A write's bytes are staged under
`.git/epicenter/scratch` and renamed over the path, so another program sees
the old file or the new one, never an empty or partial one; opening clears
what a stopped write left there. Symbolic links and special entries are
listed and never followed. On the desktop the shell reads only beneath the
root and never through a link on the way, and makes every change and checks
its whole path: any data path the shared path rule accepts
(`paths.ts`, held to the plugin's `fixtures/path-rules.json` with its Rust
twin), no link on the way, and inside `.git` only the engine's staging and
private index copies. Each rename that publishes a file, and each removal,
names what it expects at its path: nothing, a file, a file with a given
SHA-256, or anything. The shell checks it and changes the path under one
lock per root, which every window's changes share, so a save that carries
what it read (a hash, or a create) and that another window landed after
this page checked is `Conflict`, or `Exists` for a create, never
`Unconfirmed`. An `overwrite` is last-writer-wins by contract: it replaces
whatever is there. In Bun, `directory-node.ts` makes the same check as a
separate step before the change, and `bun.ts` holds the folder's save lock
across both, the lock the shell takes around its own (below). A change whose
reply is lost may have happened: a
removal is done if the path is then gone and `Unconfirmed` if it is still
there, and a write is `Unconfirmed`. Objects
are stored with `git hash-object -w` through the host (`ObjectStore` in
`git/primitive-fs.ts`), in Bun as on the desktop, so no object file is
written by hand.

History is the native Git backend (`git/native-backend.ts`), which runs only
in Bun: in a script, and in the `epicenter` CLI, which runs a desktop page's
history ([ADR-0559](../../docs/adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)).
It reaches the machine through a host: a `git` runner and directory
primitives (`git/native-host.ts`). The runner finds `git` without starting
macOS's xcrun shim (`locateGit`: `/opt/homebrew/bin` and `/usr/local/bin`
first, `/usr/bin/git` only when `xcode-select -p` names an installed
developer directory, whose own `git` it runs), and throws `GitMissingError`
when there is none. Each `git` leads its own process group, so an abort ends
it with its helpers. It runs every command with no hook and no fsmonitor,
whatever the repository configures: `core.hooksPath` names
`.git/epicenter/no-hooks`, which must be a real, empty directory, and
`core.fsmonitor` is off. So the folder shares the repository with every
other Git program the way Git programs share one: index and ref changes go
through `git`, a branch moves only by `update-ref` from the commit it was
read at, and Git's configuration, packed refs, and garbage collection are
Git's. A commit that lands while another program holds `.git/index.lock`
moves the branch and reports that the index could not be refreshed; the next
Save version refreshes it. A repository that tracks an executable, a link,
or a submodule, or converts line endings, refuses a commit and names why.

A directory folder takes no Web Lock (ADR-0541). Each host supplies the
check it has instead:

| Host | Save | Commit | First commit, staging, or remote |
| --- | --- | --- | --- |
| Desktop page | The shell's checked rename | In the CLI, under the folder's history lock, then Git's lock files and the branch's compare-and-swap | `git init` in the CLI, run again if another opener raced it |
| Bun | Checked just before the rename, under the folder's save lock, which saves from this process, other Bun processes, and the desktop shell take in turn | Git's lock files and the branch's compare-and-swap | The same |
| Browser (OPFS) | The files Web Lock | The Git Web Lock, under which the branch is read, compared, and written | The open Web Lock |

Each handle orders its own index and branch work. Two windows or scripts on
one directory wait for each other only across one save's check and rename: a
save that another one overtook
where its host checks it merges with theirs and writes again
([Saving a row](#saving-a-row)), and a commit whose branch the other moved
retries ([History](#history)). How a page hears what changed is
[Changes](#changes). A page that reloads ends the work it was running,
the CLI children the shell started for it included.

### A desktop page's history runs in the CLI

A desktop page runs no Git
([ADR-0559](../../docs/adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)).
Its `folder.git` and `folder.sync` (`tauri-history.ts`) call the Epicenter
shell's fixed history commands, each of which runs one `epicenter` child over
the folder the window was granted and answers one reply line
(`history-wire.ts`):

| Folder call | Shell command | CLI |
| --- | --- | --- |
| `git.status()` | `status` | `epicenter status <root> --json` |
| `git.log(depth)` | `history` | `epicenter history <root> --depth <n> --json` |
| `git.commit()` | `save_version` | `epicenter save-version <root> [--message <text>] --json` |
| `sync.run()`, `sync.connect(url)` | `sync` | `epicenter sync <root> [--remote <url>] --json` |
| `sync.resolve(attempt, choices)` | `settle_sync` | `epicenter sync <root> --resolve - --json` |

The child runs the engine a Bun process runs (`runHistory` in `bun.ts`), so
the merge is the same TypeScript on every host (ADR-0551). A save version, a sync, and settling a sync hold the folder's
history lock, an exclusive SQLite transaction on
`.<name>.epicenter-history-lock` beside the folder (`holdingHistoryLock` in
`bun.ts`), so two windows' children, or a window's and a terminal's, take
turns; it is apart from the save lock, so a page's saves never wait on a
sync's network. Status and the log take no lock. A sync that needs choices
records its attempt as `.git/epicenter/sync-attempt.json`: its ID and the
commits it merged, nothing a caller supplied. `resolve` sends only the
attempt's ID and the choices; the child merges the recorded commits again,
which hold the same conflicts under the same IDs, and settles them. A later
sync retires the record, and so does a resolve past its choices. What a
sync wrote comes back in the reply (`landed`) and is reported once on
`onFilesChanged`; the shell's watcher reports the same files and the moved
history, which at most rereads them.

A desktop folder's `git` is `FolderGit`: status, the log, and `commit`. The
finer steps (`FolderGitSteps`) have no desktop command, so a desktop handle
does not have them; Sync is how it exchanges history. The page holds no
token: the CLI sends the deployment's Git its own, and `credentials` does not
apply on the desktop. A computer with no `git` answers
`GitError.GitMissing`, with how to get one (`install`); files still read and
save.

Status costs one child: on macOS arm64, with 200 files, a median of about
80 ms from spawn to exit (20 runs), of which about 20 ms is the binary's
start. The page holds what it last read (`folderOptions`, ADR-0553) and reads
again only when a change or its own write marks it stale, with at most one
read running and one waiting.
An incoming update that stops partway keeps no record here: the files it
wrote show as changes, and the next Sync records and merges them.

### Building for one environment

Alias the exact bare specifier. Do not rewrite subpaths.

```ts
// vite.config.ts
resolve: {
  alias: [{ find: /^@epicenter\/folder$/, replacement: '@epicenter/folder/tauri' }],
}
```

With `/tauri`, no browser storage and no isomorphic-git is emitted. With
`/browser`, no desktop adapter is emitted. Without an alias, both adapters are
emitted as separate chunks and neither loads until a folder is opened.
`evidence/bundles` builds these and reads the output.

### The directory entry

```ts
import { openFolder } from '@epicenter/folder/bun';

const opened = await openFolder({
  root: '/path/to/an/existing/directory',
  definition,
  git: { author: { name: 'Tool', email: 'tool@example.test' } },
});
```

```ts
import { openDataFolder } from '@epicenter/folder/bun';

const opened = await openDataFolder({
  root: '/Users/me/Code/vault',
  git: { author: { name: 'Tool', email: 'tool@example.test' } },
});
```

`openDataFolder` opens an existing directory with its own `epicenter.json`
([above](#an-existing-folder-with-its-own-declaration)), and takes a `lens`
as the other entries do. A script that edits a
data folder uses it; passing `parseDeclaration` of the file to `openFolder` is
safe only for a declaration `epicenter generate` wrote, since `openFolder`
publishes its own formatting on the first write. Opening creates nothing. A
directory inside another repository's working tree, where ADR-0517 records
the folder in the host's history, never gets a repository of its own: its
first commit is `blocked`, naming the host.

These openers take the directory and the history settings explicitly, and this
process reaches the disk itself, with `node:fs` and its own `git`. It opens
the same directory folder a desktop page does (`openDirectoryFolder`), so files
are replaced the same way: a staged copy under `.git/epicenter/scratch` is
renamed over the file. Saves to one directory take turns within the process,
across every handle it opens, and with other processes: each check and
rename holds the folder's save lock, an exclusive SQLite transaction on
`.<directory>.epicenter-save-lock` beside the directory, which the desktop
shell takes around its own checked renames
([ADR-0562](../../docs/adr/0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md)).
So two concurrent saves of one file, from one script, two scripts, or a
script and an open desktop window, cannot both pass the check; the second is
`Conflict` and merges as any overtaken save does. A save waits up to ten
seconds for another process's, then fails and changes nothing. The system
releases the lock when its process ends, however it ends; it is unreliable on
some network filesystems, and a directory with no parent, such as `/`, cannot
be saved to. Commits meet Git's lock files. Its `git` runs no hook and no
fsmonitor, as the desktop shell's does. It does not watch the directory, so `onFilesChanged`
hears only what this handle's own Sync wrote; a script that needs other
programs' changes watches with `fs.watch` itself.

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

It writes nothing: no Git repository, lock, or declaration. It can read a folder an application has open, or one
nested anywhere in another repository. Each file is read whole, but the
reading is not a snapshot across files: a save in progress elsewhere can show
in one table and not yet in another.

It checks files, not the root's Git layout. A folder whose `.git` is a
`gitdir:` file (a submodule) reads, though `openFolder` refuses it, so a
successful reading does not mean an application can open the folder.

### Checking, querying, and generating a data folder

`@epicenter/folder/bun` holds what the `epicenter` CLI's `check`, `query`,
and `generate` do (`packages/cli`); the CLI only prints it (ADR-0556).

```ts
import { checkFolder, generateDeclaration, queryFolder } from '@epicenter/folder/bun';

const { data: checked, error } = await checkFolder(dir); // readFolder's errors
checked.invalid; // files to fix, compiler-style findings
checked.unreadable; // files that could not be read
const { data: answer } = queryFolder(checked, 'SELECT stem FROM posts'); // { columns, rows, excluded }
await generateDeclaration(dir); // runs dir/epicenter.ts and writes epicenter.json
```

`checkFolder` sorts what `readFolder` reports: a row or `kv.json` that does
not conform, bytes that are not UTF-8, or a path the folder cannot hold is
`invalid`; anything else that could not be read is `unreadable`. `queryFolder`
projects only the rows that conform into an in-memory `bun:sqlite` database,
runs exactly one statement that reads, and names in `excluded` every file it
left out. `generateDeclaration` is the one reading that runs a folder's code:
it imports `epicenter.ts`, resolving `@epicenter/folder`, `@epicenter/definition`,
and `typebox` to this process's own modules, and writes the `epicenter.json`
its default export declares (ADR-0527).

## The handle

| Member | Contract |
| --- | --- |
| `tables.<name>` | Rows at `<name>/<stem>.md`, read through `parseRow` and written through `formatRow`. `canCreate` is false only for a table opened through a lens that cannot supply a field the folder requires. `get(stem)` returns a `StoredRow` (`path`, `sha256`, the exact `text`, and a complete, caller-owned `row`), `InvalidRow` for readable text that is not a valid row, or `undefined` only for absence. `list()` returns one `{ stem, result }` per row file. `create(row, { stem? })` is exclusive. `save(base, row, options?)` writes an edit over the version it started from, merging with another writer's newer file. `rename` and `delete` take a capture and are refused as `Conflict` when its bytes are gone. Each changes exactly one Markdown file. See [Reading a row](#reading-a-row), [Saving a row](#saving-a-row), and [Editing a row](#editing-a-row). |
| `kv` | Root `kv.json`, independent settings. `get()` returns `{ path, sha256, values, issues }`: every declared value that validated, with each broken one reported at its line, or `InvalidKv` for text that is not one strict JSON object. `set(key, value)` changes one key of the file as read at the set, keeps every other key's raw text, creates a missing file, removes a key set to `undefined`, and saves with the one save loop, merging by key with another writer's save. See [Reading and saving kv.json](#reading-and-saving-kvjson). |
| `files` | Ordinary files at literal paths. See below. |
| `git` | `FolderGit` on every host: a status snapshot, `subscribe()`, `status()`, `commit()`, and `log()`. A browser or Bun handle's is `FolderGitSteps`, which adds `commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, `mergeIncoming()`, `paths()`, `stage()`, `commitStaged(message)`, and `diff()`; the browser entry's openers are `OpenFolder<FolderGitSteps>` and `OpenDataFolder<FolderGitSteps>`. |
| `sync` | `run()` commits saved files, fetches, merges, and pushes; competing settings, row fields, row bodies, and whole row files come back as a `SyncAttempt` that `resolve(attempt, choices)` settles. See [Sync](#sync). |
| `definition` | The prepared definition the handle reads with: `openFolder`'s `definition`, or the folder's own `epicenter.json` as `openDataFolder` read it when it opened. Its tables are `tables`, its settings `kv`, and Sync merges rows by it. |
| `location` | `{ kind: 'opfs', directory }` or `{ kind: 'directory', root }`. For showing to a person. File paths are never joined onto it. |
| `onFilesChanged(listener)` | Files may have changed: `listener(change)` with the paths, or `'everything'`, so read again. Never this handle's own saves. Returns the function that stops listening. See [Changes](#changes). |
| `signal`, `close()` | Closing fences the next storage call and stops network work. Git work drains before storage is released; file operations own their completion promises. It makes no commit. |

### Files

```ts
const { data: take, error: createError } = await folder.files.create('audio/take.webm', bytes);
if (createError !== null) return show(createError.message);         // refused if anything is there
const { data: file, error: readError } = await folder.files.read('notes/a.md');
if (readError !== null) return show(readError.message);             // file is { path, sha256, bytes }
const { data: saved, error: saveError } = await folder.files.save(file, 'new text');
if (saveError !== null) return show(saveError.message);             // deleted, or kept changing
if (saved.replaced.length > 0) say(saved.replaced);                 // another writer's lines it replaced
const { data: moved, error: moveError } = await folder.files.move(saved.stored, 'notes/b.md');
if (moveError !== null) return show(moveError.message);             // refused if either end changed
const { error: removeError } = await folder.files.remove(moved);
if (removeError !== null) return show(removeError.message);         // refused if it changed since
```

The verb states the condition. `save`, `remove`, and `move` act on a
**capture**: a plain, frozen `{ path, sha256 }`. The hash identifies the exact
bytes captured; byte length remains inventory metadata. A capture holds nothing
open, can be serialized, and never changes. A successful write returns a new
capture; the one passed in stays what it was. A stored row and an
`InvalidRow` are captures of their row file, a KV snapshot is a capture of
`kv.json`, and so is a `read` result.

A save's base must also carry the content it names (ADR-0551): `read`,
`create`, and `save` return the bytes with the capture, a `StoredRow` and an
`InvalidRow` carry the text, and `{ path, sha256, text }` that crossed JSON
works too. A base without content, or whose content no longer hashes to its
`sha256` (bytes edited in place, say), is `UnknownBase`, and nothing is
written. An editor keeps its base and its edited text apart.

- Strings are saved as UTF-8 with nothing added or normalized. Byte arrays are
  copied when the method is called, so reusing the array afterward changes
  nothing.
- A save's capture is computed from the bytes it wrote. Nothing is read back.
  If another writer lands right behind the save, the capture still names what
  this save wrote, and the next save from it merges with their change. Read
  the file to observe what is there now.
- A moved file's capture is the captured hash at the new path. It is a
  receipt conditioned on that baseline, never a read of the destination:
  another program may write there afterward, and a directory's source check
  is best effort against outside programs. Read the file to know what it
  holds now.
- `create` reports `Exists` for an occupied path even when the bytes are identical.
- A stale capture is a `Conflict` for `remove` and `move`. A save merges
  instead (see [One save](#one-save)), unless it is given `{ merge: false }`.

Internally, the same intention reaches each backend as `create`, `replace`,
`overwrite`, `remove`, or `move`. `replace`, `remove`, and `move` carry an
optional `expectedSha256`; `files` and tables always send one, and only
`create` publishes unconditionally. No folder verb sends an `overwrite`, which
stays in the boundary for tests that play another writer. Without the guard,
each still requires a file at its path or source: a `replace` never creates a
file and is never sent as an `overwrite`, and a move's destination must be
empty. Browser OPFS, the Bun directory, and a desktop page's directory enforce
this where they publish. There is no sentinel union mixing hashes with
`'absent'` or `'any'`.

A directory folder, in Bun or a desktop page, checks that a `replace`'s file
is there, or holds the expected bytes, where it renames a staged copy over
it. On the desktop the shell makes that check and the rename under one lock
per root and the folder's save lock, and in Bun under the save lock, so no
other window's or Bun process's change lands between them. A file another
program removes between the check and the rename comes back with the new
bytes; it shows as an ordinary file and can be removed again (ADR-0533).
A directory folder reads names literally: on a case-insensitive file system,
`plan.md` does not reach `Plan.md`, and creating or moving to `plan.md`
there is `Exists`. Browser folders are unaffected. OPFS opens the file without creating it
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
malformed YAML, a value with no exact JSON form, a declared field that is
missing or does not conform, or, in a closed table, a key the table does not
declare. It carries the exact text, the hash of its
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
when a view opens and when `onFilesChanged` says the file may have changed
([Changes](#changes)). With TanStack Query, `@epicenter/folder/query` wires
both ([Queries](#queries)).

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

### Rows as SQL

`projectTables(db, tables)` builds the projection `epicenter query` reads
(ADR-0520) in any `SqlTarget` (`run` and `transaction`; `queryFolder` in
`@epicenter/folder/bun` adapts a `bun:sqlite` database in six lines), so Bun
and a browser's SQLite build the same tables. Each table has `stem`, one quoted column per declared
field, and `body`; a list or object is JSON text and a boolean is `0` or `1`.
Pass only rows that conform and name the files you left out. The database is
read-only afterwards. `projectionProblem` names a table that cannot be one
SQLite table, `readingStatementProblem` refuses a statement that does not
start with `SELECT`, `WITH`, `VALUES`, or `EXPLAIN`, and `describeTables`
says what each column holds. Preparing the statement, and refusing anything
after the first one, stays with the engine.

### Names

A stored row's `path` is `rowPath(table.name, stem)`, and
`rowStemOf(table.name, path)` is the inverse; it returns `undefined` for a
path that is not a row of that table, including `a.MD`, which is an ordinary
file.

A stem is one literal filename segment. Nothing trims it, folds its case,
normalizes its Unicode, or strips an extension. `'bad '`, `'.hidden'`, and
the empty stem (`todos/.md`) are addresses like any other, and a name is
never a diagnostic. An empty stem is an address, so compare a stem with
`undefined` explicitly rather than by truthiness.

A stem whose row path the folder's path rule (`pathProblem` in `paths.ts`)
refuses is `InvalidPath`: a path separator, so no stem can address a nested
path such as `todos/a/b.md`; a backslash or a control character (C0, DEL, or
C1); or a file name that could name another file on some disk. That last
group is a trailing dot or space in a directory name, a reserved character (`< > : " | ? *`, so `'a: b'`), a default
ignorable code point, a Windows device name (`con`, `com1 .txt`: the part
before the first dot, without trailing spaces), a Windows 8.3 short name
(`NOTES~1`, `PROGRA~1.TXT`; `Notes ~2` is ordinary), and `HEAD` or `.git` in
any case. The desktop shell applies the same rule, and both are held to
`fixtures/path-rules.json` in `tauri-plugin-epicenter-folder`. Whether two
spellings are one file is the backing storage's answer. Browser storage keeps names exactly, so `Plan` and
`plan` are two rows. A directory on a filesystem that holds one file for both
refuses the second with `Exists`. Incoming history has its own rule and may
refuse paths a filesystem could not hold apart; see Incoming changes.

### Saving a row

`create` is the one unconditional write. Every other write names the version
it started from with a capture, `{ path, sha256 }`: a `StoredRow`, an
`InvalidRow`, or a listed row passes as it is.

```ts
const created = await todos.create({ fields, body: '' }, { stem: 'milk' }); // Exists if taken
const saved = await todos.save(stored, edited); // { stored, merged, replaced }
const updated = await todos.update('milk', { set: { done: true } }); // over the row as it is now
const moved = await todos.rename(stored, 'groceries'); // the capture at the new path
await todos.delete(stored);
```

`save(base, row, options?)` is the one way an app, a script, or an agent
writes an edit of a row: one save over the row's kind (see
[One save](#one-save)). A field only one side changed keeps that side's value;
body lines only one side changed keep that side's lines, and edits to
neighboring lines both stay. Where both changed one field, or the same body
lines, the edit wins, and `replaced` names what of theirs it replaced. A
merged row is written in the standard form.

The merge base is the row the base's text holds, never its `row`, which is the
caller's to edit. A base whose text is not a row, such as an `InvalidRow`
being repaired, merges by line.

A save fails, writing nothing, only when its base carries no content
(`UnknownBase`), the row does not conform or cannot be written
(`InvalidValues`), the file was deleted (`NotFound`: a save never recreates a
row), another writer left text that is not a row and does not merge into one
(`InvalidRow`), or the file kept changing (`KeptChanging`). With
`{ merge: false }`, a file another writer changed is `Conflict` instead.

`rename` and `delete` are refused as `Conflict` when the file no longer holds
the captured bytes, and nothing retries. A rename to the stem it already has
is `InvalidPath`; a rename onto an occupied stem is `Exists`. A move that
landed its destination but could not remove its source is
`MoveError.SourceNotRemoved`; its `moved` capture names the destination, so
the application can continue from there and remove the leftover source under
its own guard.

A host that loses a reply reports `Unconfirmed`: the change may or may not
have landed. Present it as uncertainty, never as a definite failure.

### Editing a row

The folder keeps no draft and no save queue (ADR-0554). A person editing a
field means "the title is Milk", not "here is the row as I last saw it", so
a field edit is an update of the file as it is now:

```ts
await todos.update('milk', { set: { title: 'Oat milk' }, unset: ['due'] });
```

`update(stem, { set, unset })` reads the row, puts `set` over its fields,
removes each field in `unset`, and saves that over what it read with the
body unchanged and no merge. When another writer saved in between, the save
is `Conflict`, and the update tries again from their row, up to
`WRITE_ATTEMPTS` times, then answers `KeptChanging`. So every field it did
not name keeps their value, and a field it set wins; `replaced` is always
empty. `unset` takes only optional fields, since `null` may be a field's
real value. An update of a missing row is `NotFound`; a value a field does
not admit is `InvalidValues`. A relative change (`count + 1`) is not an
update: a script reads the row and `save`s it.

A component holds what a person typed in its own state until it is sent,
and sends it through the `update` mutation of `folderOptions` after a pause
and when the person leaves the field (see [Queries](#queries)). A checkbox
or a select sends its update at once.

A document cannot be a field change: a note body, a transcript, or a file's
text is a whole text, and setting it would replace another writer's lines.
Its edit holds its own starting version: `createTextDraft()` in
`@epicenter/folder/query` captures the version at the first change, keeps
the typed text outside any cache, and saves with that version as the base,
so the save merges by line with whatever changed since.

```ts
const draft = createTextDraft();
draft.change(openedFile, 'one\ntwo\n'); // base captured here, once
const sent = draft.toSave();              // { base, content, revision }
// after files.save(sent.base, sent.content) lands as `saved`:
await draft.saved(sent, writtenFile(saved)); // done, or later typing continues from it
```

When the save merged another writer's lines, text typed while it ran is
merged onto the written text, so the next save does not undo them. A row's
body drafts the same way over a `StoredRow`, saved with `table.save` and
read back with `writtenBody`.

A Svelte component holds one with `createTextDraftState({ save, definition? })`
or `createBodyDraftState({ save })` from `@epicenter/folder/svelte`: the same
draft, read reactively, and a `save()` that runs one save at a time and
sends text typed meanwhile from the version the last save wrote. A failed
save keeps the draft; the error is the save mutation's. `onSaved(saved,
restore)` hears each save that landed: `restore` is one more save of what
`restoreTheirs(saved)` builds through the same `save`, for a notice's
"Restore theirs", and its result is heard the same way. Restoring a file at
a row path or `kv.json` needs the folder's `definition`.

```svelte
<script lang="ts">
  const save = createMutation(() => folder$.notes.save.mutationOptions());
  const body = createBodyDraftState<Note>({
    save: ({ base, content }) =>
      save.mutateAsync({ base, row: { fields: base.row.fields, body: content } }),
    onSaved: ({ replaced }, restore) => toastReplaced({ replaced, restore }),
  });
  const note = createQuery(() => folder$.notes.get.queryOptions(stem));
  const send = useDebounce(() => body.save(), 1000);
</script>
<textarea
  value={body.text ?? note.data?.row.body}
  oninput={(e) => { body.change(note.data!, e.currentTarget.value); void send(); }}
  onblur={() => void send.runScheduledNow()}
></textarea>
```

A row that is not valid is repaired as text: `files.save(invalidRow, text)`
saves over the `InvalidRow` the read returned, which carries its text.

### One save

Every write to an existing file is one save loop, `saveFile` (ADR-0551):
`table.save`, `kv.set`, and `files.save` are thin calls over it.

1. The base's content must hash to its `sha256`; otherwise `UnknownBase`.
   The save swaps on that hash.
2. On `Conflict` it reads the current file. A missing file is `NotFound`: a
   save never recreates a deleted file.
3. It merges the base and the edit with the current file by the file's kind,
   and settles every unit both changed with the edit's side.
4. The result must read as its kind whenever the edit does; then it swaps on
   the current hash. That repeats at most `WRITE_ATTEMPTS` times, then
   `KeptChanging`. A reply lost as `Unconfirmed` is read back once: our bytes
   mean done.

Every round merges from the edit's own base, so `replaced` names what the
last round replaced. `{ merge: false }` stops at the first swap and answers
`Conflict`: for a write that must land only over what it read, such as
filling a body only while it is empty.

| Kind | Merges by | A competing unit |
| --- | --- | --- |
| `kv.json` | key | one setting |
| a row of a declared table | field, and the body by line | one field; the body |
| other UTF-8 text | line | the file's text |
| binary, or a side absent | none | the whole file |

A row or `kv.json` version that does not read as its kind merges as text. A
saved JSON, YAML, or CSV file merges by line, so the result may not parse. Sync
merges with the same rules (see [Sync](#sync)).

`replaced` names each value with its content, so theirs can be put back when
their version exists nowhere else:

- `{ kind: 'field', field, kept, theirs }` and `{ kind: 'setting', key, kept, theirs }`
- `{ kind: 'text', part: 'body' | 'file', kept, theirs, regions }`: `theirs`
  is the same merge with theirs winning every competing span, so it keeps the
  edit's other lines, and each region names a span standing in `kept` from
  its 0-based line
- `{ kind: 'whole', theirs }`: their whole file, bytes included

`restoreTheirs(saved)` is the one save that puts theirs back, over the
version the save wrote: `{ base, row }` for a row save, `{ base, content }`
for a file save. A file saved at a row path or `kv.json` is restored by field
or key, which takes the folder's definition: `restoreTheirs(saved,
folder.definition)`. `ReplacedNotice` in `@epicenter/svelte` is the one view
of it.

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
- It reads the current file, changes the key in it, and saves over that read
  ([One save](#one-save)). Every other key keeps its raw text, so number
  spellings and unknown keys survive. The text is written in the merge format
  below, so a local save and a Git merge produce the same file.
- A missing file is created. `undefined` removes the key.
- Sets from one handle apply in the order they were called; a later set of a
  key waiting behind a running one replaces it.
- When another writer published first, the save merges with them by key, so
  two windows setting different keys both keep their changes; where both set
  the same key, the set wins. A file that keeps changing past the merges is
  `KeptChanging`. A create that loses to another writer, or whose reply was
  lost, reads once more and saves over what is there.

One top-level key is one fact. Settings that must change together belong in
one key with an object value, which is set and merged as a whole.

`KvReadError` and `KvWriteError` are the two error unions.

### Merging kv.json

`mergeKv({ base, ours, theirs })` reconciles three captured `kv.json` texts
without opening a folder. Each input is a JSON object string or `null` for a
missing file. `fixtures/kv-merge.json` holds its test vectors.

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

A save and Sync settle competing keys through the same merge (`reconcileKv`
in `kv-merge.ts`, through `mergeFile`): each settled key is its raw value
text, or `null` to leave it out, and applies only where the key competes.

The function does not apply field schemas, write files, or choose a winner for
competing edits. Its module owns `kv.json` text: `kv.set` writes through the same
formatter, so a local save and a merge produce the same file. Every folder's `git.mergeIncoming()` uses it for root
`kv.json`; see [Merging incoming changes](#merging-incoming-changes).

### One file per save

Every save changes one file, or for a move one source and one destination.
There is no multi-file transaction: an application that keeps a row beside a
media file saves the media first and the row after, and on a failure between
them reads what landed before deciding what to save next.

### Changes

`onFilesChanged(listener)` is the one channel by which a handle hears that
files may have changed (ADR-0548). `listener` receives
`FilesChanged = readonly string[] | 'everything'`: the paths a change
reached, or `'everything'` when the reporter cannot say. A change carries no
content and is never a capture; read through the folder to learn what the
files hold. Nothing records changes, so a missed one costs a delay, never
data. Subscribe before the first read so nothing falls between them. Closing
stops all listeners at once, including the ones still waiting in a dispatch
that a listener closed the folder from.

Each host has exactly one detector of changes made outside the handle:

| Host | Detector | Reports |
| --- | --- | --- |
| Browser | Other pages of this origin, which post the paths each write landed on a `BroadcastChannel`; and resuming from being frozen or from the back-forward cache (`pageshow` with `persisted`, the Page Lifecycle `resume`) | The paths; `'everything'` on resume. Returning to a window reports nothing. |
| Desktop | The shell's watcher of the granted directory: the folder plugin's `epicenter-folder://changed` event, `{ scope, paths }`, sent to each permitted window and filtered by this folder's scope | The paths; `null` paths as `'everything'`; `.git` when history moved |
| Bun | None; a script that needs one watches with `fs.watch` | Nothing from outside |

A handle's own saves are not reported to it: whoever saved holds the result.
What its own Sync writes is reported on every host, since the page did not
make those changes. Every report marks the history's observations stale.

A listener runs inside the folder's work. What it throws is logged and goes
no further: the save still returns its capture, and the other listeners
still hear. The same holds for a `git.subscribe` subscriber.

### Queries

`@epicenter/folder/query` gives TanStack Query option factories over a
folder, as tRPC's `queryOptions` and `mutationOptions` do. `folderOptions`
holds no query client and no subscription:

```ts
import { folderOptions } from '@epicenter/folder/query';

const folder$ = folderOptions(folder);
createQuery(() => folder$.todos.list.queryOptions());
createQuery(() => folder$.todos.get.queryOptions('milk')); // StoredRow | null
const done = createMutation(() => folder$.todos.update.mutationOptions());
done.mutate({ stem: 'milk', set: { done: true } });

// The app root, once: changes the page did not make mark what they name stale.
const stopChanges = folder$.invalidateOnChange(queryClient);
```

| Area | Queries (`.queryOptions()`, `.queryKey()`) | Mutations (`.mutationOptions()`) |
| --- | --- | --- |
| each table (`folder$.<table>`, and `folder$.tables.<table>`) | `list`, `get(stem)` | `create`, `save({ base, row })`, `update({ stem, set?, unset? })`, `rename`, `delete` |
| `kv` | `get` (the reading, or `null`) | `set({ key, value })` |
| `files` | `list`, `read(path)`, `text(path)` (the file as an editor opens it: its text, or its kind and size past 1 MiB or when binary) | `write({ path, content, base? })` (a save over `base`, or a create), `move({ file, to })`, `delete(file)` |
| `history` | `status`, `log(depth?)` | `saveVersion` (`git.commit`), `sync` |

`folder$.query({ paths, key, queryFn })` is a query of the page's own over
the files at `paths`, each a file or a directory: cached like the reads
above, and stale whenever a change reaches one of `paths`. A list derived
from two tables names both directories.

Writes to one file run one at a time, in the order made, whichever
control or options object made them, so a checkbox's update reads the row
a title's update wrote. The options keep that order themselves, not in a
TanStack mutation scope: a scoped mutation waiting its turn resumes only
while the window has focus, and a save must not wait for the person to come
back.

A write keeps the cache in step inside its own `mutationFn`, so a caller's
`onSuccess`, `onError`, or `onSettled` adds to it and replaces nothing. It
puts its result where it can: `save`, `update`, and `create` set the row's query and
its entry in the listing, `delete` drops them, `kv.set` sets the reading,
and `files.write` sets the file's `read` and `text`. The folder does not
report a page's own writes to it, so the write marks stale the rest of what
a change to its paths would, the history's status included. A read still
running when the write lands may predate it, or a later change, so it is
read again rather than kept. A failed write reads its paths again: the
file was not what the base said, or the reply was lost.

`invalidateOnChange(queryClient)` subscribes to `folder.onFilesChanged` and
invalidates each change's `pathFilter`; it returns the function that stops
it. `pathFilter(change)`, also usable on its own to invalidate, cancel, or
refetch, matches each row at a changed path, the listing of
each table whose directory a path is in, the settings for `kv.json`, the
file listing and each changed file's `read` and `text`, each `query` over a
changed path, and the history's status; a path in `.git` also matches the
log, and `'everything'` matches every query of the folder. Invalidating
reads again only what a view or observer holds; a store that reads with
`getQueryData` observes what it shows. A table named like a member (`kv`,
`files`, `history`, `tables`, `pathFilter`, `key`, `query`) is under
`folder$.tables` only.

Every read is local and changes only when the folder's channel or the
page's own write says so, so the options set `networkMode: 'always'`, no
retry (on mount either), `staleTime: Infinity`, and no focus refetch; an app sets none of
these for the folder's queries.

`runMutation(client, options, variables)` runs a write from outside a
component, as `mutateAsync` does, through the client's mutation cache.
`whenIdle(client, filters?)` resolves once nothing matching `filters` is
mutating, counting a draft's next save that is about to start.

## History

Browser handles and directory handles, in Bun or a desktop page, follow the
same history rules.

A save returns once its files are published and never waits for Git. A commit
pins the branch head, captures every source file, writes a commit with a
subject derived from the tree difference, and moves the branch only with a
compare-and-swap. A commit whose branch moved after it pinned the head retries
once: it captures the folder again, so it records everything the lost
attempt held, over the new head. A second move is reported as `branchMoved`.
A staged `commitStaged()` is not retried: its index was staged against the
head that moved, and it is reported as `BranchMoved`. Commit and push
failures never undo a save.

A save never asks for a commit (ADR-0529). A commit happens only when a caller
asks for one: `commit()`, `commitAndPush()`, a staged `commitStaged()`, or
sync's checkpoint before it fetches. A commit that fails otherwise is reported
in `git.snapshot.lastCommit` and is not retried. `git.snapshot.files` turns
`stale` when a save lands after the last capture, and `git.status()` lists what
is uncommitted.

The browser and Bun openers use local `main`. A remote branch selects the
transfer destination; it never selects another local history. An existing
repository with `HEAD` on another branch refuses commits and incoming
adoption until its branch is deliberately reconciled.

`commit()` stays local, even with a configured remote.
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

`close()` fences new file work, stops change reports, refuses new Git requests, and
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
already holds the files lock can finish after close returns, although the
paths it posts to other pages can be lost once the channel closes.

A Git request still waiting for admission is refused; work that already
entered its protection
settles before storage is released. No final commit is required, and saved
files can remain uncommitted after close.

In the desktop app the shell keeps the folder's lock after a page closes, for
that window's next open, until the app quits. Quitting waits a bounded time
for file changes and `git` runs the shell already admitted, and makes no
commit.

### Sync

`folder.sync` is the one action an application offers for "bring this folder
and its remote together" (ADR-0514). `run()` commits the saved files, fetches
the remote branch, merges, and pushes without force:

```ts
const { data: ran, error } = await folder.sync.run();
if (error?.name === 'NeedsChoices') return review(error.attempt); // nothing conflicted was written or sent
if (error !== null) return show(error.message);
// ran.kind: 'synced', or 'saved' when the push is not confirmed
```

A folder that had no history before the run, whose first commit the run
made, adopts the remote's history by merging over an empty base; two
different files at one path are then a conflict like any other. A folder
with a history of its own meets an unrelated remote as `Unrelated`, writing
nothing; `run({ allowUnrelatedHistories: true })` combines them. `connect(url)`
sets the remote, then runs ([above](#the-folder-opened-lazily-and-its-remote)).

Its merge is `mergeIncoming`'s, with every plain file both sides changed
merged by `mergeFile`, the same merge a save makes ([One save](#one-save),
ADR-0551):

| Path | Merged by | A conflict is |
| --- | --- | --- |
| root `kv.json` | key (`reconcileKv`) | `setting`: one key, with JSON values |
| `<table>/<stem>.md` of a declared table | field and body, through `parseRow` | `field`: one field, with JSON values; `body`: the notes, as text |
| any other UTF-8 text file, or a row or `kv.json` version that does not read as its kind | line | `file`: the text, when lines compete |
| any file one side deleted, or a version that is not text | nothing | `file`: the whole file; `binary` when a version is not text |

Field values compare as JSON, so quoting, key order, and frontmatter
comments never conflict; the body merges by line. A merged row is written by
`formatRow`, in the standard form. For a `body`, and a `file` both sides
changed by line, `local` and `incoming` are the line merge with that side
winning every competing span, so taking a side keeps the other side's lines
that did not compete. A binary `file` is taken or removed, never replaced;
its versions are bytes. A link, executable, or submodule, and a file against
a directory are `Unreviewable` and nothing is written; repair them with Git
outside the folder.

A `SyncAttempt`, carried by `SyncError.NeedsChoices`, is `{ id, local, incoming, conflicts }`.
Each conflict has an opaque `id`, its `kind`, `path`, `key` or `field`, and
`base`, `local`, and `incoming` versions, each `{ present: false }` or
`{ present: true, value }`. `resolve` takes one choice per conflict ID:

```ts
const choices = {
	[title.id]: { kind: 'take', side: 'incoming' }, // that side's version; an absent side removes
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
  then reads as `InvalidRow` and is repaired as text, like any other. A
  binary `file` choice that replaces is `disallowed`.
- Otherwise the attempt is spent. `resolve` merges the captured commits
  again, never fetching, publishes the merge like `mergeIncoming`, and pushes.
  An attempt replaced by another `run()`, or a folder whose branch moved or
  whose saved files changed since the attempt, is `Stale` and nothing is
  written.
- `synced` means the push confirmed the merged head and no save landed after
  the capture. `saved` carries the push's own outcome and `changedSince`.

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
text with no declared filter is ordinary bytes. A directory folder, in Bun or
on the desktop, asks `git check-attr --source`; the browser evaluates the
commit's attribute files the same way, matching patterns as a case-insensitive
checkout does.

An incoming update publishes files, then the index, then the branch, and no
host records it in progress (ADR-0545). A browser folder publishes under its
Git Web Lock and then its files lock. Ordinary saves take only the files lock.
They wait while an update publishes its working tree, index, and branch, but
not for fetching or preparing the incoming Git objects.

1. Admission, in a browser folder. Every portable file must still have the
   hash the update captured, no new file may have appeared, and the index
   must be the bytes its clean check left; otherwise nothing is written and
   the update is `Refused` or `StagedChanges`. A path the update writes a
   file at that holds a directory the update does not empty is refused here
   as `NotAFile`, as is one holding a file no portable path names, such as
   `.DS_Store`. A directory folder, in Bun or on the desktop, checks each
   changed file's own condition as it writes, best effort.
2. Removals (pruning only the directories they emptied; empty directories a
   person made stay), then the directories the update emptied where it
   writes files, then writes, then the index, then the branch, compared with
   the pinned head. So `a/b` can become a file `a`, and a file `a` a
   directory `a/b`.

An update that stops partway, because a step failed or the tab closed, is
`Interrupted` with the `paths` it wrote or may have written. Nothing is
pending afterward: the files it wrote differ from the branch head, status
shows them as changed, saves and commits go ahead, and the next Sync records
them and merges with the remote. A fast-forward cut off partway holds, at each
path, the old version or the new one (in a browser, also an empty file whose
creation never closed), so that merge lands on the remote's tree. The Sync can
add one local commit of the mixed tree before its merge commit.

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
and the branch the way a fast-forward does.

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
conflicts have no file versions.

Browser folders and directory folders, in Bun or on the desktop, merge under
these rules.

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
properties are the fields. A table declared with `additionalProperties: false`
beside `fields` is closed: the file holds the same keyword beside `properties`,
and a row with a key the table does not declare does not conform (ADR-0536).
Open is the default, and a closed table is for folders people write by hand;
a dataset refuses one. A field's references must mean the same there as
in the field alone, so a folder also refuses two fields of one table that
define the same `$id`, such as two recursive types both named `Node`, and a
`#` reference outside any `$id`, which the file would resolve against the
table. Rename one definition, or give the field an `$id`. Definitions are not
renamed when they are published, so the file holds exactly the fields a
reader prepares.

A definition is `{ title?, kv, tables }` and nothing else. `defineFolder`
throws on an `id`; an opener given an untyped definition with one returns
`InvalidDefinition`. Its type is `FolderDefinition`, the identity-free
`DataSchema` of `@epicenter/definition`, prepared with `prepareSchema`.

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
| `src/browser-adapter.ts`, `tauri-adapter.ts` | The adapters the automatic entry loads lazily. The browser adapter maps the folder ID to its OPFS directory; the desktop opener asks the shell for the granted directory and loads `tauri-directory.ts`, `tauri-history.ts`, and the directory folder only then. |
| `src/folder.ts`, `table.ts`, `kv.ts`, `markdown.ts` | The handle and its interpretation of files, shared by every adapter. `table.ts` holds `save` and its merge. |
| `src/changes-browser.ts`, `changes-tauri.ts` | Each host's one detector of changes made outside the handle ([Changes](#changes)). |
| `src/query.ts`, `draft.ts` | `@epicenter/folder/query`: `folderOptions` and `createTextDraft`. |
| `src/check-folder.ts`, `query-folder.ts`, `generate-declaration.ts` | What the CLI's `check`, `query`, and `generate` do, exported from the Bun entry. |
| `src/row-text.ts`, `canonical.ts` | `parseRow` and `formatRow`, and the row codec under them: the one parser and the one writer of row text. |
| `src/svelte/` | `@epicenter/folder/svelte` (`draft.svelte.ts`), its tests, and the Svelte boundary tests. |
| `src/opfs-store.ts`, `git/opfs-git.ts`, `git/browser-backend.ts` | OPFS storage, private `.git`, and isomorphic-git. |
| `src/directory-adapter.ts`, `directory-handle.ts`, `directory-node.ts`, `directory-tauri.ts` | The directory folder both the Bun entry and a desktop page open: the handle over a directory's primitives, and those primitives over `node:fs` or the shell's commands. |
| `git/native-*.ts` | The `git` program a directory folder records history with, in Bun. |
| `src/history-wire.ts`, `tauri-history.ts` | A desktop page's history: the reply line the `epicenter` CLI prints for what it runs (`runHistory` in `bun.ts`), and the page's `folder.git` over the shell's history commands. |
| `src/native/bindings.gen.ts` | Commands generated from the `tauri-plugin-epicenter-folder` crate. Internal. Do not edit. |
| `fixtures/` | Vectors the tests read: `kv-merge.json` for `mergeKv`, and `commit-subjects.txt`, the subjects `commitSubject` in `src/git/messages.ts` writes (`bun run gen:vectors` rewrites it). |
| `evidence/` | Tests that build real bundles and read real import closures; `evidence/opfs`, a page that runs the browser checks in a real browser. |

## Commands

```sh
bun run test              # core and directory tests, then mounted Svelte tests
bun run test:svelte       # only the mounted Svelte tests; they need --conditions=browser
bun run typecheck         # svelte-check: TypeScript and the .svelte test fixtures

bun evidence/bundles/inspect.ts main tauri   # print the chunks a build emits
bun evidence/opfs/serve.ts   # the OPFS page on 127.0.0.1:5181; --build only compiles it
```

The browser suites run on an in-memory OPFS stand-in
(`src/opfs.test-support.ts`). They show the folder's protocol, not that a
browser's OPFS behaves like the stand-in; the evidence page checks that.
Application tests import `src/browser-storage.test-support.ts` by path:
`createTestStorage()` owns one fresh stand-in tree, `browserStorage(storage)`
opens it, and `testBrowserStorage()` does both in one call.

Real Git remotes for tests come from `src/git-http.test-support.ts`: its
`gitHttpBackend` answers smart HTTP with the system `git http-backend` over
bare repositories on disk. `src/git-demo-server.test-support.ts` serves that
bridge on loopback with a native checkout beside the bare repository. The
Todos and Git lab development commands (`bun dev:todos`, `bun dev:git`) run
it, and their tests call its handler without binding a port. Neither file is
in the package's exports.

## Limits

A reference field has no integrity: nothing checks its target, and rename
repairs no references. `kv.set`
writes each value it sets as compact JSON. Browser bytes are stored whole.
A whole-folder checkpoint or status scan reads and hashes the whole folder.
Version checks on disk are best effort
against other programs. File bytes cross the desktop bridge as JSON number
arrays, which is slow for large audio.

In a browser, OPFS quota exhaustion and eviction surface as the failing
step's `Io` or `Unconfirmed`; nothing reserves space. Pages of other origins or browser profiles are outside
what the Web Locks can see.


## Internal composition

Files, tables, and KV use one storage API. Its `apply`
accounts for content changes, so a domain method cannot accidentally choose a
write that skips marking history stale.

```ts
createFiles({ storage, definition })
createTable({ storage }, name, definition.tables[name])
createKv({ storage }, definition.kv)
```

`files.save`, `table.save`, and `kv.set` each call `saveFile` (`save-file.ts`)
with the file's kind, which merges through `mergeFile` (`merge-file.ts`), the
merge Sync uses too.

Every opener wraps raw storage with publication accounting. Assembly fences
the resulting storage with the handle's close signal. These wrappers retain
no file-operation collection.

Git keeps raw storage because incoming fast-forwards update files and history
under their own policy, and are not recorded as local saves. Saves are not
ordered by when their methods were called; each names the bytes it started
from, so a later one merges with or is refused by what landed first.
