# 0348. The local address carries its session scope, and a database needs no binding to know whose it is

- **Status:** Proposed
- **Date:** 2026-09-05
- **Amends:** [ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md) at its refusal of the partition segments and at the format version: an account address carries `<authority-id>/<principal-id>` after the app id, while a local address carries `local`; the browser account spelling remains in the `v5` epoch and the local/account scope names are explicit. Its app segment, its "one grammar, two spellings" rule, and its refusal of the base URL all stand. And [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md) at the binding and the refusal, both withdrawn: a database records no `{ baseURL, principalId }` stamp, there is no `binding` object store, and `StoreError.BoundElsewhere` does not exist. Its re-homing decision (export then import, a fresh fail-closed export pass, final state and not history) is untouched and still governs.
- **Relates:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) (an account is required to open, which is the premise ADR-0325 said no address could have), [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) (a person deletes; nothing is deleted as a protocol step), [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) (one build names one authority)
- **Unbuilt:** the desktop account spelling, `<root>/apps/<app-id>/accounts/<authority-id>/<principal-id>/data/<data-id>/<n>.sqlite`, and the local spelling, `<root>/apps/<app-id>/local/data/<data-id>/1.sqlite`. No desktop code writes either path yet. There is no reaper for stranded `v4` records and there will not be one.

## Context

ADR-0324 removed the server URL and the principal from a local address on the
grounds that they encode a device-wide constant. That was half right. The server
is a constant: a build names one authority (ADR-0326) and a browser build is
served from one origin. The principal is not, and the case it fails is ordinary:
two people on one browser profile, or one person with two accounts.

ADR-0325 caught that gap and closed it with a stamp. A generation recorded
`{ baseURL, principalId }` in its own `binding` object store, written in the
transaction that created it and never rewritten, and `openDatabase` answered
`StoreError.BoundElsewhere` when it did not match. That bought real safety: two
authorities mint generation numbers independently, generation numbers are small
integers, and Yjs merges rather than erroring, so without something two
histories interleave silently.

But the stamp is a substitute for a name. It is checked at every open, forever,
to establish a fact a name could carry once. And it made a refusal the product:
a second person signing in on a shared device met a screen saying the notes
belong to somebody else, offering to delete them, when the honest answer was
that they should get their own.

ADR-0325 grounded the stamp in one premise: "a principal is asserted by a remote
party at first sign-in, after local data can already exist, so no address can
know it in time." ADR-0336 retired that premise. An authority mints every
generation, so an account is required to open at all, and there is no longer any
local data that predates a principal. The one fact that made the address unable
to hold the principal is gone, and with it the reason to record it somewhere
else and compare it on every open forever.

## Decision

**The address carries the session scope, so a database needs no binding to know
whose it is.**

```txt
<platform namespace> / <scope> / <data-id> / <generation>

browser local    epicenter/<app-id>/local/data/<data-id>/<n>
browser account epicenter/<app-id>/accounts/<authority-id>/<principal-id>/data/<data-id>/<n>
desktop local    <root>/apps/<app-id>/local/data/<data-id>/<n>.sqlite
desktop account <root>/apps/<app-id>/accounts/<authority-id>/<principal-id>/data/<data-id>/<n>.sqlite
```

One scope grammar has two forms: `local`, or an account identified by the
authority that minted the principal and that principal itself. The authority is
part of the durable account coordinate because the same principal text may be
issued by different deployments. The app id remains above the scope because an
application owns its directory (ADR-0314).

**The principal is refused, never canonicalized.** `PrincipalId` is whatever the
authority minted, and an identifier is compared byte for byte by whoever issued
it; normalizing one here would invent an equivalence the authority never stated.
It is admitted as an address segment under the rule `keySegments` already states
for a blob key: not empty, no `/`, and not `.` or `..`. A value that fails is
`StoreError.Unaddressable`, naming the value, the way the app-id arm beside it
already does.

**The binding is deleted, along with everything that served it.**
`DatabaseBinding`, the `binding` object store, `canonicalBaseURL`,
`canonicalBinding`, `isSameBinding`, and `StoreError.BoundElsewhere` are gone. A
record at a v5 name can only belong to the account its name says it does, the
same way it can only belong to the generation its name says it does (ADR-0292).

**Local state and account state are different replicas.** Local state has no
authority or principal and is never an account's replica. Two accounts on one
device are also separate because their authority and principal segments differ.

