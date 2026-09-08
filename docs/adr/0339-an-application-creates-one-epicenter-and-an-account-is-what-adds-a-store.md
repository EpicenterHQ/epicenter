# 0339. An application creates one epicenter, and an account is what adds a store

- **Status:** Accepted
- **Amended by:** [ADR-0353](0353-a-data-session-keeps-one-account-for-its-entire-lifetime.md) at account selection: the constructor is inert over app id and definition, and `open(account)` captures the Account per session. The one-handle and one-store decisions stand.
- **Amended by:** [ADR-0352](0352-an-account-s-data-and-a-device-s-files-are-two-packages-because-only-one-of-them-is-removed.md) at its mechanism: `EpicenterBinding`, `EpicenterBindingFactory`, the `binding` option, and the `Epicenter<never>` overload are withdrawn, and the runtime half is `@epicenter/device`. "An application creates one epicenter, and an account is what adds a store" stands.
- **Date:** 2026-09-02
- **Unbuilt:** nothing. Built with two corrections this record now carries: the two names an application mints are branded, and the root is not types only.
- **Amends:** [ADR-0316](0316-an-application-creates-one-scoped-epicenter-handle.md) at "the composition is `openData`, `openSqlite`, and `secrets`" and at the handle's argument list. The scoped handle, its one name, and its refusal of `createAppRuntime` stand.
- **Amended by:** [ADR-0344](0344-an-epicenter-owns-one-data-session-and-opening-it-is-a-verb.md) at "`data` is a lazy getter that memoizes". Construction is inert, `epicenter.open()` is the verb that acquires, `epicenter.state` is what a surface renders from, and a failed open retries rather than being memoized for the life of the page. Everything else here stands, including the one handle, the one store, the five nouns, and the store's own error.
- **Relates:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) (account and store are one yes/no), [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md)
- **2026-09-02, amended in place:** every handle now states its opening `appId` explicitly, including when it matches `definition.id`. The one-handle and one-store decisions stand; only the constructor convenience default is withdrawn.
- **2026-09-03, amended in place:** the browser and desktop subpaths export a binding, which is a function of `appId`, and an application composes the handle in one file. Two other shapes were built and withdrawn the same day; the amendment records both.

## Context

The original handle asked an application to state its identity twice. Every
construction wrote the app id into `createEpicenter` and again into the binding
it passed:

```ts
createEpicenter({ appId: LOCAL_MAIL_APP_ID, binding: createBrowserBinding({ appId: LOCAL_MAIL_APP_ID }) })
```

Nothing checked that the two agreed. `createEpicenter` validated its id with
`isProtocolAppId` and throws; `createBrowserBinding` validates nothing. A
mismatched pair compiled and scoped the two halves to different applications,
and no type can forbid it, because TypeScript cannot say "this string and that
string are the same string."

The repetition is a symptom. The platform fork happens twice: once by the
package.json `imports` condition that selects `epicenter.browser.ts` or
`epicenter.epicenter-host.ts`, and again by argument, inside a file that only
exists on one platform.

`openData` is on the binding and does not vary. Both window leaves implement it
as the same `openClientOwnedData(appId, definition, account)` call, and the Bun
host refuses it outright, because the store is client-owned in every runtime
(ADR-0226, ADR-0227). One quarter of the seam is not a seam.

And the handle takes a definition per call while an application has exactly one.
The two applications that hold data (`apps/honeycrisp`, and `apps/vocab` and
`apps/whispering` when they return) each declare one definition whose data id is
their app id. The one application using the handle today (`apps/local-mail`)
declares none, has no `@epicenter/auth` dependency, and uses `openSqlite` and
`secrets` only.

## Decision

**An application creates one epicenter, and an account is what adds a store.**

The runtime is the binding's import path. One `createEpicenter` serves every
build, and the seam holds the binding it enters with.

```ts
import { createEpicenter } from '@epicenter/app';
import { binding } from '#platform/binding';

createEpicenter({ appId, binding }): Epicenter
createEpicenter({ appId, binding, definition, account }): Epicenter<typeof definition>
```

```ts
type Epicenter<TDefinition extends DataDefinition = never> = {
	readonly appId: string;
	readonly sqlite: {
		open(name: DatabaseName): Promise<Result<AppSqliteDatabase, DeviceError>>;
		delete(name: DatabaseName): Promise<Result<void, DeviceError>>;
	};
	readonly secrets: {
		put(label: SecretLabel, value: string): Promise<Result<void, SecretError>>;
		get(label: SecretLabel): Promise<Result<string | null, SecretError>>;
		delete(label: SecretLabel): Promise<Result<void, SecretError>>;
	};
} & ([TDefinition] extends [never]
	? {}
	: {
			readonly account: AuthClient;
			readonly data: Promise<
				Result<ReplicaData<TDefinition>, StoreError | DataDefinitionParseError>
			>;
			eraseReplica(): Promise<Result<void, StoreError>>;
		});
```

