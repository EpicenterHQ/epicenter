# 0324. A database address is its data id and generation, and the definition declares its authority

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md). Addressing a replica by its server URL and verified principal is withdrawn entirely; the facts it put in the address move to a declaration and a stamp.
- **Amends:** [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) at its desktop path, which gains a format-version segment; and [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) at the `data/<data-id>/` spelling, which gains the same version segment.
- **Relates:** [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) (the generation is the address, unchanged), [ADR-0293](0293-a-generation-is-created-by-importing-a-folder-and-the-ledger-row-is-its-existence.md) (who mints the number), [ADR-0318](0318-epicenter-data-is-what-epicenter-is-the-authority-for-and-a-foreign-write-is-a-command.md) (the authority test), [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md) (the other storage kind)
- **Built, in the browser.** `packages/data/src/store/browser.ts` composes `epicenter/v4/<app-id>/<data-id>/<n>`, and `openDatabase`, `createGeneration`, and `newestGeneration` each take the opening application's id. The desktop spelling is unbuilt: no desktop code writes `data/` at all.
- **Amended by:** [ADR-0348](0348-the-local-address-carries-the-principal-and-a-database-needs-no-binding-to-know-whose-it-is.md) at its refusal of the partition segments and at the format version: the address regains `<principal-id>` between the app id and the data id, and the version becomes `v5`. The principal was never the device-wide constant this record refused; two people on one browser profile is the case it missed. The app segment, the "one grammar, two spellings" rule, and the refusal of the base URL all stand.
- **Amended by:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) at two clauses, both withdrawn: the `authority: 'none' | 'epicenter'` field a definition declared, and "two notebooks are two data ids". The app segment stands on ADR-0304 alone, which was always the stronger half, and the address grammar is unchanged.
- **2026-09-02, amended in place at "Where the app id comes from" below.** The original decision put an app id in the address and named no parameter that carries one; that section settles it.

## Context

The address carried four segments that identify who a database belongs to:
`local` or `account`, then a percent-encoded base URL and a principal id. Those
segments are constant for every database on a device, because
[ADR-0262](0262-the-desktop-host-owns-one-active-connection-and-no-connection-registry.md)
already gives a device one selected server and one active connection. A segment
that never varies is not an address; it is a global written into every name.

They also cost real machinery: URL canonicalization inside a durable storage
name, so `https://api.example.com` and the same URL with a trailing slash are two
datasets unless normalization never slips; and a `local`/`account` fork running
through every opener, mirror path, and export path.

Meanwhile `local` and `account` were never one database at two addresses.
Honeycrisp's `/device` and `/account` destinations are two notebooks a person
navigates between, and its README says the account destination "never silently
shows device data."

## Decision

**A database is addressed by what it holds and which history it is, and by
nothing about who owns it.**

```txt
<platform namespace> / <format version> / <app-id> / <data-id> / <generation>

browser   epicenter/v4/<app-id>/<data-id>/<n>
desktop   <root>/apps/<app-id>/data/v4/<data-id>/<n>.sqlite
```

One grammar, two spellings. The platform namespace is `epicenter` in a browser
and `apps` on disk; both mark where the platform stops choosing names and an
application starts.

**The app id is in the address on both substrates, because a replica belongs to
one application.** ADR-0304 says two applications may name one data id and each
keeps its own replica, converging through the authority, and its consequences
anticipated this exact fix: "a shared-origin host can add the app ID to its
physical browser namespace without changing application code." A browser address
without the segment cannot express ADR-0304 at all.

The two spellings place the version differently and that is forced rather than
sloppy: on disk an application's directory holds its bundle and its SQLite and
its blobs (ADR-0314), so the app segment sits above the `data` kind, and the
format version sits inside it. In a browser there is no such directory. The
logical address is the same in both: an application, a data id, and a
generation, read under one format version.

**Two notebooks are two data ids, not two addresses for one.** A definition
declares whether Epicenter is its authority:

```ts
defineData({ id: 'so.epicenter.honeycrisp.device',  authority: 'none',      … })
defineData({ id: 'so.epicenter.honeycrisp.account', authority: 'epicenter', … })
```

`'epicenter'` does not name a server: which server is the deployment's fact
([ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md)).
`'none'` means this database has no server, ever.

Both share one table declaration. `openDatabase` is overloaded on that field: it
requires an account for `'epicenter'` and refuses one for `'none'`, so pointing a
device-only notebook at a server stops being a typo the compiler cannot see. The
optional `account?` parameter disappears from `openDatabase`,
`newestGeneration`, and `createGeneration`.

**Where the app id comes from: the scoped handle, and it is self-claimed.**
This record put the opening application in the address and did not say what
supplies it. The runtime-specific constructor already scopes an
application's SQLite files and its secrets by that id
(`packages/app/src/index.ts`), so `openData` fills the segment from the handle
and an application never writes its own id twice. An application that calls
`openDatabase` from `@epicenter/data/browser` directly passes its own id as
`appId`; one that holds the handle states it once, at construction
(`packages/app/src/index.ts`).

