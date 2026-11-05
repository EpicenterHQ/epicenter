# 0778. A page connects once, and then reads synchronously

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0777](0777-a-capability-has-no-ready-promise.md) at "Its reads answer at every moment, from what it has so far": a read of stored data answers after the page has connected, and nothing renders before; [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) at a collection's `loading()` staying "until listings are made per folder": they are, and it goes; [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) at a capability loading on its own: a page's stores load in one connection.
- **Relates:** [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) (every place is a store), [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) and [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (AppData and credentials), [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the web is online).
- **Unbuilt:** all of it: the connection (subscribe, snapshot, buffered changes applied by version, a rescan diffed in); one replica per folder fed by changed paths; the settings store over AppData on the desktop (the shell its only writer, pushing to every window) and `localStorage` on the web; `<WhenOpen>` waiting on the connection and showing why after a moment; deleting `loading()` on collections, choices and connections, stand-in defaults, the conversation's `ready`, `listed` and `Unlisted`, the desktop account's signed-out stand-in, and Whispering's `start()` gate; secrets read by the action that uses them, with each connection's key binding in `connections.md` and the account's identity in AppData; the server answering a snapshot in one request; a first-paint measurement at about 5,000 recordings and on a remote folder over a slow link.

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
the page connects to its folder and to this computer's settings. Each store
answers with a snapshot and then streams what changes; the page subscribes
first, takes the snapshot, and applies the changes that arrived meanwhile
by version, so nothing in between is lost or applied twice. A rescan (a
watcher that could not say what changed) is diffed into what the page holds
without showing it empty. A reload connects again.

**`<WhenOpen>` waits for the connection, and then every read of stored data
is synchronous.** Nothing that reads a store renders before it, so no read
answers a stand-in. `loading()` goes from collections, model choices and
connections, and with it the conversation's `ready`, `listed` and
`Unlisted`, the desktop account's signed-out stand-in, and Whispering's
`start()` gate. While the folder cannot be reached, the spinner says why
after a moment (`unavailable()`).

**One replica per folder, fed by the paths that changed.** The page holds
every note of the folder and the path, version and size of every other
file, never their bytes; a change re-reads only its paths. The server
answers a folder's snapshot in one request.

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
- Test stores answer a snapshot and then stream changes.
