# @epicenter/folder

A folder whose current files are the saved data: Markdown rows and any other
file, with Git history beside them. There is no document store
behind it. The package does not depend on `@epicenter/app`.

```ts
import { defineFolder, defineTable, field, openFolder } from '@epicenter/folder';

const definition = defineFolder({
  tables: {
    todos: defineTable({ fields: { title: field.string(), done: field.boolean() } }),
    settings: defineTable({ fields: { theme: field.optional(field.select(['light', 'dark'])) } }),
  },
});

const { data: folder, error: openError } = await openFolder({ app: 'so.epicenter.todos', definition });
if (openError !== null) return show(openError.message);

const stop = folder.onFilesChanged(() => refresh());   // subscribe, then read
const listed = await folder.tables.todos.list();       // one { stem, result } per row file
const { error: createError } = await folder.tables.todos.create(
  { fields: { title: 'Milk', done: false }, body: '' },
  { stem: 'milk' },
);
if (createError !== null) show(createError.message);
const { error: setError } = await folder.tables.todos.set('milk', { done: true });
if (setError !== null) show(setError.message);         // invalid values, or kept changing
await folder.close();                                  // closed either way
```

An app that keeps settings keeps them as rows too: a table named `settings`,
one row per concern, such as `settings/display.md` (ADR-0576). This is the
convention for when an app has settings; no first-party app declares the
table yet. Every field it declares is `field.optional`,
so a setting may always be unset and the app's own default applies;
`defineFolder` refuses a required one, and a published declaration that has
one still opens. Reading and writing it is reading and writing any table, so
the first setting of a concern is a `create`, which a second device's create
of the same row merges with by field, and `set` changes a row that is there.
A value that does not read makes its whole row one to repair.

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

