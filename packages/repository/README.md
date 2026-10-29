# @epicenter/repository

A repository of Markdown files that an app reads and writes on the device,
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
| `src/client/` | The replica (`openReplica`): per-file base, hash and unsent text, the position, the commit in flight, held work; its socket (`connectSocket`); the page server a worker runs (`page.ts`); blobs. |
| `src/hosts/browser/` | The browser host: a replica in this origin's private storage (`.epicenter/replicas/<id>/`), owned by one tab's worker under a Web Lock. |
| `src/bun/` | Bun adapters: SQLite, a Git store on disk, and the development server. |
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

// A new one: kept only here (url null), or synced with a server. Owner null is you.
const created = await createBrowserRepository({ app: todosApp, owner: 'grace', repository: 'todos', name: 'Todos', account: 'ada', url: 'http://127.0.0.1:8787/', headers: { authorization: 'Bearer ada' } });
```

`removeBrowserRepository({ replica })` deletes a replica from this browser.
It refuses while any of its files has not reached a server (for a
repository kept only here, every file), unless `discardUnsent: true`.

A replica's manifest names whose repository it is (`owner`, null for you),
as its address does (`/<owner>/<repository>`, `~` for you); the origin
holds one replica per owner, repository and account. A tab that opens a
replica this page has just closed waits for the page to let it go, so
leaving a repository and coming straight back opens it rather than reading
as open in another tab.

Apps do not call these directly: the web shell (`apps/web`) opens the
repository its URL names, under one lens for every first-party app, and its
Storage page lists and removes them.

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

An editor sends one write at a time, so typing made while one is in flight
lives only in the page. When the page hides or freezes, the host asks for
those drafts (`Host.leaving`) before it ends the session. The browser host
keeps them in this origin's localStorage, synchronously, since WebKit ends
a page's worker as it navigates. It also sends them, and the next session
of that replica replays them before anything else, once. Each is a write
over the text it was typed on, so one already stored merges into itself.
A draft paused on a clash is not handed over: it waits for the person.

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
}); // one transaction, one save
```

On a collection held in memory, a write shows at once: it is projected over
the stored note the way the worker will apply it (a write made over an older
text is merged, as the worker merges it), until the change it made is heard
(each send carries a token the worker's change event repeats), and dropped if
it fails.

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

- One write is in flight at a time; keystrokes meanwhile go together in the
  next. Each write is the exact text over its base, so the worker merges
  whatever reached it meanwhile, once: a field set elsewhere merges by key,
  and one clash is one conflict block, however many writes follow it.
- A clean editor follows changes from elsewhere in place. Where typing and
  the worker's change touch the same characters, autosave pauses with both
  kept (`paused`, with `theirs`) until `resolve(text)`.
- A failed write keeps the draft (`failed`, with `retry()`); a write lost
  with its session goes again in the next one. A list shows a note whose
  editor failed or paused as held, with why, never as sending.
- A delete made here (a collection's, one in a batch, or a write of no text)
  ends the note's editor and drops its draft, so nothing brings the note back.
- `repo.close()` returns only typing no write carried: a write already handed
  to the worker is stored, since a session that ends finishes the calls it
  was sent.
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

## Checks

From `packages/repository`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | Everything in the package. |
| `bun run test` | Core, server, wire, client, API and the property tests at their default seeds. |
| `B_RUNS=1000 B_STEPS=200 B_FROM=1 bun test src/sim/property.test.ts` | The property test in memory, for more seeds (`B_SEED=n` replays one). |
| `W_RUNS=200 W_STEPS=200 bun test src/sim/wire.property.test.ts -t socket` | The same over the real wire (`H_` for HTTP). |
| `bun run test:browser` | The browser host and a Svelte page on the API, in Chromium and WebKit, two profiles syncing through the dev server. |
| `bun scripts/bench-open.ts 100000` | Opening, a page session, a full catch-up and a reset at 100,000 notes. |
