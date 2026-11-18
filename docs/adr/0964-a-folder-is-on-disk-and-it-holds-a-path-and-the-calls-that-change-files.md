# 0964. A folder is on disk, and it holds a path and the calls that change files

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at what `folder` is: it no longer has `read`, `list`, `update` or the bytes forms, and a test no longer gets one held in memory. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at the test host: its folder is on disk, as serve's is.
- **Relates:** [ADR-0943](0943-epicenters-core-invariants.md) (rule 6: Epicenter does only what needs an app's declaration or the running serve; and the file change that needs no lock), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (an action may read any file with `node:fs`), [ADR-0869](0869-a-body-is-changed-by-quoting-the-passage-it-replaces.md) (a data handle's `edit`), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (an app is handed its folder).
<!-- doc-path-check: ignore-next-line (deleted when an app became a function of its folder, ADR-0960; deleted with the memory folder, ADR-0964; moved into packages/app/src/folder.ts, ADR-0964) -->
- **Unbuilt:** All of it. `Folder` has `read`, `readBytes`, `list`, `update` and `writeBytes`; `edit`'s function must return a `value` (`EditFile` in `packages/app/src/context.ts`); `packages/app/src/memory.ts` exists and `createMemoryContext` is exported; `folderOnDisk` lives in `packages/cli/src/disk.ts`; `Folder.path` is optional.

## Context

`Folder` does two kinds of work.

Some of it nothing else does. A write goes to a temporary file and is renamed
into place, so a reader never sees half a file. `edit` reads, decides and
replaces a file without yielding, which is what lets Epicenter take no lock
(ADR-0943). A write or delete outside `data/` and `local/` throws. A new file
under `local/` is made `0600`.

The rest wraps what Bun and Node already do. `read`, `readBytes` and `list`
open and list files. ADR-0880 already lets an action read any file with
`node:fs`, and apps do: in the owner's Epicenter, far more files import
`node:fs` or call `Bun.file` than call `folder`. So there are two ways to
read a file.

There are also two ways to change a file based on what is in it. `edit`
takes a function of the current text that returns `Ok({ value, text })` or
an error, and the record layer's `write` in
`packages/app/src/markdown-records.ts` uses it to refuse with `Missing` or
`Changed`. `update` takes a function that returns only the new text;
`textUpdate` in `context.ts` builds it from `edit`. `edit` cannot be built
from `update`: a refusal would have to leave through a variable outside the
function.

`Folder` also has two providers. `folderOnDisk` in
<!-- doc-path-check: ignore-next-line (moved into packages/app/src/folder.ts, ADR-0964) -->
`packages/cli/src/disk.ts` is what serve gives an app, and
<!-- doc-path-check: ignore-next-line (deleted with the memory folder, ADR-0964) -->
`packages/app/src/memory.ts` holds files in a `Map` for tests. The second one
makes `Folder.path` optional, keeps `textUpdate` exported so both can share
it, and means a test runs code serve never runs: no file modes, no real
paths, no real replace.

## Decision

**`Folder` is one thing, on disk. It holds its `path` and three calls that
change a file: `write`, `edit` and `delete`. An app reads with plain file
calls.**

```ts
type Folder = {
  path: string;
  write(path: string, content: string | Uint8Array): Promise<void>;
  edit<T = undefined, E extends object = never>(
    path: string,
    decide: (before: string | undefined) => Result<{ text?: string; value?: T }, E>,
  ): Promise<Result<T | undefined, E>>;
  delete(path: string): Promise<void>;
};
```

```ts
// change a file based on what is in it: edit
await folder.edit('data/2026.csv', (before = 'minutes\n') =>
  Ok({ text: `${before}${minutes}\n` }),
);

// replace or remove a file without reading it
await folder.write('data/notes/today.md', text);
await folder.delete('data/notes/old.md');

// read a file: any way you like
const file = Bun.file(join(folder.path, 'data/2026.csv'));
const before = (await file.exists()) ? await file.text() : undefined;
```

- **`path` is always there.** The optional mark and the "only on a computer"
  rule go.
- **`edit` is the one call that reads and then changes.** Its function gets
  the file's text, or `undefined` when there is no file, so creating and
  changing are one call. It returns `Ok({ text })` to write, `Ok({})` to
  leave the file as it was, or `Err(reason)` to refuse, and nothing is
  written. `value` is optional and is what `edit` answers when the caller
  has something to return, as the record layer does.
