# @epicenter/repository

A repository of Markdown notes and other files that an app reads and writes on the device,
and that syncs with a server when it has one. Each device holds a replica:
the files as this device has them, in SQLite, with whatever it has not sent
yet. The server keeps the live history, merges what devices send, and
flushes it into Git, so `git clone` reads the same files.

Two rules shape everything a person sees:

- **Every conflict is text.** When two people change the same lines, or the
  same field, the server keeps one version in place and writes the other into
  the note as a labelled conflict block. Every value someone saved is in the
  shared text, and in Git.
- **Typing that the shared text does not hold stays on the device.** A note
  whose frontmatter does not parse, or that the server refuses, is saved here
  and *held*, with its reason, until it can go. Nothing typed is dropped.

## Layers

| Directory | What it is |
| --- | --- |
| `src/core/` | Pure code: hashes, trees, commit ids, the three-way merge and conflict blocks, Markdown frontmatter, the door rules every file must pass, templates and lenses (`defineApp`). |
| `src/server/` | The server as a state machine over ports (`Store`, `GitObjects`, a timer): live history, pushes answered as applied, merged or refused, catch-up, and the flush into Git. |
| `src/wire/` | HTTP and one WebSocket per device: commits, catch-ups and their answers, and every change event, in one ordered sequence. |
| `src/client/` | The replica (`openReplica`): per-file base, hash and unsent text, the position, the commit in flight, held work; its socket (`connectSocket`); the page server a worker runs (`page.ts`); blob bytes on the device (`blobs.ts`), put and opened (`bytes.ts`), and the upload track (`uploads.ts`). |
| `src/hosts/browser/` | The browser host: a replica in this origin's private storage (`.epicenter/replicas/<id>/`), owned by one tab's worker under a Web Lock. |
| `src/folder/` | The folder engine, host-free: a folder on disk as a projection of one replica (`engine.ts`), over the folder port (`fs.ts`) whose writes never destroy a save. |
| `src/bun/` | Bun adapters: SQLite, a Git store on disk, blob bytes on disk (a device's and a server's), the development server, the folder port over `node:fs`, and `epicenter sync` and `epicenter commit` (`folder.ts`, `folder-commands.ts`). |
| `src/api/` | The app API: `defineApp`, the repository handle, the editor. The package root exports it. |
| `src/sim/` | The property test and scenario tests, over the real modules, in memory and over the real wire. |

The package exports `.` (the app API), `./browser` (its browser host),
`./bun`, `./client`, `./server`, `./wire`, and `./conflict` (the conflict
block grammar, for an editor that renders blocks).

## An app's repository

An app declares its collections once. Each is a path template and a schema;
the schema interprets a note, it never refuses one.

```ts
import { defineApp } from '@epicenter/repository';
import { Type } from 'typebox';

export const todosApp = defineApp({
	todos: { path: 'todos/{stem}.md', schema: Type.Object({ title: Type.String(), done: Type.Boolean() }) },
	journal: { path: 'journal/{stem}.md', schema: Type.Object({ title: Type.String() }), memory: false },
});
```

A collection is held in page memory whole by default: every note, with its
exact text, its fields, its body and its state, read synchronously. A
collection declared `memory: false` keeps nothing in the page; it reads one
note at a time, and SQL reads the rest.

### Open it

In a browser, the repository runs in this tab's worker over a replica in
this origin. This browser's repositories are its replicas:

```ts
import { createBrowserRepository, listBrowserRepositories, openBrowserRepository, removeBrowserRepository } from '@epicenter/repository/browser';

const [first] = await listBrowserRepositories(); // { replica, owner, repository, name, account, url }
const repo = openBrowserRepository({ app: todosApp, replica: first.replica });

// A new one: kept only here (account and url both null), or synced with a server as an account (both set). Owner null is you.
const created = await createBrowserRepository({ app: todosApp, owner: 'grace', repository: 'todos', name: 'Todos', account: 'ada', url: 'http://127.0.0.1:8787/', headers: { authorization: 'Bearer ada' } });
```

`removeBrowserRepository({ replica })` deletes a replica from this browser.
It refuses while any of its files has not reached a server (for a
repository kept only here, every file), unless `discardUnsent: true`.

A replica's manifest names whose repository it is (`owner`, null for you),
as its address does (`/<owner>/<repository>`, `me` for you); the origin
holds one replica per owner, repository and account. Every session with a
server is an account's: a replica accepts a server's hello only when its
user is the replica's account, so one kept only here takes none. A tab that opens a
replica this page has just closed waits for the page to let it go, so
leaving a repository and coming straight back opens it rather than reading
as open in another tab.