**`definition` and `account` arrive together or not at all.** ADR-0336 settled
that an authority mints every generation, so there is no accountless store and
no store without sync. The overload is that sentence in the type: an application
that passes neither gets a handle with no `data` and no `account`, and one that
passes both gets the superset. `[TDefinition] extends [never]` fails downward,
so omitting the argument yields the smaller type rather than the larger.

**An application holds one store, and states its opening id explicitly.**
`appId` normally matches `definition.id`, but the two names remain independent:
the definition identifies the data, while `appId` identifies the application
opening and owning the local replica. This keeps the constructor honest about
the address it will open and leaves foreign-data use possible without another
API shape. An application with no definition also states the id, as Local Mail
does (ADR-0319).

Holding one store is a DECISION here rather than an observation about the
applications that exist. The two-segment address (ADR-0324) is built for a
second application holding a replica of another's data id, and it is not
theatre: on the desktop every window is one origin (ADR-0118), a Web Lock is
per origin, and the address is the lock's name (`claims.ts`), so without the
opening application in it the second window to want your notes takes the lock
away from the first instead of keeping its own copy. What has no caller is not
the mechanism but the case: no application opens another's data, and
`packages/chat` is the one library that arrived at the question and answered it
by publishing a reusable TABLE an application splices into its own definition
rather than a data id applications share.

**When a real second live replica arrives, this is the shape it takes, and it
is one change made at once.** `data` becomes a record keyed by the
application's own words rather than by data ids:

```ts
createEpicenter({
	appId: VOCAB_APP_ID,          // stated again: two definitions, no single default
	account,
	binding,
	data: { own: vocabDefinition, notes: honeycrispDefinition },
})
epicenter.data.own
epicenter.data.notes
```

Every member that names a store is revisited in that same change, `eraseReplica`
first, because it stops having one store to mean. It is deliberately not an
overload: a handle that is sometimes one store and sometimes a set makes every
store-shaped member fork forever, to save one word at one call site. Until then,
two `createEpicenter` calls sharing one application id is not the way to do it,
because the two handles would each carry a `sqlite` and a `secrets` that are one
scope.

**Five nouns at one altitude:** `appId`, `sqlite`, `secrets`, `account`, `data`.
Verbs live under the noun they belong to. `openSqlite` and `deleteSqlite` were
two verbs sharing a suffix, which is a noun that had not been written down.

**`data` is a lazy getter that memoizes, resolves already syncing, and resolves
a `Result`.** Reading it starts the open, so an application that never reads it
pays no Web Lock, no IndexedDB, and no round trip. Sync attaches inside, because
the account is on the handle.

**The error is the store's own, not `DeviceError.StorageFailed` wrapping it.** An
application's boot gate switches on the failure's `name` to choose between a
retry and an erase; `apps/honeycrisp/src/lib/boot-failure.ts` had arms for
`AlreadyOpen`, `Unaddressable`, and `BoundElsewhere`, and `openClientOwnedData`
flattened all of them into `DeviceError.StorageFailed({ cause })`, so every arm
fell through to "Something went wrong" and both repairs disappeared. The
`Unaddressable` arm went for a different reason, below: the wrapper answers its
one remaining producer.
`data` resolves `Result<…, StoreError | DataDefinitionParseError>`, which is what
`openDatabase` and `resolveGeneration` already return. `DeviceError` was minted for
the SQLite and secrets owners and is the wrong error for a store `packages/data`
opens.

**Honeycrisp's openers rejected instead, and the reason leaves with the
construct that justified it.** The comment in `databases.ts` is exact: a route
rendering a promise already has `{#await}`'s failure channel, so a `Result` past
the opener bought a second one, and the account route rendered its gate from four
arms of which none read the error. The Svelte wrapper removes `{#await}`. Its
`state` is synchronous tracked state read by `{#if}`, which has no failure
channel, so a rejection there is data that had to be caught and re-typed as
`unknown`. A `Result` is that data, already typed. Nothing past the wrapper
carries a `Result`, and nothing past it throws.

**`openData` leaves the binding.** What a runtime supplies is
`{ open, delete, secrets }` and nothing else. The Bun host keeps this seam,
because it composes a storage root and a secrets owner its test swaps; the two
window leaves keep it because a tab has no keychain and no Bun-owned files.

