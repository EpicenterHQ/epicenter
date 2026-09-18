# 0389. The open call decides the App's type, and a local App has no account members

- **Status:** Accepted
- **Date:** 2026-09-12
- **Superseded by:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) at the opener shape: one `open(account)` returns one App with a `device` scope and an optional `account` scope, so there is no `library` member, no `App` union, and no separate local and account types. That a store with no authority answers `sync.status()` with `undefined` stands as the behavior of `app.device`.
- **Amends:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md): the shared data API stands; the account-only members `account`, `retirement`, and account inference exist only on an account session's type.

## Context

`openLocal()`, `openPersonal(account)`, and `openShared(account)` return one
inferred type. On a local open, `account` is null, `ai.account` is null, and
`retirement` never resolves. The callers already know which open they used.
Vocab and local-mail only ever call `openPersonal`. Honeycrisp and Whispering
both re-derive "is this an account library" as `library !== 'local'` beside
the handle to build their departure. The one production null check on
`app.account` is in `packages/app-shell`'s inference selections, which reach
into the handle for the account identity because the AI capability does not
carry it; that check is what [ADR-0390](0390-the-app-is-the-unit-of-ownership-and-a-capability-is-the-unit-of-sharing.md) removes.

Inside `openApp`, the choice threads through nine sites as one derivation
chain: the choice, the `authorityId` guard, the account, the identity, the
replica, the remote address, and the nullable arguments to blobs, the store,
secrets, and AI.

A layered design was proposed and rejected with evidence: a shared `openCore`
returning a handle that two openers spread and extend. It cannot work. The
handle is the store object mutated in place, its `persistence` getter throws
until acquisition completes, and the store's own comment forbids spreading an
opening store. Layering also gives `close()` a second owner at the seam where
the library claim is released, gives `ready` a second failure path, and cannot
add account inference after the fact because the AI owner binds account
clients into its drain set at construction.

## Decision

**One opener, one object, one `close`, one `ready`; the declared return type
is a union discriminated by a `library` member, and a local App has no
account-only members.**

```ts
type LocalApp<T>   = AppBase<T> & { library: 'local' };  // ai.account is null
type AccountApp<T> = AppBase<T> & {
  library: 'personal' | 'shared';
  account: AccountIdentity;
  retirement: Promise<LibraryRetirement>;
};
type App<T> = LocalApp<T> | AccountApp<T>;

openLocal(): LocalApp<T>;
openPersonal(account): AccountApp<T>;
openShared(account): AccountApp<T>;
```

A local App carries `sync`, because the data document declares `sync` on
every store and its `status()` answers `undefined` whenever no connection is
attached, which is the designed contract. The three readers that pass that
status through unchanged, Honeycrisp's store shell, Whispering's app handle,
and the Svelte data adapter, do not branch on it. `retirement` is not on the
data document; the store opener produces it from its own closure and the App
forwards it, so the App simply does not forward it for a local open.

`Application` is the composition root, `defineApplication` in
`packages/app/src/index.ts`: one per app, opened as many times as a product
needs, each open owning one library. A page may hold a local App and a
personal App at once from one Application, which [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) already permits as a separately captured non-primary library. Moving data between them is an explicit import over two handles, as [ADR-0143](0143-account-open-never-consumes-device-data.md) and ADR-0355 require, never a handle feature.

## Consequences

- `openApp` collapses its derivation chain into one `captureReplica(choice)`
  that returns the replica, identity, and remote address together.
- The runtime throw for a missing `authorityId` is deleted. `Account` already
  requires the field; the guard is unreachable.
- Vocab's and local-mail's handle types become `AccountApp` with no call-site
  change, and their account inference stops being nullable.
- `app.library` replaces the beside-the-handle `library !== 'local'`
  derivations in Honeycrisp and Whispering.
- Nothing changes in `@epicenter/data`: `acquireAppData` keeps its one branch
  and the store keeps its `local` flag. Splitting either would move the branch
  up or fork a large function to delete one boolean.
- `blobs.remote` stays a total facade that answers `RemoteNotConfigured` on a
  local App. Whispering's `requireRemote()` helper, which cannot fail, is
  deleted.
- This record depends on ADR-0390: shared code must stop picking `account`
  from the handle before the local arm can lack the key.

## Considered alternatives

- **A shared `openCore` with two openers that spread and extend its result.**
  Throws on every account open, splits close and ready ownership, and cannot
  bind account inference. Rejected on evidence, above.
- **An `app.account` namespace holding sync, retirement, remote blobs, and
  account inference.** The most discrete shape, and preferred if reachable.
  `sync` is declared on the data document, `retirement` is produced by the
  store opener's closure, and account inference is bound inside the AI owner,
  so the namespace would alias into three owners outside it. Revisit only as
  a `@epicenter/data` decision that gives replicas their own surface.
- **One handle spanning local, personal, and shared.** Three documents, three
  claims, three engines, and three closes behind one object, with a library
  selector at every table read. That is three Apps. Refused.
- **Nullable members on one type, as today.** Every consumer re-derives a fact
  the caller already had, and `retirement` stays a promise that never settles.
  Refused.
