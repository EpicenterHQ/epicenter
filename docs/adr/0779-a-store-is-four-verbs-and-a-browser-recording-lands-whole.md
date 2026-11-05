# 0779. A store is four verbs, and a browser recording lands whole

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) at the store contract (`connect`, `Heard` with `paths`, `everything` and `files`, and `append?`): a store has four verbs, and connecting is the page's; [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at "append where they can" and "A file collection appends where its store can": no store and no collection appends.
- **Relates:** [ADR-0780](0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md) (a guarantee that needs a process outliving the page is the installed app's), [ADR-0769](0769-svelte-reads-every-capability-through-one-reactive-copy.md) (a capability read through `subscribe`).
- **Amended by:** [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) at where a browser recording lands: in the team's repository.
- **Amended by:** [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) at a take landing whole in the folder: its note does, and its audio lands where the person keeps audio.

## Context

ADR-0778's store answered a snapshot from `connect` and told the page what
changed in three shapes: paths to read again, "everything" when it could
not say, and file contents when it already had them. `append` was optional,
because only this browser's storage had it, for one use: writing a
recording while it records. Both put the page's work into the store. A
snapshot is a listing and a read; contents in a change only save the read
that follows; an optional verb makes every caller ask whether it is there.

`append` existed because the browser's recorder kept a take through a
crash or a closed tab: it wrote each second into this browser's storage as
it arrived, held a Web Lock per take, and on the next open cut a
half-written MP4 or WebM back to its last whole piece (`repairAudio`) and
finished it. On the desktop the shell records, and it outlives the page: it
places a take itself when the page reloads or closes. The browser's
machinery imitated that process.

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

**A browser recording lands whole.** The page's recorder keeps a take's
pieces in memory, as `MediaRecorder` hands them over, and at Stop writes
the take once with `set`; its duration comes from its own clock. While a
take runs, the leave guard asks before the page closes. A take a crash or a
closed tab cuts off is lost; keeping one through that is the desktop app's
(ADR-0780).

## Consequences

- Four verbs, one conformance suite, and no question of whether a store
  can do something.
- `append`, the file collection's `append`, and the browser recorder's
  streaming writes, locks, recovery and container repair go.
- A change costs a read after its hint, even where the place had the
  contents.
- A browser take is in memory until Stop.