**`account` is an `AuthClient` the application constructs and passes in.** The
package does not build one. A desktop leaf needs its own bootstrap and a browser
leaf needs a redirect launcher, and a package that built both would have to know
every auth model an application might use.

**`data` opens the newest generation this device holds, else the authority's
newest, else mints, and nothing stores a selection.** The choice stays derived,
so deleting the generation from the URL takes nothing with it. There is no verb
that selects an older generation and there is no picker: every account has one
generation until `importReplica` ships, the ledger records numbers and nothing
else (ADR-0287 deleted the rest), and the one act an old generation supports is
export, which a browser cannot do yet (ADR-0325). When that changes the surface
is a read-only `generations.list()` and an exact `generations.open(n)` for a
rescue, each one existing function made public. Neither is decided here.

**The handle has no verb that creates a generation, and that is a statement
about now rather than about the shape.** `createGeneration(definition, { appId,
from, account })` already takes the bytes and already mints a number; nothing
outside `resolveGeneration`'s empty-first-run arm calls it, so every account
holds generation 1 and the second one cannot yet exist. A handle method with no
caller would be a promise made in a type instead of in prose, so the promise is
here.

**Two things must land together when it does.** An import must end with the
application reloading, because `data` is memoized and the store a page holds
after an import is still the one it opened; ADR-0293's "redirect to the
generation's URL" becomes a document reload, after which `data` resolves the new
number itself. And a device holding an older generation must be told a newer one
exists, because cache-first resolution means a second device that holds
generation 3 opens 3 on every boot without ever asking the authority. That is
ADR-0281's notice, specified there and never built, and this record is what
makes it load-bearing: deleting `/account/[generation]` removes the only other
way a person could reach a newer number. Neither is built here, and shipping an
import without the notice would strand a device silently.

**A name is checked where it is minted, and the type carries that.**
`DatabaseName` and `SecretLabel` are branded, and the six per-call guards inside
the handle are gone. They answered one question about a string that, in every
caller, is either a constant in the build or a value the application already had
to validate to say anything useful about: Local Mail's `finishConnect` already
refused a subject it could not file, because "we cannot file your mail under
that" is a sentence only the application can write. `databaseName` and
`secretLabel` mint one and throw, on the same terms `createEpicenter` throws on
an application id; `isDatabaseName` and `isSecretLabel` narrow a value that
arrived at runtime. The desktop owner still validates on arrival, because a
brand is a compile-time fact and a request crossing the sidecar carries no
types.

**Two renames follow from putting `account` on the handle.** `eraseLocalData` is
`eraseReplica`, because it erases this device's copy and touches nothing at the
authority (ADR-0325), and `replica` is the word a developer reads unsoftened.
`secrets.put(accountId, …)` becomes `secrets.put(label, …)` with
`SecretError.InvalidSecretLabel`, because ADR-0310 calls it a label and
`epicenter.account` now means something else on the same object.

**The Svelte wrapper has four states, and the data rides on `ready`.**
`fromEpicenter(epicenter)` answers `signed-out | opening | ready | failed`.
Signed-out is answered before anything opens, from a single read of
`account.state` (ADR-0088: a page lifetime is one auth generation), so a person
who cannot open anything costs no Web Lock, no IndexedDB, and no round trip. It
is its own state rather than a failure because the route already says so: folding
it into the failure channel makes the gate sniff an error to choose between "sign
in" and "something broke", and a signed-out open refuses with `Unaddressable`,
which the boot gate reads as a bad link.

It is the wrapper and not the handle that makes that read, and the layout's
reload gate is its precondition: an application that mounts no
`reloadOnAuthChange` signs a person in and leaves them on the sign-in screen
until they reload by hand.

The settled value is held in a `$state.raw` written from the promise's `.then`,
not a `createSubscriber`. A subscriber is for a source with a live read and a
subscribe pair, and its start function re-runs if every reader goes away and
returns; a promise settles once, cannot be unsubscribed, and must not be
forgotten because the last reader navigated away. The auth half of the same
wrapper does use `createSubscriber`, because an auth client is that kind of
source, so the two halves differ on purpose. That auth half is `reactive(auth)`
in `@epicenter/auth/svelte`, beside this wrapper rather than inside it:
`fromEpicenter` reads `account.state` once and tracks nothing.

There is no `app.data`. The opened store is a field on the `ready` variant, so a
read before the store is open does not compile. A top-level `data` accessor could
only be a runtime throw, which is a type turned into an invariant, and it cannot
be read from a `$derived` during `opening` without becoming a render error.

