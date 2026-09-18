# 0344. An epicenter owns one data session, and opening it is a verb

- **Status:** Superseded by [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md) at its mechanism. What stands is the title: an epicenter owns one data session, opening it is a verb, construction acquires nothing, and a store cannot end itself. What is withdrawn is every shape below. `open()` is synchronous and answers a `DataSession` value rather than a promise; the four-state `EpicenterState`, `state`, and `onStateChange` are deleted; `eraseReplica` moved onto the session as `erase`. The states this record argued a surface should switch on are branches of one settled promise now: pending is `{#await}`, refused is its `error`, ready is its `data`, and there is no `closed`, because a caller holding the session is holding the thing that has it.
- **Date:** 2026-09-03
- **Amends:** [ADR-0339](0339-an-application-creates-one-epicenter-and-an-account-is-what-adds-a-store.md) at "`data` is a lazy getter that memoizes". The one-handle, one-store, five-noun, and store's-own-error decisions stand; what is withdrawn is the property that starts an open when it is read, and the memo that made a failure permanent for the life of the page.
- **Relates:** [ADR-0340](0340-an-opened-store-knows-its-own-address-and-its-own-connection.md) (a store cannot end itself, which is what makes the session the owner), [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md) (a page lifetime is one auth generation), [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md) (why a second open of one document is refused), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md)

## Context

`epicenter.data` was a property. Reading it claimed a Web Lock, opened
IndexedDB, hydrated a Yjs document, fetched a generation over the network when
the device held none, dialled a WebSocket, and registered a page-hide listener.

Property syntax cannot say any of that. Three costs followed, and each one was
live in this repository.

**An application could not say when acquisition happened.** The open began at
whatever moment something first read `epicenter.data`, which was a render, and
`fromEpicenter` had to be written around that: it read the property inside a
getter, guarded by a `started` boolean, with a comment explaining why writing a
signal there would be unsafe. Anything that spread the handle claimed a lock,
so the Svelte adapter forwarded property DESCRIPTORS rather than spreading,
also for that reason.

**A failure was permanent.** The promise was memoized, so the answer to
`AlreadyOpen` was the same `AlreadyOpen` for the life of the document, and the
only repair Honeycrisp's gate could offer was `location.reload()`. Two of the
failures a person actually meets are repaired by the world changing rather than
by the page changing: the other window closes, the network returns. Reloading
to re-ask is a workaround for the memo, not a repair for the failure.

**`close` had to be terminal**, and said so, because a handle that forgot its
open would open a second store. That was a property of the memo rather than of
the resources: closing already releases the lock, the socket, the listener, and
the document, and the existing tests already proved a second handle opens
straight afterwards.

Underneath, `StoreError.AlreadyOpen` was answering four unrelated questions.
`claims.ts` returned it when another context held the lock, when
`navigator.locks` was missing, and when the lock request threw; `writeGeneration`
returned it when an address already held bytes. Honeycrisp's boot gate switches
on that name to tell a person "Another Honeycrisp window already has these notes
open. Close it, then try again." Three quarters of the people who reached that
sentence had no other window open.

## Decision

**An epicenter owns one data session. Construction is inert, `open` is the verb
that acquires, and `state` is what a surface renders from.**

```ts
type EpicenterState<TDefinition> =
	| { status: 'closed' }
	| { status: 'opening' }
	| { status: 'ready'; data: ReplicaData<TDefinition> }
	| { status: 'failed'; error: DataOpenError };

epicenter.state                // the snapshot, reading it acquires nothing
epicenter.open()               // Promise<Result<ReplicaData<T>, DataOpenError>>
epicenter.onStateChange(fn)    // () => void
epicenter.close()              // Promise<void>
```

**`state` and the `Result` are two channels for one fact, and they have to
agree.** A close that lands mid-open ends what that open acquired, publishes
`closed`, and answers the caller who awaited it with
`DataSessionError.SessionClosed` rather than `Ok` over a store whose every verb
throws. `DataSessionError.OpenerThrew` is the other half: the opener resolves a
`Result` and contains its own throws, and a promise that breaks that contract is
contained here rather than left to wedge the session in `opening` with no way
back.

**`createEpicenter` claims no Web Lock, touches no IndexedDB, and makes no round
trip.** An application calls `open` once, from its root, after authentication is
ready. Honeycrisp calls it from `routes/+page.svelte` rather than the layout,
because the layout also wraps `/auth/callback`, which must pass through
acquiring nothing.

**Repetition is deterministic, and each case is a different answer.** While
`opening`, callers join the one attempt. While `ready`, `open` resolves the open
store and acquires nothing. While `failed`, it RETRIES. After a close, it opens
again.

**`close` is idempotent and returns the session to `closed`, and is not
terminal.** `closed` is the whole of "this session holds nothing", both before
the first open and after a close: no lock, no connection, no document. Keeping
close terminal would need a fifth state that only a hot reload and a test could
observe, to refuse a call neither of them makes.

