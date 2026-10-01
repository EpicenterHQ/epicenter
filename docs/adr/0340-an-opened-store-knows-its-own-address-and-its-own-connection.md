# 0340. An opened store knows its own address and its own connection

- **Status:** Proposed
- **Date:** 2026-09-02
- **Amended by:** [ADR-0417](0417-a-data-address-holds-one-document.md) removes generation from the opened data address and checkout identity; owner-derived destination and transport remain.
- **Unbuilt:** nothing. Built in `feat(data): a store knows which store it is` and `feat(data): the folder verbs read the store's own address`.
- **Relates:** [ADR-0339](0339-an-application-creates-one-epicenter-and-an-account-is-what-adds-a-store.md) (which needs this and does not govern it), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md), [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md), [ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-declaration-declares-its-authority.md), [ADR-0233](0233-a-route-owns-one-runtime-and-disposes-it.md)

## Context

A store's address is the opening application, the data id, and the generation
(ADR-0324). An opened store carries two of those five facts: `ReplicaData` has
`baseURL` and `principalId`, stamped by the opener, and nothing else.

Everything downstream needs the rest, so everything downstream is handed them
again. `attachStoreSync({ store, dataId, generation, transport, … })` takes the
two the store does not state. `pull`, `diff`, and `push` take a `CheckoutStore`
of four facts, of which the store already carries two, and Honeycrisp writes a
`folderArguments` helper whose whole body is assembling that object out of a
store and a number it kept beside it.

The number is what makes this a correctness question rather than a tidiness one.
A caller that assembles the address can assemble a wrong one: a socket addressed
at generation 2 carrying generation 3's bytes, or a manifest that records a
generation the folder does not hold. Nothing type-checks the pair, because both
halves are the same primitive.

ADR-0339 removes the last caller who could get it right. With the generation
resolved inside `epicenter.data`, an application never learns which number it
opened, so it cannot rebuild the address at all. The folder verbs and the sync
status a person is shown both need it.

## Decision

**An opened store states its whole address, and the connection sync attaches
belongs to it.**

`ReplicaData` gains the three facts it was missing and a connection status:

```ts
type ReplicaDocument = DataDocument & {
	readonly appId: string;
	readonly dataId: string;
	readonly generation: number;
	readonly baseURL: string;
	readonly principalId: PrincipalId;
	readonly sync: SyncCapability;
};
```

**The address is stamped by the opener, which is the one party that knows it.**
`openDatabase` is handed all five as arguments and today throws four of them
away after resolving a document name from them. Keeping them is not new state;
it is the state that was already there, written down.

**`attachStoreSync` takes `{ store, transport, onTransportError }`.**
The two arguments it loses are the two the store now states, and it read them
from the same open the caller passed. Nothing else can be addressed: a
connection is opened against the store it drives. `onDenied` goes with them: a
denial is readable from `store.sync.status().denied`, the one surface that
renders it polls that, and the callback had no caller in this repository.

**`pull`, `diff`, and `push` take the store and no second description of it.**
`CheckoutStore` is deleted. The manifest still records the same four facts,
because a folder has to be able to say which store filled it and refuse when it
does not match (ADR-0337); those facts are read off the store rather than
supplied beside it.

**Sync status is on the store, and it is pull-only.** `SyncCapability` grows a
`status()` that returns what the attached connection reports, or `undefined`
when nothing is attached. It is a getter a consumer polls rather than a signal:
connection health changes on a socket's schedule, and a reactive adapter that
held it would be claiming a reconnect is local state (`from-data.svelte.ts` says
this about the boundary it already refuses to cross). The store holds the
connection so that a status has one owner, not so that a reader can dial.

**An application still does not drive sync.** Attaching is
`@epicenter/app`'s (ADR-0339) and what an application reads is `status()`. There
is no `connect`, no `disconnect`, and no `retry`: the driver owns its backoff,
and a permanent denial is a fact about this auth generation rather than a
button.

**What ends a replica is the closer its opener returns, and a store cannot end
itself.** Opening acquires three things: the document and its exclusive Web
Lock, a sync connection, and a page-hide listener. `Symbol.asyncDispose` on the
store freed the first of the three, so a caller who called it left a connection
dialling against a document whose every verb throws. `openDatabase` returns
`{ store, close }`, `openReplica` composes the other two into that closer, and
the handle holds it as `epicenter.close()`.

**That close is terminal.** It does not forget the open, so a handle never opens
a second store: a read after a close resolves the same store, closed, and a
closed store throws on every verb. Forgetting the memo instead was tried and is
wrong, because it makes the handle a state machine with a race in it: a close
racing an open in flight can end the store the handle went on to memoize, and it
contradicts `data`'s own contract that a failure is memoized. Reopening is a new
handle, which is what a fresh page is, and the one caller that wants a lifetime
shorter than a page is a hot reload replacing the module that built it.

The symbol leaves `DataDocument` and stays on `Data`, which is what the memory
and SQLite constructors return: those acquire one thing, so disposing the object
frees everything it took and a test's `await using` is exactly right. A store an
application holds has no close on it at all, which is the sentence "nothing
closes it but the page" made checkable rather than repeated.

An application still does not call `close`. The page is the lifetime (ADR-0088),
and the two callers that need a lifetime shorter than a document are a hot
reload, which replaces the module that built the handle, and a test.

## Consequences

- A caller cannot assemble a wrong address, because it cannot assemble one.
  `folderArguments` in Honeycrisp, and the `dataId`/`generation` pair at every
  `attachStoreSync` call site, are deleted rather than kept correct.
- `openDatabase`'s options and `ReplicaData` stop disagreeing about what a store
  is. A test that opens a store gets an object it can hand to `pull` directly.
- The generation becomes readable by anything holding a store, which is what
  ADR-0339's Svelte wrapper, the folder verbs, and a bug report all needed.
- Vocab, Whispering, and Skills each wrote the store half of that closer twice,
  once for the success path and once for the catch. The catch is one call now.
  Their success path still disposes their own connection beside it, because
  `openDatabase`'s closer ends the store and they attached the socket
  themselves; that collapses when they move onto the handle.
- What a STORE exposes is a status, not a driver. `attachStoreSync` still
  returns a `SyncConnection` and `@epicenter/data/sync` still exports the type,
  because Vocab and Whispering call it directly and hold what it returns. When
  they move onto the handle that return value has no consumer, and `attach.ts`
  can refuse a second registration instead of overwriting the first.

## Considered alternatives

- **Leave the address in the caller's hands and pass it further down.** Refused.
  ADR-0339 removes the caller that has it, so this is not a choice between two
  spellings; it is a choice between the store knowing and nobody knowing.
- **A separate `address` object on the store.** Refused. It would nest two facts
  that are already flat (`baseURL`, `principalId`) under a third name, so every
  existing reader changes to buy grouping nothing asked for.
- **A reactive sync status, on the store or in the Svelte adapter.** Refused. The
  status is a fact about a socket somewhere else, and the store has no signal to
  hang it on; an adapter that held it would be polling underneath and calling it
  state. A consumer that wants a status line polls, which is what Honeycrisp's
  sidebar already does.
- **Putting the folder verbs on the handle now that the store carries the
  address.** Refused, and ADR-0339 refused it too: they belong to the store's
  address, and a handle method would be a second door to the same thing.
