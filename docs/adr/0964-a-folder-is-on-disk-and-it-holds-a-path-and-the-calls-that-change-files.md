# 0964. A folder is on disk, and it holds a path and the calls that change files

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at what `folder` is: it no longer has `read`, `list` or their bytes forms, and a test no longer gets one held in memory. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at the test host: its folder is on disk, as serve's is.
- **Relates:** [ADR-0943](0943-epicenters-core-invariants.md) (rule 6: Epicenter does only what needs an app's declaration or the running serve; and the file update that needs no lock), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (an action may read any file with `node:fs`), [ADR-0869](0869-a-body-is-changed-by-quoting-the-passage-it-replaces.md) (`edit`), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (an app is handed its folder).
- **Unbuilt:** All of it. `Folder` has `read`, `readBytes`, `list` and `writeBytes`; `packages/app/src/memory.ts` exists and `createMemoryContext` is exported; `folderOnDisk` lives in `packages/cli/src/disk.ts`; `Folder.path` is optional.

## Context

`Folder` does two kinds of work.

Some of it nothing else does. A write goes to a temporary file and is renamed
into place, so a reader never sees half a file. `update` and `edit` read and
replace a file without yielding, which is what lets Epicenter take no lock
(ADR-0943). A write or delete outside `data/` and `local/` throws. A new file
under `local/` is made `0600`.

The rest wraps what Bun and Node already do. `read`, `readBytes` and `list`
open and list files. ADR-0880 already lets an action read any file with
`node:fs`, and apps do: in the owner's Epicenter, far more files import
`node:fs` or call `Bun.file` than call `folder`. So there are two ways to
read a file and one way to change it.

`Folder` also has two providers. `folderOnDisk` in
`packages/cli/src/disk.ts` is what serve gives an app, and
`packages/app/src/memory.ts` holds files in a `Map` for tests. The second one
makes `Folder.path` optional, keeps `textUpdate` exported so both can share
it, and means a test runs code serve never runs: no file modes, no real
paths, no real replace.

## Decision

**`Folder` is one thing, on disk. It holds its `path` and the calls that
change a file: `write`, `update`, `edit` and `delete`. An app reads with
plain file calls.**

```ts
// change a file: through the folder
await folder.write('data/notes/today.md', text);
await folder.update('data/2026.csv', (before = 'minutes\n') => `${before}${minutes}\n`);
await folder.delete('data/notes/old.md');

// read a file: any way you like
const file = Bun.file(join(folder.path, 'data/2026.csv'));
const before = (await file.exists()) ? await file.text() : undefined;
```

- **`path` is always there.** The optional mark and the "only on a computer"
  rule go.
- **`write` takes text or bytes.** `writeBytes` goes.
- **`delete` stays.** It changes a file, so it keeps the refusal outside
  `data/` and `local/`.
- **`read`, `readBytes` and `list` go.** They are `Bun.file`, `Bun.Glob` and
  `node:fs` on `folder.path`.
- **There is one provider.** `memory.ts` and `createMemoryContext` are
  deleted, and `textUpdate` stops being an export.
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

## Consequences

- One rule replaces two habits: read with anything, change files only
  through the folder.
- A read is longer where it was `folder.read(path)`: the app joins the path
  and checks that the file exists. In the owner's Epicenter that is about
  102 calls to `folder.read`, 24 to `folder.list` and one to
  `folder.readBytes`, tests included.
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
- **Drop `delete` too, and use `unlink`.** One fewer member. A delete
  outside `data/` and `local/` would then not be refused.
- **No folder: plain file calls for writes as well.** Nothing to hand an
  app. Every app would then rebuild the safe replace, the no-yield update
  and the write limit, or go without them.
- **Keep the memory folder.** Tests stay fast and leave nothing behind. Two
  providers must then agree forever, and the one tests use is not the one
  that runs.
- **Keep `folderOnDisk` with the command's code, unexported.** An app's test
  would import a file the package does not export.