Apps do not call these directly: the web shell (`apps/web`) opens the
repository its URL names, under one lens for every installed app, and
`/me` lists and removes them.

In Bun (a script, a test), `openLocalRepository({ app, replica })` opens the
same handle over a replica in this process.

### One handle for the page's life

The handle is made before the replica opens, and outlives every worker
session beneath it: the page hiding and showing again, or another tab taking
the replica (Use here), ends a session and starts the next. `repo.status()`
says where it stands: `opening`, `waiting` (another tab's worker has not let
go), `open`, `elsewhere` or `moved` (with `useHere()`), `unavailable` (with
`retry()`), or `closed`. While it is not `open`, every write is refused at
once and nothing is projected. Each new session starts with an ordered
snapshot; a note that did not change keeps its object, so a list keyed by
identity does not redraw it.

Typing has one home, the worker's database. An editor writes every change
the moment it is made, so a page holds only what it shows: typing is safe
once it reaches the worker. Only a keystroke in the instant before the page
goes (a crash, or a reload WebKit ends before its worker reads the last
message) may be lost, and never one before a keystroke that was kept.

`repo.subscribe(listener)` is the one way to hear that anything changed: it
names the collections whose notes changed, and whether the status did.
`repo.close()` returns the drafts editors could not save, for the caller to
keep or drop.

### Read

```ts
const todos = repo.todos.all(); // every note, ordered by path; the same array until one changes
const milk = repo.todos.get({ stem: 'milk' });
if (milk?.valid) console.log(milk.fields.title, milk.body, milk.state.status); // 'synced' | 'sending' | 'held'
else if (milk) console.log(milk.issues); // its fields as written, and why they do not fit

const day = await repo.journal.read({ stem: '2026-10-29' }); // memory: false
const recent = await repo.query<{ stem: string }>('SELECT stem FROM journal ORDER BY stem DESC LIMIT 20');
```

A note is a discriminated union: narrow on `valid` once (`ValidNote`,
`InvalidNote`). Paths equal after NFC and case folding are one path, so
`get({ stem: 'Milk' })` finds `todos/milk.md`, and every write and editor
through either spelling reaches the one note.

### Write

Writes are changes the worker applies to the text it holds, one transaction
each, and resolve once this device stored them, with the note's resulting
text and the revision.

```ts
await repo.todos.create({ stem: 'milk' }, { fields: { title: 'Milk', done: false }, body: 'Two litres' });
await repo.todos.patch({ stem: 'milk' }, { done: true }); // only this field; the rest of the note stays
await repo.todos.write({ stem: 'milk' }, text, { over: before }); // exact source, merged where the note moved since `before`
await repo.todos.delete({ stem: 'milk' });
await repo.commit((batch) => {
	batch.todos.patch({ stem: 'milk' }, { done: false });
	batch.todos.delete({ stem: 'bread' });
}); // one transaction, one group: it lands in one commit or is held whole
```