**This record assumes the opened store knows its own address.** The folder verbs
(ADR-0337) and the sync status a person is shown both need the generation, and
`ReplicaData` carried `baseURL` and `principalId` and no generation. With the
generation resolved inside `data`, an application cannot rebuild it. Putting the
address and the connection status on the store is a `packages/data` decision and
belongs in its own record; this one does not govern it and does not work without
it. That record is
[ADR-0340](0340-an-opened-store-knows-its-own-address-and-its-own-connection.md).

## Consequences

- An application that holds data states neither an id nor a binding. It states
  what it holds and who it acts as, and every mismatched pair this record was
  named for stops being representable.
- A handle with no type argument has no `data` and no `account`. Local Mail's
  three-line platform leaf is the whole surface it needs, and adding Epicenter
  Data later is one changed constructor call with every existing `sqlite` and
  `secrets` call site untouched.
- `resolveGeneration`, `attachStoreSync`, and the hand-built `DatabaseAccount`
  leave application code. Honeycrisp's `resolveAccountGeneration`,
  `honeycrispAccount`, and `sync.ts` are deleted. Vocab and Whispering still
  hold copies of the first two, because neither is on the store yet (ADR-0227
  left both broken on purpose); they go when those applications are rebuilt
  against the handle, and until then they are the only callers of
  `attachStoreSync` outside `packages/app`.
- The generation stops being a route parameter. `data` resolves it, so
  `/account/[generation]` and the `/account` page that only redirects into it
  both go. Nobody chose that number and no link carries it.
- The root is not types only, which this record claimed and the build corrected
  twice over. It holds the one `createEpicenter` every build calls, the errors,
  the two name mints and their guards, and `EpicenterBindingFactory`, the
  contract every seam leaf annotates against. The runtime subpaths hold a
  binding each. The Bun host built a third in `apps/epicenter/src/app-binding.ts`,
  which nothing ever composed and which is now deleted; ADR-0323's background
  half is unbuilt.
- ADR-0337's folder verbs stay functions over an opened store rather than
  methods on the handle, because they belong to the store's address.

## Amendment, 2026-09-03: the runtime is the binding's import path, and the binding is a function of the id

The decision above is unchanged. An application still creates one epicenter, an
account is still what adds a store, one id still scopes every capability, and
the runtime is still a build fact rather than a `typeof window` test. What this
amendment settles is which module the build selects, and it is written after
the question was answered three different ways in one evening.

**`@epicenter/app/browser` and `@epicenter/app/desktop` export a binding, and
it is a function of `appId`.**

```ts
// src/lib/platform/binding.browser.ts, the whole leaf
import type { EpicenterBindingFactory } from '@epicenter/app';
import { createBrowserBinding } from '@epicenter/app/browser';

export const binding: EpicenterBindingFactory = createBrowserBinding();
```

```ts
// src/lib/epicenter.svelte.ts, one file for every build
const handle = createEpicenter({ appId, definition, account: auth, binding });
export const epicenter = fromEpicenter(handle);
if (import.meta.hot) import.meta.hot.dispose(() => void handle.close());
```

**The seam holds only what varies, and a binding is the only thing that does.**
Nothing else about an epicenter is a platform fact: the store is client-owned in
every build (ADR-0226, ADR-0227), the definition is one file, and the account is
selected by the seam next door. So the composition, the singleton, and the one
call that ends it live in one file per application, where they cannot drift
between two leaves that differ on an import line.

**A binding is a function of the id rather than a value beside one.** The
mismatched pair this record is named for is a handle scoped to one application
holding a binding scoped to another. No type can forbid two strings being
different, so the fix is to stop having two: `createEpicenter` resolves the id
and hands it to the leaf. Nothing is checked because nothing can disagree.

**Honeycrisp is the application that pays for getting this wrong**, and it is
the one that needs the seam least. It owns no SQLite file and keeps no secret:
grep its source for either and there is nothing. Whatever the seam holds,
Honeycrisp carries it, so a seam holding the whole handle made an application
with no files and no secrets inherit a platform axis to reach a keychain it
does not use.

### Two other shapes were built first, and both lost

They are recorded because each was reasonable, each shipped, and each has an
argument that reads well until it meets the tree.

**The runtime constructor** (`createBrowserEpicenter`, `createDesktopEpicenter`,
each supplying its own binding). It made the runtime a property of the whole
handle. Its cost was paid three times over: nine overload declarations and three
`as Epicenter<TDefinition>` casts to restate one signature per runtime, and, once
a binding became a value again, a `readonly appId` on `EpicenterBinding` and a
`binding.appId !== appId` throw inside the core. That throw is this record's
title defeated: the pair became representable again and was answered with a
runtime check instead of a type. Its stated reason, that a function forced
application code "to pass a callback solely to delay construction", was never
true of any tree. The application wrote `binding`, an identifier imported from a
seam, exactly the way it writes `auth`.

