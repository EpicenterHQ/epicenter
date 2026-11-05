# 0779. A store is four verbs, and a recording is its own writer

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) at the store contract (`connect`, `Heard` with `paths`, `everything` and `files`, and `append?`): a store has four verbs, and connecting is the page's; [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at "append where they can" and "A file collection appends where its store can": no store and no collection appends.
- **Relates:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (programs meet in shared places), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (`.epicenter/` holds unfinished writes), [ADR-0769](0769-svelte-reads-every-capability-through-one-reactive-copy.md) (a capability read through `subscribe`).
- **Unbuilt:** all of it: the four verbs on every store and the conformance suite over them; the page composing the connection from them; `read` of many paths in one request on the server; deleting `append` from stores, `FolderFiles` and the recorder's use of `folder.audio`; the browser recorder's own worker writing to `.epicenter/recordings/` and moving the file into place.

## Context

ADR-0778's store answered a snapshot from `connect` and told the page what
changed in three shapes: paths to read again, "everything" when it could
not say, and file contents when it already had them. `append` was optional,
because only this browser's storage had it, for one use: writing a
recording while it records. Both put the page's work into the store. A
snapshot is a listing and a read; contents in a change only save the read
that follows; an optional verb makes every caller ask whether it is there.
The desktop shell already records into `.epicenter/recordings/<path>` and
moves the finished file into place, as a writer of its own.

## Decision

**A store is a place, and it has four verbs.**

```ts
interface Store {
	list(under: readonly string[]): Promise<{ path: string; version: Version; size: number }[]>;
	read(paths: readonly string[]): Promise<({ path: string; bytes: Uint8Array; version: Version } | { path: string; gone: true })[]>;
	write(path: string, bytes: Uint8Array | null, over: Version | 'absent'): Promise<Version | null | 'stale'>;
	/** Answers once it is listening; then calls `changed` with the paths that changed, or 'all' when it cannot tell. */
	watch(changed: (paths: readonly string[] | 'all') => void): Promise<() => void>;
}
```

Every place has all four, and nothing is optional. A store knows nothing of
contracts, notes, or what a page holds. `read` takes many paths, so the
server answers a folder's contents in one request.

**Connecting is the page's.** The folder starts watching, lists, reads the
text it holds, and then reads again, one path at a time, every path heard
in between. `'all'` is answered the same way every time: list, compare each
version with what the page holds, and read what differs. The order of each
path's reads and writes is the page's (ADR-0778).

**The folder is an external store over the place.** Its reads are
synchronous and its `subscribe` tells a listener they may answer
differently; Svelte reads it through `createSubscriber` (`reactive`), React
through `useSyncExternalStore`, plain code through `subscribe` and its
reads. Nothing above the folder talks to a store.

**A recording is its own writer.** No store and no collection appends. The
browser's recorder writes the recording in its own worker to
`.epicenter/recordings/<path>` in this browser's storage, as the desktop
shell does on disk, and at Stop moves the file into place under the same
per-path lock the folder's worker takes, and says so on the channel the
folder hears. The folder hears a finished recording as it hears any change.
A recording a closed page cut off stays in `.epicenter/recordings/` until
the next open finishes it.

## Consequences

- Four verbs, one conformance suite, and no question of whether a store
  can do something.
- `append`, the recorder's use of the folder for it, and the file
  collection's `append` go.
- The recorder and the folder are two writers of one place, as the desktop
  shell and the page already are.
- A change costs a read after its hint, even where the place had the
  contents.