Opening writes nothing. One handle publishes root `epicenter.json`: an app's,
in the folder named after the app
([the one rule](#which-folder-opens-and-the-one-rule)). It writes
`formatDeclaration(definition)` just before its first write (ADR-0508). Every
other handle reads the file as the folder's schema and never writes it. Each
table is one JSON Schema object, `{ type: 'object', properties, required }`,
whose properties are the table's fields as the prepared definition holds them:

```json
{
  "title": "Vault",
  "tables": {
    "settings": {
      "type": "object",
      "properties": { "theme": { "enum": ["light", "dark"], "x-field": { "kind": "select" } } },
      "required": []
    },
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
trailing newline. An app opening its own folder uses its code definition and
does not read this file as configuration; any other opener reads the folder
with this file, through its definition if it has one.

Publication replaces manual descriptions and descriptions from another app
version. It migrates no saved rows. A prepared definition is
plain JSON, so formatting cannot fail; a failed write is logged through
`wellcrafted/logger`, with the destination and actual failure, while the
folder remains usable. A failed attempt can leave discovery missing, stale, or
uncertain.

Publication writes `epicenter.json` once per handle, before that handle's
first save, with the one write, as a create that joins the file there: a
missing file is created, and a present one takes the declaration whole but
for `local`, which keeps every pattern the file lists, as `merge` decides
every write of `epicenter.json` (ADR-0576). A file that already holds the
result is not written, and another writer getting there first starts the
write again, as it does any write. It never commits or pushes, so the published
`epicenter.json` is recorded with the next version. A folder opened only to
read, or to take a remote's history, is never written by opening.

A definition can name files that stay on the machine that wrote them, as
`.gitignore` patterns in `local`:

```ts
const definition = defineFolder({
	tables: { recordings: defineTable({ fields: { title: field.string() } }) },
	local: ['audio/'],
});
```

`local` is part of the declaration: the handle publishes it in
`epicenter.json` as `"local": ["audio/"]`, so every host that reads the
folder's own file, the `epicenter` CLI's Sync and Save version included,
leaves out the same paths. A declaration without `local` keeps nothing local.
`local` is sorted and kept once each, so the file's bytes do not depend on the
order it was declared in. When the folder's `epicenter.json` is there but
cannot be read or prepared, the CLI's `runHistory` refuses a save version and
a sync, naming the problem, rather than commit without its `local`; status and
the log still read.

An open handle reads `local` from `epicenter.json` again for each commit and
each Sync, joined with the opened definition's, so a pattern a Sync brings in
from another device applies at once. Its own publication keeps every pattern
the file already lists. An `epicenter.json` whose `local` does not read
refuses the commit, as the CLI does.

The engine decides this itself, on both backends, whatever `.gitignore` says.
A path `local` matches is never history source (`git/scope.ts`): status does
not offer it, a whole-folder commit leaves it out, and a file committed before
the rule is removed from the next commit's tree and from the index, as
`git rm --cached` would, its bytes kept on disk. A path staged by hand with
plain `git add -f` is left out of the next commit Epicenter makes too. A
person's `!` exception in `.gitignore` does not override it.

With the declaration, before the same first write, the handle also makes the
root `.gitignore` name each pattern `epicenter.json` then lists, its
definition's and any a Sync brought from another device, so plain `git` and
the `epicenter` CLI agree. A missing `.gitignore` is created holding the patterns. A present one
gains each missing pattern as a line at its end, written with the one write
from the file as it was read, so a line another writer adds meanwhile stays;
its other lines are never reordered, rewritten, or removed, and a file that
already names every pattern is not written. A failed
write is logged, and the engine's rule still holds. The `.gitignore` is source
like any other file, so it syncs.

Two devices that publish differing `local` lists keep both: merging
`epicenter.json` unions `local` (ADR-0576), and no publication drops a
pattern. One limit remains: an older app version's `epicenter.json`, one
without `local`, taken whole by a Sync, drops other devices' patterns from the
file. Each device still excludes its own definition's patterns, and lists them
again on its next write. `.gitignore` merges by line and keeps the patterns
meanwhile, so plain Git still ignores an untracked file there; `.gitignore`
does nothing for a file already committed.
A pattern must be one line that ignores something: `defineFolder` refuses an
empty pattern, a comment, a negation, and surrounding whitespace. Plain
`git add -A` outside Epicenter honors only `.gitignore`.

```ts
const own = await openFolder({ app: 'so.epicenter.todos', definition });
const groceries = await openFolder({ id: 'groceries', definition });
```

The definition names no folder. `app` names the app, and the app's own folder
is the one named after it; `id` names any folder. Both openings use the same
prepared definition, and only the first may publish it
([Which folder opens](#which-folder-opens-and-the-one-rule)). The browser and
desktop openers refuse a missing `app` or `id` before they acquire anything.
An application keeps its id beside the code that opens its folder, not in the
definition. Several compatible applications can reach the same folder.

A browser folder's address is its ID alone ([ADR-0532](../../docs/adr/0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)):
each browser app is its own origin, so its storage already belongs to it.
Signing in does not move data or retarget writes. A desktop shell registers the
selected directory; the Bun opener receives an explicit directory, named by
its directory's name.

## Entries

| Import | Opens | Use it when |
| --- | --- | --- |
| `@epicenter/folder` | The desktop app's folder when the page runs in Tauri, this browser's storage otherwise. Decided when `openFolder` is called, and only the chosen adapter is loaded. | Ordinary application code. |
| `@epicenter/folder/browser` | This browser's origin private file system (OPFS) only. Refuses inside the desktop app. | A web-only build, or a test that injects an OPFS stand-in with `browser.opfs`. |
| `@epicenter/folder/tauri` | The desktop shell's folder only: this package's own engine over a directory the shell grants ([below](#a-directory-the-desktop-shell-grants)). Refuses outside the shell. | A desktop-only build. |
| `@epicenter/folder/bun` | An existing directory, in Bun. | Command-line tools, recovery scripts, and tests that are given a directory. |
| `@epicenter/folder/query` | Nothing: TanStack Query option factories over a folder already open ([Queries](#queries)). | A page that reads a folder through TanStack Query. |
| `@epicenter/folder/svelte` | Nothing: `createTextEditor`, one document's text opened over the folder's write, and `createBodyEditor`, its row case, each read reactively with its save loop ([Editing text](#editing-text)). Loads Svelte's runes only. | A Svelte editor of a note body or a file's text. |
| `@epicenter/folder/file-browser` | Nothing: path helpers, visible tree rows, newline preservation, and `readTextFile` over a folder's files ([File-browser helpers](#file-browser-helpers)). | A file tree or a file view. |

The first three export the same `openFolder` signature and the same
contract, so one application source builds against any of them. Importing an
entry opens nothing. On a server, opening returns a refusal.

```ts
openFolder({
  app,         // an app's id, such as 'so.epicenter.todos', with its definition
  definition,
  credentials, // optional: (url, signal) => Promise<{ username, password } | undefined>
  browser,     // optional: { author, httpFetch, opfs }
}): Promise<Result<Folder<typeof definition, FolderDefinition>, OpenFolderError>>

openFolder({
  id,          // any folder by its ID, such as 'data:Groceries'. Never a path.
  definition,  // the definition to read it through
  credentials,
  browser,
}): Promise<Result<Folder<typeof definition, FolderDefinition>, OpenFolderError>>

openFolder({
  id,          // any folder, read with its own epicenter.json
  credentials,
  browser,
}): Promise<Result<Folder<FolderDefinition>, OpenFolderError>>
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

### Which folder opens, and the one rule

One rule decides what a handle does with a definition: a folder's
`epicenter.json` is published by the app the folder is named after, and every
other opener reads through its definition (ADR-0583).

An app opens with `{ app, definition }`. In a browser it opens its own folder,
the one named `app`. In the desktop app it opens the folder the shell handed
its window: the shell opens each app window on one folder, its own from the
Apps list or the one a person chose "Open in" on, and answers the page which
(`window_folder` in `tauri-plugin-epicenter-folder`). The page's URL, routes,
and reloads never change it. A page that names an `app` its window does not
run, or opens `{ app }` in a window that runs no app, is refused
`AppMismatch`. Epicenter's Settings window runs Epicenter itself, on
`so.epicenter`.

`folder.id` names the folder: on the desktop the scope the shell granted, such
as `so.epicenter.todos` or `data:Groceries`. `folder.own` says whether the
handle may publish its definition: true exactly for the app's own folder. It
is decided when the folder opens. Publication itself is best effort just
before the first write, logged when it fails, so `own` does not promise that
`epicenter.json` is on disk.

A tool that has no schema of its own, such as the Folders window, the CLI, or
a script over a vault, opens with `{ id }` and reads the folder's own
`epicenter.json`. With `{ id, definition }` it reads the folder through the
definition instead, as an app reads Epicenter's own folder.

| | The app's own folder | Any other folder, through a definition | Any folder by `{ id }` alone |
| --- | --- | --- | --- |
| `folder.own` | `true` | `false` | `false` |
| Schema | the app's `definition` | the folder's `epicenter.json`, which must contain the definition ([below](#opening-another-folder)) | the folder's `epicenter.json`, read and prepared as `readFolder` does when the folder opens |
| `epicenter.json` | published before the first write, if its bytes differ | never written | never written |
| No `epicenter.json` | published on the first write | contains only a definition with no tables, so a definition that reads a table is `ShapeMismatch` | no tables; files, history, and Sync work |
| An unusable `epicenter.json` | replaced on the first write | `InvalidDeclaration`, and nothing opens | `InvalidDeclaration`, and nothing opens |
| Tables | typed by the definition | the definition's tables, typed by it | keyed by any name, rows checked at run time |
| Repository on disk | created by the first commit (Save version, or Sync's checkpoint) or `sync.connect`; until then status is an empty history with every file uncommitted ([Repository creation](#repository-creation)) | the same | the same |

Every handle has `folder.definition`, the prepared definition it reads with,
so a view can render a folder it did not declare. History and Sync use it
too: Sync merges a folder's rows by the folder's own declaration. The
definition is read once, when the folder opens; a declaration that changes
afterward, such as one a Sync brought, is read by the next open.

On the desktop, `id` names a folder the shell registered, until the shell
issues grants for folders a person picks. In a browser, `{ id }` opens the
origin-private folder named `id`; a folder nobody wrote to has no files, its
first write creates its directory, and its first commit creates its
repository.

### Opening another folder

An app that reads a folder it did not create reads it through its definition
(ADR-0538). The folder opens when its own declaration contains the
definition's shape, and its tables are typed by the definition:

```ts
const board = defineFolder({
  title: 'Board',
  tables: {
    todos: defineTable({ fields: { title: field.string(), status: field.select(['todo', 'done']) } }),
  },
});

// On the desktop, the folder the shell handed this window.
const { data: folder, error } = await openFolder({ app: 'so.epicenter.board', definition: board });
// ShapeMismatch: "Board cannot open the folder 'Groceries': ...", with `error.problems`.
if (error !== null) return show(error.message);
await folder.tables.todos.set('milk', { status: 'done' }); // fields the definition does not name stay on the row
```

The folder contains the definition when, for every table of the definition,
it declares a table of that name, and for every field the definition reads,
it declares that field with a schema whose every value the definition's field
accepts (`schemaContainment` in `@epicenter/definition`). A definition's
`string` accepts a folder `string`, a select of strings, or a date; a
`number` accepts an `integer`; a nullable field accepts a field that is never
`null`; a select accepts a select of some of its options. A field the
definition requires must be required by the folder; an optional one may be
either. A closed folder table (`additionalProperties: false`) contains a
definition that reads some of its fields; a closed definition table needs a
closed folder table with no other field. The check is conservative: a pair it
cannot decide is a problem with the reason, and the app widens its
definition. A folder without `epicenter.json` contains only a definition with
no tables.

| | Through a definition |
| --- | --- |
| A folder that does not contain the definition | `ShapeMismatch`, its message naming the folder by its directory's name, and the app by the definition's `title` when an app opened it, with `problems`: `missingTable`, `missingField`, `incompatibleField`, or `incompatibleTable`, each with its table, field, and reason. Nothing opens. |
| `tables` | the definition's tables alone, typed by it; the folder's other tables are not on the handle |
| A row read | every field the file holds, the ones the definition does not name included, so a write of the row read keeps them |
| A write | checked against the folder's own declaration, every field of it, a merged row included: the definition cannot write a value the folder refuses |
| `create` | `canCreate` is false, and `create` is `InvalidValues` naming the fields, when the folder requires a field the definition does not declare; rows can still be edited |
| `definition` | the folder's own prepared declaration |
| `epicenter.json` | never written |
| The definition's `local` | an untracked file it matches is never committed, so what the app keeps on this machine never enters the folder's history; a file the folder already tracks stays tracked. Nothing is added to the folder's `epicenter.json` or `.gitignore`. |

Fields the definition does not name are kept only on the row it read. A row
built from scratch and passed to `write` or `create` drops them, and the
folder refuses it when one of them is required.

### The folder, opened lazily, and its remote

Opening a browser folder writes nothing. The folder's first write creates its
directory, and an app's handle publishes `epicenter.json` just before it, in
the app's own folder; each table's
directory appears with its first row. Its repository comes with its first
commit or remote, as on every host (see
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
| files, no history | history | merges them over an empty base; where a path differs, this folder's version wins and history keeps the remote's |
| its own history | related | syncs |
| its own history | unrelated | `Unrelated`, writing nothing, until `allowUnrelatedHistories` |

The remote stays set whatever the sync answers. A sync that stopped partway
keeps no record: the files it wrote are local files, and the next sync merges
them with identical remote files cleanly. On the desktop the shell lets a page
set the remote only to a network URL.

### Repository creation

Opening a folder never creates its repository, on any host or opener. The
first commit (`git.commit`, Save version, or Sync's checkpoint), or setting
a remote (`sync.connect`), creates it. Until
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
still a change. `files.read(path)` returns the bytes read, detached, so they
stay after the path is replaced.

Opening requires `navigator.storage.getDirectory`, writable file streams, file
moves, and Web Locks; without one it returns `NoFileSystem` and never falls
back.
IndexedDB is not required and is never read or written. A folder an earlier
version kept in IndexedDB is not opened, copied, or removed.

Storage is one port on every host (`boundary.ts`): `read`, `list`,
`children`, `put(path, bytes | null, ifMatch)`, `mkdir`, and `rmdir`, and
`lock` where Sync publishes: in a browser, and in Bun, where the `epicenter`
CLI runs a desktop page's Sync. In a browser (`opfs-store.ts`) every change
holds the folder's files Web Lock, so the condition of each `put` is checked
and the change lands without interleaving across tabs, and `lock(work)`
holds it across several, as Sync's publish does. Reads take no lock. Every change lands whole: a
replaced file's bytes publish when its stream closes, so a reader sees the
old bytes or the new ones, and a new file is written to
`.git/epicenter/scratch` and moved into place, so a crash never leaves it
empty.

| What happened | Outcome |
| --- | --- |
| A write failed before its stream closed, or a new file's move failed | `Io`, and the path holds what it held. |
| A replacing stream's close threw | Read back once: the bytes sent are the write landing; anything else is `Io` with `Unconfirmed` as its cause. The path is posted to other pages and the history observation turns stale. |
| A move landed its destination and could not remove its source | `Io`: a move is a create at the destination, then a removal of the source guarded by its bytes, so both paths hold the file, to repair. The destination is posted to other pages. |

Writes are ordered by the lock alone, not by when their methods were called.
A write that hashes or waits longer can land after one asked for later, from
the same page or another. Every put is guarded by the bytes its write read,
so none lands over bytes its write did not merge: a stale put reads again
and merges, a create onto a file that landed meanwhile is `Occupied`, and
a delete reads again and still wins.

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

Files go through the same storage port the browser implements
(`boundary.ts`), over the directory. On the desktop each port method is one
command of the shell (`tauri-files.ts`,
[ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md)):
`list_folder`, `read_folder_children`, `read_folder_file`,
`put_folder_file`, `make_folder_directory`, and `remove_folder_directory`,
each taking folder-relative paths, so a read and a put are one call each. In
Bun the directory's storage (`directory-store.ts`) is built on seven calls
over `node:fs` (`directory-primitives.ts`, `directory-node.ts`): `readDir`,
`lstat`, `readFile`, `writeFile` with `createNew`, `rename`, `remove`, and
`mkdir`. The two give the same outcomes, held to one vector file both run
(the plugin's `fixtures/storage-outcomes.json`). They differ in one race: a
parent directory another writer prunes while a put waits for the save lock
is made again under the lock on the desktop, and fails the rename in Bun,
which makes parents before taking the lock. A write's bytes are staged under
`.git/epicenter/scratch` and renamed over the path, so another program sees
the old file or the new one, never an empty or partial one; a put that does
not land leaves neither its staged file nor a directory it made. What a
stopped write left there an hour or more ago is cleared when Bun opens the
folder, and by the shell at each grant. Symbolic links and special entries
are listed and never followed, and a path through a link is refused. On the
desktop the shell checks every path itself: any data path the shared path
rule accepts (`paths.ts`, held to the plugin's `fixtures/path-rules.json`
with its Rust twin), with no link on the way, and never `.git`. A put names
what it expects at its path: no file, or a file with a given SHA-256. The
shell checks it again and changes the path under one lock per root and the
folder's save lock, which every window's puts and directory removals share
(`mkdir` takes neither), so a save that carries what it read (a hash, or a
create) and that another window landed after this page checked is `stale`,
never `Unconfirmed`. A save lock another process held too long is `Io`, and
nothing changed, on both hosts. In Bun, `directory-node.ts` makes the same
check as a separate step before the change, and `bun.ts` holds the folder's
save lock across both, the lock the shell takes around its own (below);
`lock(work)` holds it across several changes, which then go through
`node:fs` without asking for it again. On the desktop a change whose invoke
rejected without the shell's answer is `Unconfirmed`: a rejection is
almost always one the command never ran for, but that cannot be shown, and
the path's state afterwards is no receipt. A write reads an `Unconfirmed`
put back once (`write.ts`): a removal is done if the path is gone, a write
if it holds the bytes sent, and anything else stays `Unconfirmed`. Objects
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

| Host | Save | Commit | First commit or remote |
| --- | --- | --- | --- |
| Desktop page | The shell's checked put | In the CLI, under the folder's history lock, then Git's lock files and the branch's compare-and-swap | `git init` in the CLI, run again if another opener raced it |
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
| `sync.run()`, `sync.connect(url)` | `sync` | `epicenter sync <root> [--to <url>] --json` |

The child runs the engine a Bun process runs (`runHistory` in `bun.ts`), so
the merge is the same TypeScript on every host (ADR-0576). A save version and
a sync hold the folder's history lock, an exclusive SQLite transaction on
`.<name>.epicenter-history-lock` beside the folder (`holdingHistoryLock` in
`bun.ts`), so two windows' children, or a window's and a terminal's, take
turns; it is apart from the save lock, so a page's saves never wait on a
sync's network: they wait only while the child checks and writes one file,
holding the save lock. Status and the log take no lock. What a sync wrote comes back in the reply (`landed`) and is reported once on
`onFilesChanged`; the shell's watcher reports the same files and the moved
history, which at most rereads them.

A folder's `git` is status, the log, and `commit` on every host; Sync is
how it exchanges history. The page holds no token: the CLI sends the deployment's Git its own, and `credentials` does not
apply on the desktop. A computer with no `git` answers
`GitError.GitMissing`, with how to get one (`install`); files still read and
save.

Status costs one child: on macOS arm64, with 200 files, a median of about
80 ms from spawn to exit (20 runs), of which about 20 ms is the binary's
start. The page holds what it last read (`folderOptions`, ADR-0553) and reads
again only when a change or its own write marks it stale, with at most one
read running and one waiting.
An incoming update that stops partway keeps no record: every file it wrote
landed whole, they show as changes, and the next Sync records and merges
them.

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

// The app's own folder: a directory named after the app.
const opened = await openFolder({
  root: '/Users/me/Epicenter/so.epicenter.todos',
  app: 'so.epicenter.todos',
  definition,
  git: { author: { name: 'Tool', email: 'tool@example.test' } },
});

// Any directory, with its own epicenter.json.
const vault = await openFolder({
  root: '/Users/me/Code/vault',
  git: { author: { name: 'Tool', email: 'tool@example.test' } },
});
```

The Bun opener follows the same rule by path: a directory is named by its
directory's name (`folder.id`), so `{ root, app, definition }` publishes
only in a directory named after `app`. Any other directory is read through
the definition, and `{ root }` reads the directory's own `epicenter.json`
([above](#which-folder-opens-and-the-one-rule)). The name is the whole test:
a script that opens `/any/repo/sub/so.epicenter.todos` as `so.epicenter.todos`
publishes there and may give it a repository of its own. The `epicenter`
CLI's history commands are stricter about the second: `isApplicationFolder`
in `packages/cli` also requires the directory to sit directly under the
Epicenter folder root and its app to be installed, which a directory opener
is not told. A script that edits a data
folder opens it with `{ root }`; passing `parseDeclaration` of the file as an
app's definition is safe only for a declaration `epicenter generate` wrote,
since an app publishes its own formatting on the first write. Opening
creates nothing. A directory that is not an app's own and is inside another
repository's working tree, where ADR-0517 records the folder in the host's
history, never gets a repository of its own: its first commit is `blocked`,
naming the host.

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
script and an open desktop window, cannot both pass the check; the second's
put is stale, and it reads again and merges as any overtaken write does. A save waits up to ten
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
```

A data folder is a directory holding `epicenter.json` (ADR-0517), the
declaration an opener publishes as `DECLARATION_PATH`. `readFolder` reads it,
prepares it, and reads every declared table through the same tables and
native file boundary an opened folder uses, so a tool
and an application reach the same verdict on every file. A symbolically
linked table directory is that table's `InvalidPath`, never followed.

`parseDeclaration(text)` reads the file's grammar and nothing else: a
top-level `$schema` (which only helps an editor offer completion), `title`,
`local`, and `tables`, each table `{ type: 'object', properties, required? }`
with every `required` name declared. A table without `required` has only
optional fields. Any other top-level key, a `kv` included, a visible `~` key on a
field, or a field preparation refuses, such as one with an unknown `format`
or a `$ref` that names nothing in the field, is `InvalidDeclaration`. The older `{ fields }` shape is refused; there is no
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

`checkFolder` sorts what `readFolder` reports: a row that does not conform, bytes that are not UTF-8, or a path the folder cannot hold is
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
| `tables.<name>` | Rows at `<name>/<stem>.md`, read through `parseRow` and written through `formatRow`. `canCreate` is false only for a table read through a definition that cannot supply a field the folder requires. `get(stem)` returns a `StoredRow` (`path`, `sha256`, the exact `text`, and a complete, caller-owned `row`), `InvalidRow` for readable text that is not a valid row, or `undefined` only for absence. `list()` returns one `{ stem, result }` per row file. `write(stem, from, to)` merges the change from one row to another into the row as it is now, through the folder's one write; `set`, `create`, `delete`, and `rename` build that change. Each changes exactly one Markdown file, a rename two. See [Reading a row](#reading-a-row), [Writing a row](#writing-a-row), and [Editing a row](#editing-a-row). |
| `write(path, from, to)` | The one write (ADR-0576): merges the change from `from` to `to` into the file as it is now, by unit, the writer winning a unit both changed, and puts the result guarded by what it read. A create is a write from `null`, a delete a write to `null`. See [One write](#one-write). |
| `move(path, next)` | The one move (ADR-0576): the file's bytes land at `next` only where nothing is, then `path` is removed only while it holds them. See [Files](#files). |
| `files` | Ordinary files at literal paths: reads, listings, and directories. See below. |
| `git` | `FolderGit` on every host: a status snapshot, `subscribe()`, `status()`, `commit()`, and `log()`. |
| `sync` | `run()` records saved files, fetches, merges both heads into one commit this device wins, and pushes; `connect(url)` sets the remote first. It asks nothing. See [Sync](#sync). |
| `id`, `own` | Which folder this is: its ID (the scope the desktop shell granted, the browser directory's name, or in Bun the directory's name), and whether it is the opening app's own, the only folder where the handle publishes its definition. |
| `definition` | The prepared definition the handle reads with: the app's own in its own folder, or the folder's own `epicenter.json` as it was read when the folder opened. Its tables are `tables`, settings among them, and Sync merges rows by it. |
| `location` | `{ kind: 'opfs', directory }` or `{ kind: 'directory', root }`. For showing to a person. File paths are never joined onto it. |
| `onFilesChanged(listener)` | Files may have changed: `listener(change)` with the paths, or `'everything'`, so read again. Never this handle's own writes. Returns the function that stops listening. See [Changes](#changes). |
| `signal`, `close()` | Closing fences the next storage call and stops network work. Git work drains before storage is released; file operations own their completion promises. It makes no commit. |

### Files

```ts
const { error: createError } = await folder.write('audio/take.webm', null, bytes);
if (createError !== null) return show(createError.message);         // Occupied if a file is there
const { data: file, error: readError } = await folder.files.read('notes/a.md');
if (readError !== null) return show(readError.message);             // file is { bytes, sha256 }
const { data: written, error: writeError } = await folder.write('notes/a.md', file.bytes, 'new text');
if (writeError !== null) return show(writeError.message);           // kept changing, say
if (written.file === null) return show('It was deleted elsewhere'); // the edit wrote nothing
const { error: moveError } = await folder.move('notes/a.md', 'notes/b.md');
if (moveError !== null) return show(moveError.message);             // Occupied if b.md is there
const { error: deleteError } = await folder.write('notes/b.md', null, null);
if (deleteError !== null) return show(deleteError.message);         // the deleter wins
```

A file's content changes only through the one write, `folder.write(path,
from, to)`, and a file moves only through `folder.move(path, next)`
(ADR-0576). `from` is the content the change started from, `null` for no
file: an editor keeps it apart from what it typed ([Editing
text](#editing-text)). A read answers the file's detached bytes and the
SHA-256 that names them.

- Strings are written as UTF-8 with nothing added or normalized. Byte arrays
  are copied when the method is called, so reusing the array afterward
  changes nothing.
- A write's answer is the file as it left it, computed from the bytes it put
  or found. Nothing is read back. If another writer lands right behind the
  write, the next write from the same `from` merges with their change. Read
  the file to observe what is there now.
- A create, a write from `null`, is placed only where no file is: a file
  already there is `Occupied`, unless it holds the same bytes, which is
  that create landed before.
- A delete, a write to `null`, removes whatever the file holds now: the
  deleter wins, and an edit of a file deleted since writes nothing and
  answers `file: null`.
- A move puts the bytes at `next` only where nothing is, so two moves onto
  one path never fuse two files, then removes `path` only while it holds
  them, carrying a write that lands there meanwhile. No file at `path` is
  `InvalidPath`, and one at `next` is `Occupied`; nothing changes. Another
  writer changing or deleting `next` while a write is carried there stops
  the move as `InvalidPath` naming `next`: the file stays at `path`, and
  `next` holds what that writer left. `KeptChanging`, or a removal that
  failed, leaves both paths holding the file, to repair. The answer is the
  file as it stands at `next`.

Internally every write and move is `put(path, bytes | null, ifMatch)` on the
storage port: a create puts where `ifMatch` is `null`, so only where no file
is; every other put names the hash its write read. Browser OPFS, the Bun
directory, and a desktop page's directory check `ifMatch` where the bytes
land.

A directory folder, in Bun or a desktop page, checks what a `put` expects
at its path where it renames a staged copy over it. On the desktop the shell makes that check and the rename under one lock
per root and the folder's save lock, and in Bun under the save lock, so no
other window's or Bun process's change lands between them. A file another
program removes between the check and the rename comes back with the new
bytes; it shows as an ordinary file and can be removed again (ADR-0533).
A directory folder reads names literally: on a case-insensitive file system,
`plan.md` does not reach `Plan.md`, and creating or moving to `plan.md`
there is `InvalidPath`. Browser folders are unaffected. OPFS opens the file without creating it
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
waiting. Commits capture regular files only. `files.read(path)` returns the
bytes, detached, without holding a file descriptor. `mkdir(path)` creates missing
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
can be saved back. `path` and `sha256` describe the read and never change.

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
too, and the body with `\n` line endings. It checks representation, not the
schema: `NaN`, a `Date`, a class instance, or a cycle is refused, each
unpaired surrogate in a string is written as U+FFFD, and `undefined` in a
mapping is an absent key. Text it writes always reads back through
`parseRow` as the row it stored. `parseRow` reads a body's `\r\n` and lone
`\r` as `\n`, so an editor shows and sends a body as a `<textarea>` reports
it ([ADR-0572](../../docs/adr/0572-a-row-body-is-read-and-written-with-line-feeds-and-storable-text.md)).

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
refuses the second as `InvalidPath`. Incoming history has its own rule and may
refuse paths a filesystem could not hold apart; see Incoming changes.

### Writing a row

A table is a typed view over the folder's one write (ADR-0576). Every row
write is `write(stem, from, to)`: the change from the row `from` to the row
`to`, merged into the file as it is now, field by field and the body by
line, and written in the standard form. The helpers build the change:

```ts
await todos.set('milk', { done: true });               // from: the row as it is now
await todos.create({ fields, body: '' }, { stem: 'milk' }); // from: no file
await todos.delete('milk');                            // no base: the deleter wins
await todos.rename('milk', 'groceries');               // a move: refused if 'groceries' is taken
await todos.write('milk', opened.row, { ...opened.row, body: 'New notes\n' }); // what a body editor sends
```

Each resolves with what the write left at the stem: the row; the file as an
`InvalidRow` or `InvalidUtf8` value, when the write merged into a file that
does not read as a row and left it to repair; or `null` when no file is
there. `isStoredRow(written)` tells the first apart. `write`, `set`, and
`create` fail as one `RowWriteError`: `InvalidValues` for a row that cannot
be written (nothing is written), or any `WriteError`. `delete` and `rename`
fail as one `WriteError`.

| Error | When |
| --- | --- |
| `InvalidValues` | a row that cannot be written; table writes only |
| `InvalidPath` | a path no file can be at, a directory included; a move from no file, or one whose copy another writer changed; on a case-insensitive disk, a name another spelling holds |
| `Occupied` | a file already under exactly this spelling where a create or a move puts one; nothing was written |
| `KeptChanging` | the file changed on every attempt; a move then leaves the file at both paths |
| `Io` | storage failed, or its reply was lost and could not be confirmed |
| `Closed` | the folder is closed |

- `set(stem, fields)` reads the row, puts `fields` over its fields, and
  writes that with the row it read as `from`. A field set to `undefined` is
  removed; a required one so removed is `InvalidValues`. Every field it does
  not name keeps another writer's value, even one that landed between its
  read and its write, and a field it names wins. A row that is not there is
  not made: `null`, and nothing is written. A file that is not a row has no
  fields to set, and is `InvalidValues`.
- `create(row, { stem? })` writes at `stem`, or a generated one, from no
  file, placed only where none is: a file already at the stem is
  `Occupied`, unless it holds this row's exact text, which is the same
  create landed before. A definition that
  cannot supply a field the folder requires is `InvalidValues`, and
  `canCreate` says so beforehand.
- `delete(stem)` removes whatever is at the stem, row or not.
- `rename(stem, next)` moves the file, row or not, as it is. Its bytes land
  at `next` only where nothing is, so two renames onto one stem never fuse
  two rows, and `stem` goes only while it holds what moved: a write that
  lands there meanwhile is carried to `next` first. No file at `stem` is
  `InvalidPath`, and a file at `next` is `Occupied`; another writer
  changing `next` during that carry is `InvalidPath`. A rename that placed
  `next` but could not remove `stem` leaves both.
- A delete beats an edit it never saw. A write over a row deleted since its
  `from` writes nothing and resolves `null`; only `create`, from no file,
  brings a row into existence. So an autosave, a retried fill, or a stale
  click never brings a deleted row back, with no check of its own.

A row that is not valid is repaired as text through the folder's write:
`folder.write(invalid.path, invalid.text, repaired)`.

### Editing a row

A person editing a field means "the title is Milk", not "here is the row as
I last saw it", so a field edit is a `set` of the row as it is now. A
component holds what a person typed in its own state until it is sent, and
sends it through the table's `set` mutation after a pause and when the
person leaves the field (see [Queries](#queries)). A checkbox or a select
sends its set at once. A relative change (`count + 1`) is not a set: a
script reads the row and writes the change from it.

A body is a whole text, so setting it would replace another writer's lines.
`createBodyEditor({ row, write })` from `@epicenter/folder/svelte` opens it.
It holds `from`, the row as the cache held it at the first keystroke, and
`typed`, and sends each save to the table's `write` mutation as the change
from `from` to `from` with the typed body, with `\n` line endings and
well-formed text. A save that lands with nothing typed since clears both. A
save that lands while typing continued makes `from` the row it sent, so the
next save changes only what was typed since; one that stayed at the first
keystroke would make a later edit of saved text a second insertion beside
it. A failed save keeps both. Saves of one file run one at a time. A save
that finds the row deleted writes nothing, and nothing is sent while the row
is gone from the cache: what is typed stays, `gone` is true, and the control
offers the text until the person copies or discards it.

```svelte
<script lang="ts">
  const note = createQuery(() => folder$.notes.get.queryOptions(stem));
  const writeNote = createMutation(() => folder$.notes.write.mutationOptions());
  const body = createBodyEditor({
    row: () => note.data ?? undefined,
    write: (change) => writeNote.mutateAsync({ stem, ...change }),
  });
  const send = useDebounce(() => body.save(), 1000);
</script>
<textarea
  value={body.text}
  oninput={(e) => { body.change(e.currentTarget.value); void send(); }}
  onblur={() => void send.runScheduledNow()}
></textarea>
```

### Editing text

The body editor is the row case of one text editor (ADR-0576).
`createTextEditor({ current, write })` opens any document's text the same
way: it holds `from`, the document at the first change, then what each save
that landed sent, and `typed`, and sends each save to `write` as the change
from `from` to `from` holding the typed text. It has no revision counter
and no merge of its own: the folder's write merges every save into the
file as it is now. A file's exact text is its plain case, written through
`folder$.write`:

```ts
const opened = createQuery(() => folder$.files.text.queryOptions(path));
const writeFile = createMutation(() => folder$.write.mutationOptions());
const text = createTextEditor({
  current: () => (opened.data?.kind === 'text' ? opened.data.text : undefined),
  write: async (change) =>
    (await writeFile.mutateAsync({ path, ...change })).file === null ? 'gone' : 'landed',
});
```

`write` resolves `'gone'` when the write found no file, which stops the
editor and marks what is typed `gone`, as for a row. A textarea reports
`\n` line endings; `withFileNewlines` from `@epicenter/folder/file-browser`
restores a file's own before the text is typed into the editor.

### One write

`folder.write(path, from, to)` is the folder's one write (ADR-0576); every
table helper calls it. `from` is the content the change started from, or `null` for no
file; `to` is the new content, or `null` to delete the file.

```ts
const { data: written, error } = await folder.write('notes/a.md', opened.text, edited);
if (error !== null) return show(error.message); // InvalidPath, Occupied, KeptChanging, Io, Closed
written.file;       // what the path holds now: { bytes, sha256 }, or null
written.overridden; // each unit this write won over another writer's change
```

1. It reads the file as it is now; no file is `null`.
2. It merges `from`, `to`, and that file with `merge(kind, { base, ours, theirs })`,
   `to` as `ours`. A result equal to the file is done, with nothing put.
3. It puts the result with `storage.put(path, bytes, ifMatch)`, guarded by the
   hash it read, or by no file. Another writer landing in between makes the
   put `'stale'`, and the write starts again from step 1, at most
   `WRITE_ATTEMPTS` times, then `KeptChanging`. A lost reply is read back once.

| File | Unit |
| --- | --- |
| a row, `<table>/<stem>.md` | one frontmatter key; one region of body lines |
| other UTF-8 text | one region of lines |
| binary, or a side absent | the whole file |

- Units only one side changed all survive. On a unit both changed, the
  writer wins, and `overridden` names it (`field`, `lines` with
  its `line` and `count`, or `file` with the side whose edit did not stand). Each overwrite is logged through `wellcrafted/logger`
  (`folder/save`); nothing is shown to a person.
- Two insertions at one place both survive, the file's first, then the
  writer's. Identical ones are one, and an insertion that holds the other at
  its start or end stands alone. Lines compare without their line feeds,
  and a result ends with a line feed as the version its last line came from.
- A row is written in the standard form, so a hand-written row loses its
  comments and quoting on its first write from an app. A row the writer left
  as `from` had it is no change, and the file keeps its spelling.
- A version that does not read as its kind merges as text, and any `to` is
  written: a raw edit of a row can leave a row to repair (ADR-0503). A typed
  table view refuses a row it cannot write before it writes (`InvalidValues`).
- A delete needs no base: `to` of `null` removes whatever is there. A delete
  beats an edit it never saw: an edit of a file deleted since its `from`
  writes nothing and answers `file: null`, and only a write from `null`
  creates a file.

Storage's `put` lands only while the path holds `ifMatch`, the SHA-256 there
or `null` for no file, and answers `'stale'` otherwise, changing nothing. The
browser, the desktop, and Bun share its one implementation: OPFS checks under
the folder's Web Lock, and a directory checks where its staged file is
renamed into place, under the save lock (ADR-0562).


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
content; read through the folder to learn what the files hold. Nothing records changes, so a missed one costs a delay, never
data. Subscribe before the first read so nothing falls between them. Closing
stops all listeners at once, including the ones still waiting in a dispatch
that a listener closed the folder from.

Each host has exactly one detector of changes made outside the handle:

| Host | Detector | Reports |
| --- | --- | --- |
| Browser | Other pages of this origin, which post the paths each write landed on a `BroadcastChannel`; and resuming from being frozen or from the back-forward cache (`pageshow` with `persisted`, the Page Lifecycle `resume`) | The paths; `'everything'` on resume. Returning to a window reports nothing. |
| Desktop | The shell's watcher of the granted directory: the folder plugin's `epicenter-folder://changed` event, `{ scope, paths }`, sent to each permitted window and filtered by this folder's scope | The paths; `null` paths as `'everything'`; `.git` when history moved |
| Bun | None; a script that needs one watches with `fs.watch` | Nothing from outside |

A handle's own writes are not reported to it: whoever wrote holds the result.
What its own Sync writes is reported on every host, since the page did not
make those changes. Every report marks the history's observations stale.

A listener runs inside the folder's work. What it throws is logged and goes
no further: the write still returns what it wrote, and the other listeners
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
const setTodo = createMutation(() => folder$.todos.set.mutationOptions());
setTodo.mutate({ stem: 'milk', fields: { done: true } });

// The app root, once: changes the page did not make mark what they name stale.
const stopChanges = folder$.invalidateOnChange(queryClient);
```

| Area | Queries (`.queryOptions()`, `.queryKey()`) | Mutations (`.mutationOptions()`) |
| --- | --- | --- |
| each table (`folder$.<table>`, and `folder$.tables.<table>`) | `list`, `get(stem)` | `set({ stem, fields })`, `create({ row, stem? })`, `write({ stem, from, to })`, `delete(stem)`; a rename is `table.rename` |
| `files` | `list`, `read(path)`, `text(path)` (the file as an editor opens it: its text, or its kind and size past 1 MiB or when binary) | none |
| the folder (`folder$`) | `query({ paths, key, queryFn })` | `write({ path, from, to })` (`folder.write`: a create from `null`, an edit, or a delete to `null`), `move({ path, next })` (`folder.move`) |
| `history` | `status`, `log(depth?)` | `saveVersion` (`git.commit`), `sync` |

`folder$.query({ paths, key, queryFn })` is a query of the page's own over
the files at `paths`, each a file or a directory: cached like the reads
above, and stale whenever a change reaches one of `paths`. A list derived
from two tables names both directories.

Each helper is its own mutation, and there is no shared one, so each
control owns its pending and error state. A query is named for its data and
a mutation for its verb and noun: `const todo`, `const setTodo`,
`const deleteTodo`, never `remove` for `.delete`.

Writes to one file run one at a time, in the order made, whichever
control or options object made them, so a checkbox's set reads the row
a title's set wrote. The options keep that order themselves, not in a
TanStack mutation scope: a scoped mutation waiting its turn resumes only
while the window has focus, and a save must not wait for the person to come
back.

A write keeps the cache in step inside its own `mutationFn`, so a caller's
`onSuccess`, `onError`, or `onSettled` adds to it and replaces nothing. It
puts its result where it can: `set`, `create`, and `write` set the row's query and
its entry in the listing, `delete` drops them, and `folder$.write` sets the
file's `read` and `text`. `folder$.write` and `folder$.move` mirror the
handle's `write` and `move` for any path, a row's included, so a row's query
and listing are marked stale when they write one. The folder does not
report a page's own writes to it, so the write marks stale the rest of what
a change to its paths would, the history's status included. A read still
running when the write lands may predate it, or a later change, so it is
read again rather than kept. A failed write reads its paths again: the
file was not what the base said, or the reply was lost.

`invalidateOnChange(queryClient)` subscribes to `folder.onFilesChanged` and
invalidates each change's `pathFilter`; it returns the function that stops
it. `pathFilter(change)`, also usable on its own to invalidate, cancel, or
refetch, matches each row at a changed path, the listing of
each table whose directory a path is in, the file listing and each changed
file's `read` and `text`, each `query` over a
changed path, and the history's status; a path in `.git` also matches the
log, and `'everything'` matches every query of the folder. Invalidating
reads again only what a view or observer holds; a store that reads with
`getQueryData` observes what it shows. A table named like a member
(`files`, `history`, `write`, `move`, `tables`, `pathFilter`, `key`,
`query`) is under `folder$.tables` only.

Every read is local and changes only when the folder's channel or the
page's own write says so, so the options set `networkMode: 'always'`, no
retry (on mount either), `staleTime: Infinity`, and no focus refetch; an app sets none of
these for the folder's queries.

`runMutation(client, options, variables)` runs a write from outside a
component, as `mutateAsync` does, through the client's mutation cache.
`whenIdle(client, filters?)` resolves once nothing matching `filters` is
mutating, counting an editor's next save that is about to start.

## History

Browser handles and directory handles, in Bun or a desktop page, follow the
same history rules.

A save returns once its files are published and never waits for Git. A commit
pins the branch head, captures every source file, writes a commit with a
subject derived from the tree difference, and moves the branch only with a
compare-and-swap. A commit whose branch moved after it pinned the head retries
once: it captures the folder again, so it records everything the lost
attempt held, over the new head. A second move is reported as `branchMoved`.
Commit and push failures never undo a save.

A save never asks for a commit (ADR-0529). A commit happens only when a caller
asks for one: `commit()`, or sync's checkpoint before it fetches. A commit that fails otherwise is reported
in `git.snapshot.lastCommit` and is not retried. `git.snapshot.files` turns
`stale` when a save lands after the last capture, and `git.status()` lists what
is uncommitted.

The browser and Bun openers use local `main`. A remote branch selects the
transfer destination; it never selects another local history. An existing
repository with `HEAD` on another branch refuses commits and incoming
adoption until its branch is deliberately reconciled.

`commit()` stays local, even with a configured remote; only Sync uploads
history. An explicit request waits for the folder's Git work and then reads
the folder, so it includes saves made while it waited. If the folder closes
while it still waits, it is told `closed` and nothing runs.

Source files are tracked files plus untracked files that `.gitignore` does not
exclude, minus every path the definition's `local` patterns match; private Git
state is never source. SQLite filenames have no special
exclusion: an intentionally saved database follows ordinary Git rules. Plain Git
records binary files like any other file. There is no default audio ignore, no
format list, and no LFS; a definition's `local` patterns are the one way a
folder ignores files of its own accord.

### Closing

`close()` fences new file work, stops change reports, refuses new Git requests, and
cancels pushes and fetches. It does not await file helpers or publication
replies. Await a write that must finish before closing:

```ts
const { error: writeError } = await folder.write('note.md', null, 'Saved before leaving');
if (writeError !== null) return show(writeError.message);
await folder.close();
```

A helper still reading or hashing can be refused at its next storage call. An
already-started change returns its actual Result, including a lost reply
(`Io` with `Unconfirmed` as its cause). Closing never relabels that outcome. A browser write that
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
and its remote together" (ADR-0576). It asks nothing:

```ts
const { data: ran, error } = await folder.sync.run();
if (error !== null) return show(error.message); // it stopped, and says why
// ran.kind: 'synced', or 'saved' when the push is not confirmed
```

`run()` records the saved files in a checkpoint commit `L` and fetches the
remote head `R`. When `R` descends from `L` it fast-forwards; when `L`
descends from `R` it pushes. Otherwise it makes one merge commit `M` with
the parents `[L, R]`, computed by Epicenter's own code on every host
(`git/merge.ts`), and pushes it before any file here changes. Each path
either side changed since the merge base is settled once, net, by the same
`merge` a save makes ([One write](#one-write)), this device as the writer
acting:

| Path | Merged by | Where both changed one unit |
| --- | --- | --- |
| `<table>/<stem>.md` of a declared table | field and body lines | this device's field or lines |
| any other UTF-8 text, or a version that does not read as its kind | line | this device's lines |
| `epicenter.json` | whole file, with `local` listing every pattern either side lists | this device's file |
| a binary file, a link, an executable, or a submodule | whole file | this device's |

A side that changed nothing leaves the other's bytes exactly as they are. A
delete beats an edit it never saw. A rename, a path one side deleted and
created elsewhere with the same bytes, carries the other side's edit to the
new path. A file against a directory keeps the directory, and the file
beside it as `<path>~local` or `<path>~remote` (`-2` and on where that name
is taken). Each unit that lost is a trailer on `M`, naming the parent that
held it, which stays reachable:

```txt
Overrode: 4f2a… field="title" "todos/buy milk.md"
Overrode: 4f2a… lines=body:12+3 "todos/buy milk.md"
Overrode: 9c1e… file "photo.bin"
```

A push that lost a race merges again from `L` against the new remote, at
most five times, then `KeptChanging`. One the remote refused without moving
stops. A push that failed otherwise still publishes `M` here and answers
`saved`, and a lost reply is found by the next fetch.

Publishing a tree over the files, for a merge or a fast-forward, checks and
writes each file holding the folder's save lock (`storage.lock`), one file
at a time, so a save waits for one file, never for the whole publish, and
its editor keeps what is typed. Each changed path takes one write, the live file as the writer acting, so text
typed after the checkpoint keeps the units it changed. Removals go first,
in one hold of the lock: each is checked against the checkpoint's bytes,
then all are made, with the directories they emptied, so a file can take a
directory's place and the reverse. Every write lands whole,
so a publish cut off partway leaves each file at its old bytes or its new
ones (ADR-0545). `refs/epicenter/publishing` names the publish, as a commit
whose parents are where the branch was and what it publishes, until the
branch moves; the next commit finishes that publish before it records the
files, so what arrived is never recorded as this device's edit. A folder that had no history before
the run adopts the remote's by merging over an empty base; one with a
history of its own meets an unrelated remote as `Unrelated`, and
`run({ allowUnrelatedHistories: true })` combines them. `connect(url)` sets
the remote, then runs ([above](#the-folder-opened-lazily-and-its-remote)).

Sync stops, and says why, only where it must not decide:

| `SyncError` | When | What was written |
| --- | --- | --- |
| `Blocked` | a merge or a rebase another Git program began (`.git/MERGE_HEAD`), a detached head, a file of this folder's own where the remote needs the path (a file it never committed, ignored or new, where the remote adds one; files where the remote needs a file), or a branch another program moved while Sync wrote | nothing sent, for a file in the way; for a moved branch, the files written are changes to it |
| `Unrepresentable` | the remote (`whose: 'remote'`) or the tree this folder would send (`whose: 'folder'`) holds a link, an executable, a submodule, an invalid path, two paths only their case tells apart, or a commit whose attributes declare a filter or a byte conversion | nothing |
| `Unrelated` | the histories share no commit | nothing |
| `KeptChanging` | the remote moved before every push | nothing |
| `Publish` | a file could not be written | what landed, whole; the next Sync finishes |
| `Checkpoint`, `Fetch`, `NoRemote`, `Closed`, `Failed` | the checkpoint, the fetch, or the transport failed | nothing |

When a file the remote removes holds an edit no commit has, publish writes
nothing, records the files again, and merges that with what it sent: the
delete wins, and the edit stays in history as a parent, named by a trailer.
`synced` means the push confirmed the head and no save landed after the
checkpoint; `saved` carries the push's own outcome and `changedSince`.

An incoming commit whose own `.gitattributes` declare a filter or a byte
conversion (`filter`, `text`, `eol`, `crlf`, `ident`,
`working-tree-encoding`) for any file in its tree is refused as
`Unrepresentable` before anything changes, including attributes in nested
files and ones the folder's current files would mask. This is refusal, not
Git LFS support: pointer-shaped text with no declared filter is ordinary
bytes. A directory folder asks `git check-attr --source`; the browser
evaluates the commit's attribute files the same way. Browser fetch uses
isomorphic-git 1.38.5, which fails when a non-default remote branch exists
but the server advertises no resolvable `HEAD`; that failure changes
nothing.

A whole-folder commit on disk records every file as plain `100644` bytes,
so it is refused in a repository it would misrepresent: symbolic links,
executables, submodules, nested `.git` data, `core.autocrlf`, or a
normalizing attribute on a source file. Reads and file saves still work.

## Declaring a folder

`defineFolder` checks the definition where it is written. `defineTable` and
`field` are the vocabulary every Epicenter storage shares
(`@epicenter/definition`). A field is any native TypeBox schema; the `field.*`
helpers build common ones. A folder refuses a table that declares a body
conversion, because a row's body is the file's Markdown text. An opener given
such a definition returns `InvalidDefinition` before it acquires anything.

`epicenter.json` holds each table as one JSON Schema object whose
properties are the fields, and `local`, when the definition declares it, as
the list of patterns. A table declared with `additionalProperties: false`
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

A definition is `{ title?, local?, tables }` and nothing else. `defineFolder`
throws on any other key, an `id` or a `kv` included, and an opener given an
untyped definition with one returns `InvalidDefinition`. Its type is `FolderDefinition`, the identity-free
`DataSchema` of `@epicenter/definition`, prepared with `prepareSchema`.

`defineFolder` returns the prepared definition. It has the shape and type of
what was declared: each table's `fields` is a record of native schemas, and a table's key is its name. Each table's type also carries the
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
| `src/folder.ts`, `table.ts`, `markdown.ts` | The handle and its interpretation of files, shared by every adapter: the handle's storage (save accounting, the close fence, and publishing the definition before the first change), and `table.ts`, the typed row view over the one write. |
| `src/changes-browser.ts`, `changes-tauri.ts` | Each host's one detector of changes made outside the handle ([Changes](#changes)). |
| `src/query.ts` | `@epicenter/folder/query`: `folderOptions`, with `folder$.write` and `folder$.move`. |
| `src/check-folder.ts`, `query-folder.ts`, `generate-declaration.ts` | What the CLI's `check`, `query`, and `generate` do, exported from the Bun entry. |
| `src/row-text.ts`, `canonical.ts` | `parseRow` and `formatRow`, and the row codec under them: the one parser and the one writer of row text. |
| `src/svelte/` | `@epicenter/folder/svelte` (`editor.svelte.ts`: `createTextEditor` and `createBodyEditor`), its tests, and the Svelte boundary tests. |
| `src/boundary.ts` | The storage port every host implements (`read`, `list`, `children`, `put`, `mkdir`, `rmdir`, and `lock` where Sync publishes), and the part of it every host shares: the path rule, owned bytes, the relay to other pages, sorted listings, holding the lock, and staged names. |
| `src/write.ts`, `hash.ts` | The one write (`writeFile`, `folder.write`) and the one move (`movePath`, `folder.move`), with the guarded put they share; and the SHA-256 that names a file's bytes. |
| `src/opfs-store.ts`, `git/opfs-git.ts`, `git/browser-backend.ts` | OPFS storage, private `.git`, and isomorphic-git. |
| `src/directory-adapter.ts` | The directory folder both the Bun entry and a desktop page open, over the storage its host gives it. |
| `src/tauri-files.ts` | A desktop page's storage: one folder plugin command per storage method. |
| `src/directory-store.ts`, `directory-primitives.ts`, `directory-node.ts` | The Bun directory's storage over seven file system calls, and those calls over `node:fs`. |
| `src/git/merge.ts`, `git/history.ts` | Sync's one merge commit as objects, and the coordinator that checkpoints, fetches, pushes, and publishes. |
| `git/native-*.ts` | The `git` program a directory folder records history with, in Bun. |
| `src/history-wire.ts`, `tauri-history.ts` | A desktop page's history: the reply line the `epicenter` CLI prints for what it runs (`runHistory` in `bun.ts`), and the page's `folder.git` over the shell's history commands. |
| `src/native/bindings.gen.ts` | Commands generated from the `tauri-plugin-epicenter-folder` crate. Internal. Do not edit. |
| `fixtures/` | Vectors the tests read: `commit-subjects.txt`, the subjects `commitSubject` in `src/git/messages.ts` writes (`bun run gen:vectors` rewrites it). |
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
repairs no references. Browser bytes are stored whole.
A whole-folder checkpoint or status scan reads and hashes the whole folder.
Version checks on disk are best effort
against other programs. File bytes cross the desktop bridge as JSON number
arrays, which is slow for large audio.

In a browser, OPFS quota exhaustion and eviction surface as the failing
step's `Io` or `Unconfirmed`; nothing reserves space. Pages of other origins or browser profiles are outside
what the Web Locks can see.


## Internal composition

Files and tables use one storage port (`boundary.ts`). The handle wraps
it once (`handleStorage` in `folder.ts`) so each `put` that may have landed
marks history stale, so a domain method cannot write without that.

```ts
createFiles({ storage })
createTable({ storage }, name, definition.tables[name])
```

`folder.write` and every table helper call `writeFile` (`write.ts`) with the
file's kind, which merges through `merge` (`merge-file.ts`), the merge Sync
and the merge driver use too; `folder.move` and `table.rename` call
`movePath`.

The same wrapper fences the storage with the handle's close signal and
publishes the definition before the first change. It retains no
file-operation collection.

Git keeps raw storage because Sync's publish updates files and history
under its own policy, each file under the save lock, and is not recorded
as local saves. Writes are not
ordered by when their methods were called; each puts guarded by the bytes
it read, so a later one reads again and merges with what landed first.
