# 0696. A page writes a repository only through its worker, over collections its app declares

- **Status:** Proposed
- **Date:** 2026-10-29
- **Relates:** [ADR-0692](0692-every-write-is-a-live-commit-on-its-parent-taken-through-the-repositorys-server.md) (the replica and the commits this API's writes become); [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md), which decides that typing is safe once it reaches the engine's database; [ADR-0694](0694-installing-an-app-is-trusting-it.md), whose manifest names an app's collections; [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (a schema interprets a note, it never refuses one); [ADR-0697](0697-all-text-merges-from-everyone.md) (a call's group lands whole, the rule `repo.commit` runs).
- **Unbuilt:** the editor and the page over the desktop and CLI hosts; a measurement of the browser's OPFS worker under typing.

## Context

Apps opened a folder through `openFolder({ tables })` in `@epicenter/folder`,
whose page owned typed input until a queue wrote it
([ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md)).
On the replica ([ADR-0692](0692-every-write-is-a-live-commit-on-its-parent-taken-through-the-repositorys-server.md)),
the first app API kept every file's text in the worker's memory (243 MB of
heap at 100,000 notes) and an editor that held unsent typing in the page
lost it when WebKit ended the worker on reload. Todos and Honeycrisp now run
on this API inside the web shell (`apps/web`).

## Decision

**An app declares its collections once, and a collection is held in page
memory whole unless it says `memory: false`.** `defineApp`
(`packages/repository/src/core/lens.ts`) maps identifier names to a path
template and a schema:

```ts
defineApp({
	todos: { path: 'todos/{stem}.md', schema: Type.Object({ title: Type.String(), done: Type.Boolean() }) },
	journal: { path: 'journal/{stem}.md', schema: Type.Object({ title: Type.String() }), memory: false },
});
```

A template is `/`-separated literals and parameters (`{stem}.md`); a
parameter never spans a `/`, and two templates of one app that could claim
one file are refused when the app is defined. Apps combined
(`combineApps`) may claim the same files: collections are views, not
permissions ([ADR-0694](0694-installing-an-app-is-trusting-it.md)).

**A blob collection names bytes, and every file that is not a note is
one.** `{ path: 'recordings/{stem}.webm', blob: true }` offers `create`
(refused at once where this device shows a file), `replace` (refused where
it shows none), `delete` and `open`, which answers a `File` typed by the
path's extension, from this device or fetched and verified first. A write
seals the bytes on this device before it stores the pointer, and is
compare-and-swap: it lands only over the blob this device saw there. The
plain file API takes bytes too: `files.create(path, text | Blob)` (a note
is text, any other file bytes), `files.replace` and `files.open`.
`attachment(repo, getPath)` in `@epicenter/svelte/repository` shows one as
an object URL. Each name becomes a SQL view on the
replica. A held collection keeps every note (exact text, fields, body,
`state`) and offers `all()` and `get(params)`, synchronous. A `memory: false`
collection keeps nothing in the page and offers `read(params)`, async;
`all()` and `get()` are type errors on it. `repo.query(sql)` reads any view.
A note is `ValidNote` or `InvalidNote` (with its `issues`): the schema
interprets, it never refuses.

**Every write is a change the worker applies to the text it holds, in one
transaction.** `create`, `patch(params, fields)` (only those keys; the rest
of the note keeps its formatting), `delete`, `write(params, text, { over })`
(exact source, merged where the note moved since `over`), and
`repo.commit(batch => ...)` for several at once, blobs included. What one
call stores is one group: it lands in one commit, once every byte it names
is on the server, or is held whole, and a batch whose change cannot apply
stores nothing. Each resolves once this device stored it, with the note's
resulting text and the revision. On a held
collection a write is projected over the stored note the way the worker will
apply it, until the change event carrying its token is heard, and dropped
if it fails. The worker keeps no file texts in memory.

**One handle per open repository outlives the worker sessions beneath it.**
`openBrowserRepository({ app, replica })` (`api/browser.ts`), or
`openLocalRepository` in Bun, returns it before the replica opens.
`repo.status()` is `opening`, `waiting`, `open`, `elsewhere` or `moved`
(with `useHere()`), `unavailable` (with `retry()`), or `closed`; while it is
not `open`, every write is refused at once and nothing is projected. Each
session starts with an ordered snapshot, and a note that did not change
keeps its object. `repo.subscribe` names the collections that changed.

**A note has one editor, shared by every view of it, and it writes every
change at once.** `openEditor(params)` (`api/editor.ts`) returns the one
`Editor` of the path: `draft()` is the note's exact text, `update(draft,
changes?)` is a keystroke, and each is sent as `write(text, { over: the text
it was typed on })`. The worker applies writes in order and merges each once
with `settle`, so a field set elsewhere merges by key and a same-line clash
is one conflict block however many keystrokes follow. While writes are in
flight the views keep the typing; once the last is answered they show the
worker's text through changes the cursor maps through. A body view shows
`bodyOf(draft)` and types through `withBody`, so body and source are two
views of one draft. The page holds only typing made with no session or after
a failed write (`failed`, with `retry()`); `close()` and `repo.close()`
report that typing as `Unsaved`, and the draft stays until `discard()`. A
delete made here ends the note's editor and drops its draft.
`@epicenter/svelte/repository` binds an editor to CodeMirror
(`editorBinding`, `<SourceEditor>`) so a change from elsewhere arrives in
place and Undo takes back only the person's keystrokes.

## Consequences

- Opening a replica of 100,000 notes took 6 to 9 ms and 0.2 MB of heap, and
  a `memory: false` page session with 200 writes took 318 ms (Bun). The
  worker absorbed about 2,800 to 4,200 writes a second at 100,000 notes, against
  the 100 a second of typing at 10 ms.
- Nothing waits for a person to choose: the editor has no paused state and
  no Keep mine or Use theirs.
- A keystroke in the instant before the page dies may be lost, never one
  before a keystroke that was kept.
- A held collection costs page memory in proportion to its notes; a large
  one must say `memory: false` and give up synchronous reads.
- Paths equal after NFC and case folding are one note, so `get`, writes and
  `openEditor` through either spelling reach it.

## Considered alternatives

- **Texts in the worker's memory:** 243 MB of heap at 100,000 notes.
- **One write in flight, with unsent typing rebased onto each answer by
  position:** positions blend letters two people typed at one point, a
  reload lost the typing above the write in flight, and a hand-off through
  `localStorage` at `pagehide` was needed to keep it.
- **A paused editor offering Keep mine or Use theirs on an ambiguous
  rebase:** unreachable once typing is never unsent while a session is open.
- **An editor per mode (body or source) with `edit-body`:** one path had two
  drafts that could not both be open.
- **A residency override when a collection is opened:** no consumer needs
  one yet.