On a collection held in memory, a write shows at once: it is projected over
the stored note the way the worker will apply it (a write made over an older
text is merged, as the worker merges it), until the change it made is heard
(each send carries a token the worker's change event repeats), and dropped if
it fails.

### Every file, by its path

Collections are typed views of files, not permissions
([ADR-0694](../../docs/adr/0694-installing-an-app-is-trusting-it.md)): every
handle also has the plain file API, `repo.files`, over every file of the
repository, in a collection or none.

```ts
const listed = await repo.files.list(); // [{ path, state }], ordered by path
const waiting = await repo.files.waiting(); // only those not yet synced: sending, or held with why
const readme = await repo.files.read('README.md'); // { path, text, state } or null, by any spelling of the path
await repo.files.create('plans/trip.md', 'Go north\n');
await repo.files.write('plans/trip.md', next, { over: before });
await repo.files.delete('plans/trip.md');
const opened = await repo.files.openEditor('README.md'); // the one editor of its exact text
await repo.commit((batch) => {
	batch.files.write('plans/journey.md', text);
	batch.files.delete('plans/trip.md');
}); // a rename: one transaction
```

A write to a path a collection keeps in memory shows there at once, as that
collection's own write would. A subscriber hears `files: true` when any
file changed, and `revision()` moves, so a listing re-runs.

### Blobs: every file that is not a note

The file-type rule: a Markdown file (`.md` in any case) is a note and
merges; **every other file is a blob**, kept in the repository as a Git LFS
pointer whose oid is the bytes' SHA-256. `.gitattributes` is the same in
every repository (`ATTRIBUTES`, `core/door.ts`): every file through LFS,
notes and itself back to text. An app names its blob paths, as it names
notes:

```ts
export const whisperingApp = defineApp({
	recordings: { path: 'recordings/{stem}.md', schema: Type.Object({ title: Type.String() }) },
	audio: { path: 'recordings/{stem}.webm', blob: true },
});

const { data, error } = await repo.audio.create({ stem }, blob); // { oid, size, text, revision }: sealed here, works offline
await repo.audio.replace({ stem }, other);
const { data: file } = await repo.audio.open({ stem }); // a File typed audio/webm, from here or fetched and verified first
await repo.audio.delete({ stem });

await repo.files.create('photos/beach.png', picked); // the plain file API takes bytes at any path
const { data: photo } = await repo.files.open('photos/beach.png');
```

```svelte
<script lang="ts">
	import { attachment } from '@epicenter/svelte/repository';
	const audio = attachment(repo, () => `recordings/${stem}.webm`); // one object URL per use, revoked on change and destroy
</script>

{#if audio.current.status === 'here'}<audio src={audio.current.url} controls></audio>
{:else if audio.current.status === 'fetching'}Loading audio
{:else if audio.current.status === 'unavailable'}<button onclick={audio.current.retry}>Retry</button>
{:else}Audio not found{/if}
```

**One rule for blob writes, compare-and-swap** (`settlePointer`,
`core/settle.ts`, on the server and in the replica's rebase): a write lands
only where the path still holds the blob its writer saw, which the engine
takes from the commit's parent; apps never pass it. A create expects no
file (`Exists` at once if this device shows one), a replace expects one
(`NotFound` if not). A create or replace that does not land is held with
why ("a file with this name was just added elsewhere", "this file changed
on another device"): its person keeps theirs under another name or
discards it. A delete that does not land leaves the file, as a lost delete
of a note does.

**A call's group lands whole** ([ADR-0697](../../docs/adr/0697-all-text-merges-from-everyone.md)).
What one call saves goes in one commit or not at all, blobs included: a
note saved in one `repo.commit` with a new blob waits for its upload, and is
held with it if the blob is refused. A person attaching an image and then
naming it in a note makes two calls, so the note goes at once. A blob
rename (a delete plus a write of the same pointer, in one batch) is atomic
and waits on nothing, since the bytes are already there.

```ts
await repo.commit((batch) => {
	batch.recordings.patch({ stem }, { title: 'Heard' });
	batch.audio.create({ stem }, blob); // sealed before the batch is stored
	batch.files.create('photos/beach.png', picked);
}); // one group: in one commit once every byte is on the server
```

A `git push` is taken only while Git holds every live edit, so it saw the
current bytes of every blob it adds, replaces, moves or deletes.

**A pointer never names bytes its level cannot reach:**

| Level | What holds |
| --- | --- |
| Device | `put` checks the size against the server's blob limit (from its hello), seals the bytes into this device's store (hashed while written), and only then stores the pointer. A pointer whose bytes the server does not hold yet is *owed*: saved here, out of every commit, `sending` with "its bytes are uploading". |
| Upload track | `startUploads` sends owed bytes through the LFS batch API, beside the commit flow: bytes the server holds are marked present, an upload action PUTs the store's `Blob`, then the pointer goes in the next commit. A refusal holds every pointer naming those bytes, with why (too large, over the quota, or on neither side); failures go again after a doubling wait. It runs in the browser's worker and in `openLocalRepository` (given an `lfs` client). |
| Server | Presence (`uploads`, oid and size) is recorded only once the bytes are durable in its byte store; a pointer is admitted only at its size (`blob-missing`). Uploads are bounded by `limits.blob` (2 GiB) and `limits.quota` (10 GB). |

Two byte ports, apart: a device's `BlobStore` (`client/blobs.ts`: memory,
OPFS in the browser, `createFileBlobStore` in Bun) names bytes by sealing
them, and `seal(stream, { expect })` stores nothing for bytes that are not
the ones expected, so a download is verified before it is kept. A server's
`LfsStore` (`server/lfs-store.ts`: memory, `createFileLfsStore` at
`<repo-dir>/epicenter/blobs/<oid>`, and an R2 adapter not deployed yet)
is told the oid and size and keeps only bytes that are them, never
overwriting. Each passes its conformance checks.

The wire serves the Git LFS routes with the same authentication as every
route (a reader downloads only): `POST /info/lfs/objects/batch` (basic
transfer, SHA-256; per-object 422 past the blob limit, 507 past the quota,
404 for a download of bytes not here), `PUT /lfs/objects/<oid>` (streamed
into the store, never buffered: a 1 GiB PUT peaked at 90 MiB of server
RSS), and `GET /lfs/objects/<oid>` (immutable). Every request body has one
deadline, the timeout plus its declared length at `WireLimits.minRate`.
The client follows whatever `href` a batch answer gives, so a server that
presigns direct uploads needs no client change.

Nothing evicts bytes yet. An eviction policy (a later phase) must keep every
oid the replica owes: those bytes exist only on this device until the
server holds them. Bytes produced natively (a desktop recording) will be
sealed where they are produced, behind the same store contract.

### Edit a note's text

`openEditor(params)` returns the one editor of a note, shared by every view
of it. It owns what the person types: the draft (the note's exact text) and
the last text the worker confirmed it was made over.

```ts
const opened = await repo.todos.openEditor({ stem: 'milk' });
if (opened.error === null) {
	const editor = opened.data;
	editor.update(nextText); // the person typed; a view passes its own change set too
	editor.subscribe(({ replaced, typed }) => {}); // the draft changed from outside, or in another view
	await editor.close(); // this view is done: saves, or reports Unsaved and keeps the draft
}
```

- Every change is written at once, as the exact text over the text it was
  typed on, and the worker applies the writes in order, merging each with
  whatever reached it meanwhile: a field set elsewhere merges by key, and one
  clash is one conflict block, however many keystrokes follow it. Nothing
  waits for the person to choose; a clash is text, resolved by editing it.
- While writes are in flight the views keep the typing; once the last is
  answered they show what the worker holds, through changes the cursor maps
  through. A clean editor follows changes from elsewhere in place.
- What the page holds that the worker does not is typing made while no
  session is open, or after a failed write (`failed`, with `retry()`): it is
  shown, and written once a session opens or `retry` asks. A write lost with
  its session goes again over the text the worker holds, when that is one
  the editor sent. A list shows a note whose editor failed as held, with
  why, never as sending.
- A delete made here (a collection's, one in a batch, or a write of no text)
  ends the note's editor and drops its draft, so nothing brings the note back.
- `repo.close()` returns only typing no write carried (typing made with no
  session, or after a failure): everything else is in the worker already.
- A body view shows `bodyOf(editor.draft())` and types through
  `withBody(draft, body)`, so a note's body view and source view are two
  views of one draft.
- `openEditor` right after `create` opens over the created note: it waits for
  the unanswered writes to any spelling of the path, at most the replica's
  request timeout (`EditorError.Unanswered` after that, with the write still
  going), then opens under the spelling this device keeps. While the
  repository is not open it answers `EditorError.Unavailable`.

`@epicenter/svelte` binds an editor to CodeMirror (`editorBinding`,
`createEditorView`, `<SourceEditor>`), so a change from elsewhere arrives in
place, the cursor stays where the person was typing, and Undo takes back
only their keystrokes.

## A folder on disk

A folder is the desktop's front end of the same engine the browser runs
(ADR-0695, as amended by ADR-0697): a projection of one replica, kept by
`src/folder/engine.ts`. Two directions, one rule each.

- **Out.** When the replica's text for a path changes, the engine writes it
  to the file, but only over bytes it wrote itself: the file must still
  hash to what its record says. A file that differs holds a save the
  engine has not read, and it reads that first.
- **In.** A file whose bytes differ from the record is a save: a Markdown
  file a `write` over the text the engine last wrote there, any other
  file a blob write (sealed into the device store, uploaded by the upload
  track) expecting the pointer it last wrote, a missing file a delete.

Both are one function, `reconcile(paths, call)`. Watcher events, the
startup scan, the scan after a dropped event, the periodic scan and
`epicenter commit` run it over different paths. `call` says only how the
saves it finds are grouped:

- `'each'`: each save is its own call, so a note never waits on someone
  else's upload. A vanished path and an appeared one with equal bytes are
  one rename, one group.
- a message (`commit -m`): every save is one group with the message. It
  lands in one commit or is held whole (ADR-0697).

Events are hints. A file whose hash equals the record is nothing, so the
engine's own writes never come back as saves. A file modified within the
last quiet window (150 ms) is read once it has been still for one, so an
in-place save is never read half written.

**The write.** The folder port's `replace` and `remove` capture by rename:
whatever is at the path is renamed into `.epicenter/tmp/` at that
instant, and the new bytes are linked into the empty path. The link fails
when an editor created the file meanwhile, and the editor's file stays. That
writer found the path empty, so its file is read as a create, merged with
what the replica shows, never as a save over the captured bytes it never
saw. What was captured is read once it has been still for a quiet window (a
writer still holding the file open writes into it, and an in-place save
caught between its truncate and its bytes is not read half written), then
compared with the record: the engine's own bytes are dropped; anything else
is a save that raced, and goes in as one.

**The record.** `"epicenter/disk"` sits in the replica's database. Per
path it keeps the bytes' SHA-256, their size, mtime and inode, when they
were recorded, and the text (a note's, or a blob's pointer). A save's
record and the replica's change commit in one transaction. Each write is
journaled before it happens (`"epicenter/displaced"`), so a crash is
recovered without reading the engine's own file as a save, or an empty
path as a delete. A scan skips hashing a file whose size, mtime and inode
match its record, unless it was modified within 2 s of being recorded
(Git's racy rule). It finds deletes as records no file answered.

**What it leaves alone.** A path with any segment starting with `.` is
never read or written. Neither are editor droppings that persist under
names a person could not mean (`DROPPINGS`): `name~`, `4913`, `#name#`,
`~$name`, JetBrains' `___jb_tmp___` and `___jb_old___`, `.part`,
`.crdownload`. Symlinks and other files that are not regular are held
(never followed), and so is a `.md` file that is not UTF-8, until it is
saved readable: the engine's `held()` names each with why, and nothing is
sent. A valid text the door refuses goes in and is held by the replica with
the door's reason.

**Spellings.** The repository folds paths (NFC and case); a case-sensitive
disk does not. A file whose path folds to another file's in the folder is a
save the repository cannot take: it is held, "another file has this name
in different letters", until the person renames one, and the engine never
writes such a pair itself; it waits until the other file is gone. On a
case-insensitive file system the two spellings are one file, named by the
spelling the engine knows. The replica keeps one row per folded path,
spelled as `main` spells it, so the folder takes `main`'s spelling as the
engine projects.

### Identity and place

```txt
<folder>/.epicenter/repository                its identity: repository (owner/name or null), server, account, replica id, agent
<data>/replicas/<replica id>/replica.sqlite   the replica and the record, held with locking_mode = EXCLUSIVE
<data>/replicas/<replica id>/objects/         the device's blob bytes
```

`<data>` is `EPICENTER_DATA_DIR`, else `~/Library/Application
Support/so.epicenter`, as the desktop resolves it. The replica lives
outside the folder, so a folder inside a file-syncing service never syncs
a live SQLite file, and a folder may be moved or renamed. One engine holds
a replica: a second (a running `sync`, another `commit`) is refused, and a
crash releases it. A folder that is a copy of another (same replica id,
the original still there) is refused until `--join` makes it new. The
identity holds no secret: the token is `--token` or `EPICENTER_TOKEN`.
`listRepositoryFolders(root)` lists the children of `EPICENTER_FOLDER_DIR`
(else `~/Epicenter`) that hold an identity. Others, the desktop's
reverse-DNS app folders among them, are left alone.

### `epicenter sync` and `epicenter commit`

```sh
bun run epicenter -- sync ~/Epicenter/home --join me/home --server http://127.0.0.1:8787/ --token ada
bun run epicenter -- sync ~/Epicenter/home            # later: the identity says what it is
bun run epicenter -- sync /work/home --join wong/home --server https://... --agent claude --once
bun run epicenter -- commit /work/home -m "Summarize October's notes"
```

`sync` catches up, scans, then watches until a signal, letting what is in
flight finish (5 s). With `--once` it sends everything and exits. `commit
-m` runs before connecting: every difference from the record goes to the
replica as one group carrying the message. Then it connects and waits for
the verdict. A commit with a message is never amended by a later save.
`--agent <name>` only labels the author: it is the commit's device, so
conflict blocks read `alice/claude`, and the flushed Git commit names it
in `Epicenter-Device`.

| Exit | Line (`--json`: one JSON value per line) | Meaning |
| --- | --- | --- |
| 0 | `{"landed": "<id>", "conflicts": [...]}` | One commit; `conflicts` names files where its merge wrote a conflict block |
| 0 | `{"unchanged": true}` | Nothing differed from the record, and nothing was unsent |
| 2 | `{"held": [{"path", "reason"}], "commit": "<id>" \| null}` | Nothing landed; the group and its message are held; the files are as left |
| 2 | `{"pending": "<id>" \| null}` | Offline, or no verdict yet; the next `commit` or `sync` sends it, once |
| 1 | `{"error": "..."}` | Usage or environment: not a folder, held by another engine, a copy |

Before its verdict, `commit` names any file in the folder the repository
cannot take (`{"held": [...], "commit": null}`); the commit goes without
it. `sync` also prints `joined`, `caught-up`, `held` and `stopped`.

### The desktop, later

The desktop's `epicenter` sidecar runs one `epicenter sync` per folder
under the root (`listRepositoryFolders`), from `@epicenter/repository/bun`
(`openFolderEngine`, `syncFolder`, `commitFolder`). Its windows reach the
same replica through that process with the page protocol `servePage`
speaks (`api/local.ts` is the in-process form), never a second engine over
the same folder: the replica's lock refuses one. That change replaces
`packages/cli`'s Git `sync`, `clone`, `status`, `history` and
`save-version` (ADR-0546, over `@epicenter/folder`) in one step, so no
build ships two engines behind one command name.

## The development server

```sh
bun packages/repository/scripts/serve.ts /tmp/notes.git --origin http://127.0.0.1:5175
```

It serves one repository, named after its directory (`notes`, or
`--repository <name>`), at `http://127.0.0.1:8787/`, keeps live history in
`<dir>/epicenter/live.sqlite`, and flushes it into the bare Git repository a
minute after the last change (at once on Ctrl-C). Each `--origin` lets an
app's page call it. Anyone is the owner their `Authorization: Bearer <name>`
names: development only. In the web shell, open
`/<owner>/<name>?server=<url>` (any owner: this server does not check it)
and enter any name to sync as.

### One-shot writers over HTTP

A script or an agent without a replica writes over HTTP. Every text writer
merges by the same rule ([ADR-0697](../../docs/adr/0697-all-text-merges-from-everyone.md));
the one exception is HTTP's conditional file write, which is refused (412,
`file-moved`) when the file is no longer at the hash it names:

```sh
curl -i -H 'authorization: Bearer ada' http://127.0.0.1:8787/files/notes/trip.md
# etag: "<hash>"   epicenter-commit: <commit>
curl -X PUT -H 'authorization: Bearer ada' -H 'if-match: "<hash>"' --data-binary @trip.md http://127.0.0.1:8787/files/notes/trip.md
```

To have a write merged instead, post a live commit on the commit the read
named (`POST /commits`): its parent is the `epicenter-commit` header, its
id is `commitId` (`core/commit.ts`) of the rest, and its author is the
session's user. The answer is `applied` or `merged`, with `main`'s text for
each path it touched. A parent older than the server's retention window
(10 minutes) is answered `outcome-unknown`: read again and post anew.

## Checks

From `packages/repository`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | Everything in the package. |
| `bun run test` | Core, server, wire, client, API and the property tests at their default seeds. |
| `B_RUNS=1000 B_STEPS=200 B_FROM=1 bun test src/sim/property.test.ts` | The property test in memory, for more seeds (`B_SEED=n` replays one). |
| `W_RUNS=200 W_STEPS=200 bun test src/sim/wire.property.test.ts -t socket` | The same over the real wire (`H_` for HTTP). |
| `F_RUNS=500 F_STEPS=200 bun test src/sim/folder.property.test.ts` | The folder engine's property test (`F_SEED=n` replays one, `F_TWINS=0` turns case twins off). |
| `bun test src/bun/folder.matrix.test.ts` | Each recorded editor save pattern, and the installed vim and nvim headless, against a live engine on the real file system. |
| `bun scripts/folder-race.ts` | Saves destroyed by a naive write, capture by rename, and atomic swap, racing an editor for 60 s each. |
| `bun scripts/bench-folder.ts --notes 100000` | Cold and warm scans, peak RSS, database size, and a 1,000-file commit. |
| `bun run test:browser` | The browser host and a Svelte page on the API, in Chromium and WebKit, two profiles syncing through the dev server. |
| `bun scripts/bench-open.ts 100000` | Opening, a page session, a full catch-up and a reset at 100,000 notes. |
| `bun scripts/bench-lfs-put.ts` | The Bun server's RSS while a PUT streams in (1 GiB to a hashing store that keeps nothing, 256 MiB to the file store). |
| `bun scripts/bench-blobs/put.ts 256` | A browser worker's PUT of an OPFS `File`, in Chromium and WebKit: its time and the browser's peak memory. |