**Erasing is scoped to one account, and the verb closes first.**
`eraseGenerations` takes the principal, so forgetting one person's copy on a
shared device leaves the other person's alone. It is no longer a boot repair: a
person invokes it from the account popover while signed in, and the handle's
`eraseReplica` closes the session before erasing, because erasing takes the same
Web Lock an open holds and the handle is the one thing that can release it.
Deletion can fail after removing a generation. A failed erase therefore stays
closed and reports the incomplete removal; reopening is not rollback. An
application-level removal operation owns recovery before any new open or sync.

## Consequences

- **`baseURL` stays out, and this is what that buys and what it costs.** It is
  justified today: a browser build reads `APP_URLS.API`, a build constant, and
  IndexedDB is origin-scoped anyway; the desktop authority reads
  `EPICENTER_API_URL`, and ADR-0325 already deleted `selectInstance` and
  `selectHosted`. **If a build ever makes the authority selectable within one
  origin, the address must gain the segment at that moment, or two authorities'
  principal-id spaces collide at one name.** On a self-hosted instance every
  principal is the literal `instance` (ADR-0075, amended by ADR-0092), so that
  collision is not hypothetical there: two instances would both address
  `.../instance/...` and Yjs would interleave two unrelated histories with no
  error. That is exactly the failure ADR-0325's binding prevented, and it is
  being accepted rather than mitigated. `generationPrefix` in
  `packages/app/src/data/store/browser.ts` is the one line that has to change.
- **Every `v4` record on every shipped Honeycrisp device is stranded, on
  purpose, silently.** The next boot resolves nothing under the `v5` prefix,
  asks the authority, fetches its copy, and writes it at the new name. What is
  lost is exactly the rows with `authoritySeq === null`: edits the page never
  flushed. That is bounded by a live socket and a flush-on-hide listener, so it
  is a tail, but the person gets no error, no screen, and nothing to click.
- **There is no reaper, and that is the decision rather than an omission.** The
  `v4` bytes sit in the origin's quota forever. A reaper was considered and
  refused: it is code that runs once on every shipped device, cannot be
  exercised before it ships, and would make the upgrade the moment somebody's
  unsynced work became unrecoverable. Leaving the bytes costs storage and
  nothing else, and keeps them recoverable if a report arrives.
- **`Unaddressable` absorbed the refusal.** A signed-out account states no
  principal, reaches the opener, and is refused by the address builder rather
  than thrown at earlier, which keeps one refusal in one place.
- **A boot screen went with the error.** `BoundElsewhere` was the only failure
  whose repair was destructive, so deleting it deleted the erase repair, its
  confirmation dialog, and the vocabulary field that described it. What
  remains is `AlreadyOpen`, `LocksUnsupported`, and one shared retry.
- **The lock key inherits the change for free**, because it is the address
  verbatim. Two accounts never contend for one key, so a claim conflict is now
  always a genuine conflict over one copy.

## Considered alternatives

- **Adopt `v4` records once, then delete the adoption code.** Rejected, and it
  was close. At open, a `v4` record whose stamp matched the current principal
  could be copied to the `v5` name and unlinked. It preserves the unsynced
  edits the clean break drops. It costs roughly 150 lines that must also run at
  RESOLUTION, not just at open, or an offline device with only a `v4` copy
  reports that it holds nothing and fails to a boot error while its own notes
  sit on disk. Worse, it keeps `DatabaseBinding`, `canonicalBaseURL`,
  `canonicalBinding`, `isSameBinding`, and the `binding` object store alive to
  read the old stamp, which is the entire deletion this record exists for, and
  a deletion parked behind an adoption path does not happen.
- **Put `baseURL` back in the address alongside the principal.** Rejected. It
  reintroduces URL canonicalization into a durable storage name, where a
  normalization slip splits one dataset into two, and it spells a per-build
  constant into every name. The cost of refusing it is stated in the
  consequences above rather than hidden.
- **Keep the binding as defence in depth beside the address.** Rejected. Two
  guards over one invariant are free to disagree, and the one that is checked
  at every open is the one that will drift. The address is the guard that
  cannot be forgotten, because a name that does not exist cannot be opened.
- **Canonicalize the principal id.** Rejected. Whitespace, case, and Unicode
  form are the issuing authority's business. A store that trims a principal id
  is asserting that two ids are one account, which is a claim it has no standing
  to make.
- **Keep `BoundElsewhere` and make it a "switch account" screen.** Rejected: it
  is a screen for a state that no longer exists. Under this record the second
  person does not meet somebody else's data, so there is nothing to switch away
  from.