- **`write` replaces without reading.** It takes text or bytes, and
  `writeBytes` goes.
- **`delete` removes without reading.** It keeps the refusal outside `data/`
  and `local/`.
- **`update` goes, with `textUpdate`.** A call
  `folder.update(path, (before) => next)` becomes
  `folder.edit(path, (before) => Ok({ text: next }))`. `update` returned the
  text it wrote; a caller that used it returns `Ok({ text, value: text })`.
- **`read`, `readBytes` and `list` go.** They are `Bun.file`, `Bun.Glob` and
  `node:fs` on `folder.path`.
- **There is one provider.** `memory.ts` and `createMemoryContext` are
  deleted.
- **`folderOnDisk` is exported from `@epicenter/app`,** so an app's tests can
  build a folder from the package they already import. Under ADR-0960 the
  command is part of that package, so this is a move from the command's
  `disk.ts` to a file the package exports.
- **A test makes a temporary directory and passes the app a folder on it.**

```ts
const dir = await mkdtemp(join(tmpdir(), 'reading-'));
const app = reading({ folder: folderOnDisk(dir) });

await app.actions.log({ minutes: 30 });
expect(await Bun.file(join(dir, 'data/2026.csv')).text()).toContain('30');

await rm(dir, { recursive: true });
```

**To change a file based on what is in it, use `edit`; never read it and
then `write`.** Reading is itself an `await`, so two calls that arrive
together both read before either writes, and one change is lost without an
error. `edit` reads, decides and replaces with nothing able to run in
between, inside serve. A writer outside serve, such as an editor, Git, an
agent writing files directly, or app code using `node:fs`, is outside that
promise, as ADR-0943 already says.

A data handle's `edit` (ADR-0869) is a narrower idea under the same word: it
replaces one quoted passage of a record's text with another. Both change
something based on what is there now; the folder's works on a whole file.

## Consequences

- One rule replaces two habits: read with anything, change files only
  through the folder, and use `edit` whenever the change depends on what is
  there.
- A read is longer where it was `folder.read(path)`: the app joins the path
  and checks that the file exists. In the owner's Epicenter that is about
  102 calls to `folder.read`, 24 to `folder.list` and one to
  `folder.readBytes`, tests included.
- Each `folder.update` call becomes an `edit` that wraps its text in
  `Ok({ text })`.
- With `read` gone and reading open to any tool, read-then-`write` is easier
  to write by accident. The guidance above is the only guard; nothing
  detects it.
- Data handles are unchanged for an app. `data.books.get` and `list` still
  read; they do it with plain file calls inside the library.
- A test exercises the folder serve uses: real paths, real file modes and the
  real replace. It writes to disk, so it is slower than a `Map`, and a test
  that does not remove its directory leaves it behind.
- A test seeds its starting files by writing them, where it passed an object
  of contents before.
- A test still cannot reach live records unless it passes the live folder.
- The edits to tests land on the files ADR-0960 already rewrites, so both
  are done in one pass.

## Considered alternatives

- **Keep `read` and `list` on the folder.** Reads stay one short call. Two
  ways to read remain, and the library keeps wrappers for what Bun does.
- **Keep `update` beside `edit`.** Appends stay a little shorter. Two calls
  then do one job, and the shorter one cannot refuse.
- **A plain `edit` whose function returns only the new text.** Shorter
  appends. A refusal then has to leave through a variable outside the
  function.
- **`edit` returning `null` to delete the file.** Sound if spelled `null`,
  but `delete` stays for removing without reading, so it adds a rule without
  removing a call. Add it when a case needs "decide, then delete".
- **A queue that lets an edit pause partway.** It brings back the lock
  machinery removed in #2649.
- **No `edit` at all, only writes.** Two appends that arrive together lose
  one, with no error.
- **Drop `delete` too, and use `unlink`.** One fewer member. A delete
  outside `data/` and `local/` would then not be refused.
- **No folder: plain file calls for writes as well.** Nothing to hand an
  app. Every app would then rebuild the safe replace, the no-yield `edit`
  and the write limit, or go without them.
- **Keep the memory folder.** Tests stay fast and leave nothing behind. Two
  providers must then agree forever, and the one tests use is not the one
  that runs.
- **Keep `folderOnDisk` with the command's code, unexported.** An app's test
  would import a file the package does not export.