**The composed leaf**, where `#platform/epicenter` exported the finished
`epicenter` and the composition file was deleted. It buys one real thing: the
word `binding` never appears in application code. It costs the invariant. Two
files that each compose the handle each define the application's one
`epicenter`, so "there is exactly one" rests on nobody importing a leaf
directly, and the two leaves are then twelve identical lines that no type
compares. The seam test could only assert that a leaf contained an import
specifier; a leaf that dropped `fromEpicenter`, dropped its hot-reload disposal,
or exported a differently shaped object would build and start.

The gains are not in tension, which is why this shape takes both. The binding
factory lives inside `packages/app` and its leaves; an application names
`binding` once, in one file, and never learns what is behind it.

**Every leaf is annotated against `EpicenterBindingFactory`**, so a leaf that
drifts fails to typecheck rather than at a person's runtime, and
`platform-selection.test.ts` asserts that no leaf composes a handle.


## Considered alternatives

- **A runtime-specific constructor per platform** (`createBrowserEpicenter`,
  `createDesktopEpicenter`). Built, then withdrawn; the amendment above records
  why. The short version is nine overloads, three casts, and a runtime check
  standing in for a type.
- **`Device` beside `Epicenter`, as two constructors.** Refused. The base
  name teaches the wrong lesson: a developer would learn "storage" first and
  "Epicenter" as the upgrade, when the reference application has all four parts
  and the accountless one is the documented exception (ADR-0319).
- **`files` or `databases` for the SQLite noun.** Refused. Both words are taken
  and a developer meets their other meanings the same day. `databases` is the
  synced store (`openDatabase`, `DatabaseName`), and `files` is the `~/Epicenter`
  working copy (ADR-0337, `CheckoutFile`).
- **An empty definition for an application with no store.** Refused. It is not a
  spelling: an empty definition still resolves a generation over the network and
  claims an exclusive Web Lock, so an application with no data would pay a cold
  round trip for a store with no tables.
- **`oauth` configuration in the constructor.** Refused. It would make
  `packages/app` depend on `@epicenter/auth`'s constructors and know the desktop
  bootstrap, to save one line in a file whose job is composing.
- **Opening eagerly at construction.** Refused. A module-scope handle whose
  `data` rejects for a signed-out person produces an unhandled rejection on any
  route that never reads it, and it claims the Web Lock during module
  evaluation, which a second tab and a hot reload both meet.
- **Downloading and holding every generation the authority lists, deleting the
  older local copies.** Refused. A generation is a whole database rather than a
  delta, a held copy is not a synced one because sync attaches to an open store,
  and this origin's persistence request is often refused, so extra copies raise
  the odds of an eviction that takes the generation a person actually uses.
  Deleting the older copy is the drain-and-switch ADR-0281 removed, aimed at the
  one copy holding a stranded device's work.
- **Rejecting rather than resolving a `Result`.** Refused. A rejection is
  `unknown`, so the failed state could not carry a typed error without an
  assertion, and `data` would be the only verb on a handle whose `sqlite.open`
  returns a `Result` that fails a different way.
- **Wrapping the store's failure in `DeviceError.StorageFailed`.** Refused. It hides
  the `name` a boot gate switches on under `cause`, which makes every arm the
  fallback and deletes the erase and retry repairs.
- **A top-level `data` accessor that throws before the store opens.** Refused. It
  converts a fact the type could carry into a runtime invariant, and it cannot be
  read from a `$derived` while opening.
- **`data` as a method taking the definition.** Refused. An application has one
  definition and it is an import, so the argument is a build-time constant
  arriving at call time, which is the same shape as the app id arriving twice.
  A second store does not weaken this: it makes the constant two constants, both
  still known when the bundle is built, which is why the future shape above is a
  record at construction and not `epicenter.open(definition)`.
- **`data` overloaded to take either one definition or a record of them.**
  Refused. TypeScript can discriminate the two, so the cost is not the signature:
  it is that `data` is not the only member naming a store, so `eraseReplica` and
  everything after it forks into two shapes permanently, and a reader of the type
  holds two pictures of what an epicenter is. The saving is one word at one call
  site.
- **A built binding passed beside an `appId`.** Refused, and it is the
  alternative this record exists to refuse. Two strings that must match and no
  type that can say so; the only defence left is a runtime throw, which is the
  invariant this record replaced with a signature.
