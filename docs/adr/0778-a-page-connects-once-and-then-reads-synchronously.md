# 0778. A page connects once, and then reads synchronously

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0777](0777-a-capability-has-no-ready-promise.md) at "Its reads answer at every moment, from what it has so far": a read of stored data answers after the page has connected, and nothing renders before; [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) at a collection's `loading()` staying "until listings are made per folder": they are, and it goes; [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) at a capability loading on its own: a page's stores load in one connection.
- **Relates:** [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) (every place is a store), [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) and [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (AppData and credentials), [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the web is online).
- **Amended by:** [ADR-0779](0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md) at the store contract (`connect`, `Heard`, `append?`): a store has four verbs (list, read, write, watch), and connecting is the page's.
- **Unbuilt:** the server's ordered pushes (the repository's store asks `epicenter/changes` every three seconds while watched) and its answering a snapshot in one request (the page lists, then reads the notes, in two); the local speech model choice (`createNativeChoice` in `packages/transcription`), which still asks the shell after the page mounts and shows no choice meanwhile.

## Context

Every capability was made synchronously and loaded asynchronously: the
folder from disk or the server, model choices and connections from AppData
files and the keychain, the account from the keychain. The gap between the
two was managed capability by capability: `ready` promises, `loading()`,
reads that answered a stand-in (the app's default model, an empty list of
connections, a signed-out account) before the saved value was known, waits
inside actions, attempt numbers, and the conversation's `listed` and
`Unlisted`. A stand-in that code acted on was a wrong answer, not a late
one: Vocab could send a learner who had chosen their own model to the
hosted tutor, and the desktop showed a signed-in person "Sign in" for a
frame. A snapshot written into the page before it loads would go stale on
a reload, because its text is fixed when the window is built.

The folder already keeps what it shows in memory and reads it
synchronously; it listed each collection again whenever anything changed.

## Decision

**A page has one asynchronous moment: connecting to its stores.** At start
the page connects to its folder and to this computer's settings. A reload
connects again. Every store answers the same internal contract:

```ts
type FileState =
	| { path: string; version: Version; size: number; text?: string } // text where the file is not Git LFS
	| { path: string; version: null }; // gone
type Heard =
	| { paths: readonly string[] } // read these again
	| { everything: true } // the store cannot say what changed: take a new snapshot
	| { files: readonly FileState[] }; // the store already knows (the server's push)

interface Store {
	/** Answers once hearing is armed and a snapshot was taken after it. */
	connect(
		hear: (heard: Heard) => void,
		scope: { under: readonly string[] },
	): Promise<{ files: FileState[]; close(): void }>;
	read(path: string): Promise<{ bytes: Uint8Array; version: Version } | null>;
	write(path: string, bytes: Uint8Array | null, over: Version | 'absent'): Promise<{ landed: Version | null } | 'stale'>;
	append?(path: string, bytes: Uint8Array, options: { create: boolean }): Promise<'landed' | 'stale'>;
}
```

A store only says what to read again; it promises a hint arrives after the
change can be read. The page keeps order itself: reads and writes of one
path run one at a time, in the order they began, so a later read of a path
is never older than an earlier one, and paths heard while connecting are
read again once the snapshot is in. No store keeps a cursor for the page.
The server alone orders its changes, along `main`: each push names the
commit it starts from and the one it ends at, and the page applies it only
when it starts from the commit the page holds, and otherwise takes a new
snapshot; pushes to `main` are fast-forwards, so the change between two
commits is defined. The snapshot is the first message on the same
connection. A store's echo of the page's own write is read again like any
other change. A snapshot taken for `everything` is diffed into what the
page holds, without showing it empty. One conformance suite runs over every
store: arming before listing, a write outside the page heard and then read
new, and a write racing a read of the same path.

**`<WhenOpen>` waits for every store the page connects to, and then every
read of stored data is synchronous.** Nothing that reads a store renders
before it, so no read answers a stand-in. A read of a store before it has
connected throws `FolderNotOpen`, a mistake in the code that made it, so
nothing outside a page can read a stand-in either. `loading()` goes from
collections, model choices and connections, and with it the conversation's
`ready`, `listed` and `Unlisted`, the desktop account's signed-out stand-in,
and Whispering's `start()` gate. A spinner shows only after about 150 ms,
and says why when the folder cannot be reached (`unavailable()`).

**One replica per folder, fed by the paths that changed.** The page holds
the text of every file in the contract's directories that is not Git LFS,
and the path, version and size of every other file, never their bytes; a
change re-reads only its paths. A note is parsed against the contract when
its collection is first read. The server answers a folder's snapshot in
one request, kept per tree.

**This computer's settings are a store.** On the desktop they are AppData
files, and the shell is their only writer, pushing every change to every
window; on the web they are `localStorage`. A settings note that does not
read shows as invalid and never holds up the connection: an action that
needs it fails with a typed error naming it, and saving a new value
replaces the file. A settings store that cannot be reached at all fails the
open, as the folder's would.

**A secret is read by the action that uses it.** A connection's key is read
from the keychain when a request is sent, and the shell keeps it after the
first read; which endpoint a key belongs to is recorded in `connections.md`,
and the key is not. The account's identity (who is signed in, from where,
or that sign-in was refused) is a setting in AppData; its refresh token
stays in the keychain, read when a request needs it.

**What the network discovers is not a store.** The hosted model catalog, a
local server's models, and whether a session is still valid stay reads that
answer empty and fill in. An action never admits a request by checking
them: `ai.chat()` sends to the chosen endpoint, which refuses for itself.

**Actions still wait.** Code that runs outside a page, or before the
connection, calls an action, and the action waits for what it needs.

## Consequences

- No capability that reads a store has a loading phase its callers see;
  one gate covers the page.
- First paint waits for the folder's snapshot, which grows with the folder;
  it is measured at about 5,000 recordings and on a slow remote link before
  the per-collection loading paths are deleted, and if it is too slow, note
  bodies move behind a read.
- The page holds the folder's notes in memory: fine at personal scale.
- A keychain prompt comes with the first request that needs a key, and a
  refusal fails that request.
- Test stores answer a snapshot and then stream changes, and pass the
  same conformance suite as every other store.
- The desktop's echo of the page's own write costs one read.

## Considered alternatives

- **A cursor in every store** (a commit, a watcher's sequence, a counter).
  The desktop watcher has no sequence and the browser's storage no counter
  shared across tabs; ordering each path's reads and writes gives the same
  guarantee without inventing either. The server keeps its commits, inside
  its own store.
- **One wire protocol that every place serves**, so the page has one store
  client. It removes about 300 lines of page-side code for four new
  servers; Tauri's custom protocol answers a whole body and cannot stream
  the changes; a loopback port is a new way into the folder; and the rules
  that matter (a create where nothing is, a write over the version read)
  stay one implementation per place. What it would make possible, a program
  reaching a running app, ADR-0762 refuses.
- **A snapshot the desktop shell serves as a blocking script**, so the
  desktop has no wait at all. A second path to keep in order with the
  change stream, to save milliseconds the web cannot save.