The shared core verifies that the concrete binding carries the same `appId` as
the handle, so the two local-storage scopes cannot silently diverge.
[ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md)
decided that "the app id in a broker request is self-claimed, so an app that
claims another's id reaches that app's SQLite files and its secrets," and this
segment is on the same footing: it partitions storage by naming and never by
enforcement. What `isAppId` (`packages/constants/src/app-id.ts`) buys is that a
claim can never contain a `/` and be read as another application's address.

The opening application's id is not the data id, and `openDatabase` takes both.
They coincide when an application names its data after itself, which is what
Honeycrisp does, and that is a coincidence rather than an identity: ADR-0304
says two applications may name one data id and each keeps its own replica.

**The version segment stays, above the data id, and is shared across
substrates.** It versions the interpretation of the bytes, not the shape of the
path: `v2` was the document collapse
([ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md))
and `v3` the owed-row collapse
([ADR-0301](0301-owed-updates-collapse-into-one-resendable-row-and-the-fold-stops-asking-whether-a-store-syncs.md)),
where "the value changed rather than the schema." After this collapse a `v3`
record could be offered to an authority its address never scoped it to, so the
format earns `v4` on both substrates. A desktop record has no `v1` through `v3`
to leave behind, and that is a fact about desktop rather than a second numbering.

**Put the version where the decision is made.** App-owned SQLite is *migrated*,
so its schema version lives in `PRAGMA user_version` and never in a filename
([ADR-0319](0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md)).
Epicenter Data *strands*: a record written under an older shape sits at a name
nothing opens, so it is never read rather than detected and wiped. Its version
therefore has to be readable without opening anything, which is what a segment
you can `ls` is for. The two conventions differ because the decisions differ,
not by inconsistency.

**`gen/` is deleted.** `newestGeneration` enumerates by prefix and parses the
remainder as a number, rejecting anything that is not one, so the word defended
nothing. The trailing `/` on the prefix stays load-bearing: it is what stops
`foo.bar` from prefix-matching `foo.barbaz`.

**The app id appearing twice in a desktop path is informative, not redundant.**
The app segment says whose replica this is; the data id is a global identity.
They coincide only when an application names its data after itself.

## Consequences

- Six segments become four plus a version. `canonicalBaseURL` leaves the
  addressing path entirely; it survives only where a URL is compared.
- The `local`/`account` fork disappears from every opener, mirror path, and
  export path, because there is one kind of address.
- What the address stopped carrying has to be carried somewhere. That is
  [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md):
  a write-once stamp inside the database, and one refusal at open.
- Honeycrisp's two routes are one route. That consequence was written for the
  two-data-ids clause ADR-0336 withdrew; what actually happened is that the
  device store went, so `/device`, its store switcher, and the boot copy that
  chose between two notebooks went with it.
- Permanently device-authoritative *structured* data is app-owned SQLite
  (ADR-0321), not Epicenter Data with `authority: 'none'`. The `'none'` value is
  for a database that is Epicenter Data and has no server yet, not for a second
  storage kind; ADR-0318 refuses a third kind by name.
- Existing `v3` records are stranded, which is what a version bump has always
  meant here. No importer, no probe, no migration.
- **This corrects a live defect, in two forms.** Today every application in the
  desktop WebView shares one loopback origin and the browser address names no
  application. Concurrently, the second application to open a shared data id is
  refused with `AlreadyOpen` by a claim it has no way to interpret, because the
  lock is named after the address (`claims.ts`). Sequentially, the two write
  interleaved histories into one record, which nothing surfaces at all. One
  segment fixes both.

## Considered alternatives

- **Keep the partition segments.** Rejected: they encode a device-wide constant,
  and the isolation they provide is replaced by a stamp plus the refusal in
  ADR-0325 at a much smaller cost. Until that stamp lands, two principals on one
  device share one address, which is the window this record opens and ADR-0325
  closes.
- **Verify the app id, or derive it from the bundle.** Rejected, and ADR-0334
  is why: the enforcement point is the person's own machine, where the code
  being restrained already runs as them. A check here would be a lock with no
  door, and this record would be shipping a false invariant.
- **Version in the leaf (`<n>.v4.sqlite`) or on the data-id directory
  (`<data-id>.v4/`).** Rejected. The leaf spelling cannot exist in a browser,
  where the address has no file extension, so one grammar dies. The data-id
  spelling decorates a global identity, making the exact string ungreppable on
  disk. Both spell a global fact once per database and invite it to be locally
  wrong.
- **Fuse the version to the namespace (`data.v4/`).** Rejected: `data/` should be
  a stable name, so that "does this app hold Epicenter Data" is a fixed path and
  not a glob, and so a format bump does not rename a directory every script knows.
- **Restart the desktop version at `v1`.** Rejected: ancient `v1` records may
  still be resident in browsers, and a reader at `v1` would prefix-match them.
- **Delete the version segment.** Rejected: `v1` through `v3` happened within
  months. Removing it reinstates the format certificate, the comparison at every
  open, and the wipe that followed, which is the code this scheme exists to make
  unwritable.