That conflation has one real cost, and it is worth writing down rather than
arguing away. A surface CAN tell the two apart by which one it expects, and
Honeycrisp's route does: it renders `closed` as the loading screen, on the
grounds that it called `open` on the line above. That holds because nothing a
route can reach closes the session. `fromEpicenter` does not forward `close`,
so the only reference is the module local that built the handle, which is the
one place a hot reload can reach. A route that grew a `close`, or an effect that
reopened on `closed`, would reopen a session whose replacement module already
holds the lock. If either ever exists, the answer is to refuse `open` after an
owner-initiated close with a `Result`, not to add a state.

**Ordering inside the session is load-bearing, and three orderings are the
whole of it.** The in-flight attempt is recorded BEFORE `opening` is published,
so a listener that calls `open` while being told joins it rather than taking a
second claim on one address. The attempt is cleared by the attempt that set it,
and in the closed-underneath case only AFTER it has finished releasing, so a
later `open` cannot ask for a Web Lock the previous one has not let go of and
meet a conflict with no other window in it. And a close is memoized while it
runs, so a second one awaits the same release rather than finding nothing left
to wait on and reporting `closed` over a lock still held.

**`state.data` is the typed application data and nothing else.** No `open`, no
`close`, no `erase`, no disposal. The lock, the socket, and the listener were
acquired together and are released together (ADR-0340), so a component is handed
`data={epicenter.state.data}` and the lifetime stays with whoever built the
handle.

**There is no `already-open` state.** An ownership conflict is one of the
refusals `open` answers with, and it arrives as `failed` carrying
`StoreError.AlreadyOpen`. Promoting it would put one failure in the state
machine and the rest in an error, so a surface would switch on `status` and then
switch on `name` anyway. Honeycrisp already does the second switch, in its boot
node, narrowing on `DataOpenError`'s `name`.

**`AlreadyOpen` means a confirmed ownership conflict and nothing else.** Three
refusals are split out of it, because an application's boot gate names a repair
from the name:

| Name | What happened | Repair |
| --- | --- | --- |
| `AlreadyOpen` | another context holds the lock | close it, open again |
| `LocksUnsupported` | this runtime has no Web Locks API | none, and the gate says so |
| `ClaimFailed` | the lock request itself threw | open again |
| `GenerationExists` | the address already holds a generation | not a conflict at all |

The Web Lock stays internal to the session and stays load-bearing. The store
mints durable log ids from a closure-local counter seeded off the record it
loaded, so two independently opened stores over one local address can write over
each other's entries, and Yjs convergence does not repair bytes lost from the
persistence log. Randomizing ids would answer key collision and none of the
rest: two in-memory documents, two outboxes, two sync owners, and no
cross-window propagation. The product refusal stands: simultaneous independent
editing of one local replica is blocked, the first window owns it normally and
displays nothing about locks, and the second gets a precise refusal rather than
a stolen lock.

**Signed-out leaves the Svelte adapter.** It was never a fact about the session;
it was a latched read of `account.state` the wrapper performed because reading
`data` would otherwise open into `Unaddressable`. With opening explicit, an
application that has not authenticated has not called `open`, and the session is
`closed`, which is exactly true. The gate moves to the application, where the
auth client already is, and `@epicenter/svelte` stops carrying a second opinion
about authentication. The page-lifetime rule is unchanged (ADR-0088): the
layout's `reloadOnAuthChange` is still the precondition.

## Consequences

Honeycrisp's Try again button calls `epicenter.open()` instead of
`location.reload()`, and the erase flow does the same after the copy is gone.
`fromEpicenter` mirrors the session's state into a rune and runs `fromData` once
per store, in the subscription, rather than inside a getter it had to guard.

Vite awaits a hot-reload disposer, and Honeycrisp's was `() => void
handle.close()`, which handed Vite `undefined` to await and left the release
racing the replacement module. It returns the promise now. Inert construction
closes the rest of that gap: the replacement acquires nothing until the page
calls `open`.

A runtime without Web Locks now refuses with a name of its own and no repair.
Web Locks ship in every browser this store targets and in WebView2 and in
WKWebView on macOS 12.3+; a WebKitGTK older than 2.36 is the live case, and it
is bounded rather than handled.

## Considered alternatives

**Keep the lazy getter and add `whenReady`.** Two ways to start the same open,
one of them invisible, and every reasoning about "has this opened yet" would
have to consider both. The point is that acquisition is not a property read.

**A separate session object beside the epicenter**, `epicenter.session.open()`
or a `createDataSession(...)` the application holds next to the handle. It puts
a noun between an application and its notes that owns nothing the handle does
not already own: the handle already holds the definition, the account, and the
app id, which are the three things opening takes. ADR-0339's five nouns at one
altitude stand, with the verbs under the noun they belong to.

**Keep `close` terminal.** It required a state meaning "spent" that no surface
renders, or an `open` that silently does nothing, which is a lie in the state
machine.

**Randomize durable log ids and remove the lock.** Answers key collision and
none of the six other problems two independent writers over one local replica
create. Recorded here so it is not re-proposed as a simplification.

**A SharedWorker owning the document, so two windows edit one replica.** A real
answer to the product refusal rather than a way around the lock, and much more
than a lock's worth of complexity: a second runtime, a message protocol for
every store verb, and a lifecycle nothing else in this codebase has. Not
decided here, and not blocked by anything here.

**`state.store.data`.** An extra layer owning no invariant. `state.data` is the
data, and the session is what owns everything else.
