# 0319. Local Mail is device-local, and its storage splits by lifetime

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amended by:** [ADR-0368](0368-local-mail-preserves-known-cache-schemas-during-upgrades.md), preserving known cache schemas during upgrades.
- **Built.** The subject is the partition key, the two lifetimes are two kinds
  of file, `user_version` carries the shape, and `TRUSTED_DEFINITIONS` is empty.
  What this replaced: a minted `accountId` row in Epicenter Data, one shared
  `mail.sqlite` partitioned by an `account_id` column, and a separate
  `intent.sqlite`.
- **Amends:** [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md)
  at the partition level, which is withdrawn: a partition is a filename
  (`mail-<sub>.sqlite`) rather than a directory segment.
- **Amends:** [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) at the account registry's home and at its synchronization, which are both withdrawn. Its obligations table row "which accounts are connected | a person's own data | Epicenter Data, synchronizes" is replaced by a table in the application's own durable SQLite, which does not synchronize: the credential cannot, so a row on a device holding no credential lists an account that device cannot read. Its rejection of "the account list in the application's own SQLite" is withdrawn with its premise. That rejection reasoned that ADR-0306 makes the file deletable at any moment, so clearing a cache would sign a person out of every account. Splitting storage by lifetime dissolves it: the registry lives in the file that is never unlinked, beside the durable triage, and a cache reset unlinks a different file. The labeled secret, the absent `secrets.list`, the browser leaf that keeps nothing, and "deleting the mailbox does not sign anybody out" all stand, and the last one is now true by the layout rather than by which store holds the list.
- **Relates:** [ADR-0318](0318-epicenter-data-is-what-epicenter-is-the-authority-for-and-a-foreign-write-is-a-command.md) (the classification test this record applies), [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) (the obligations each class carries), [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) (the application-scoped directory), and [ADR-0317](0317-local-mail-is-an-epicenter-application-without-a-standalone-cli.md) (Local Mail's one application lifecycle)

## Context

Local Mail holds several Gmail accounts at once, and an earlier draft of this
record put every account's rows in one application-owned database keyed by a
minted `accountId`, with the account registry in Epicenter Data. Three things
broke that shape.

The minted id is allocated by a row that removal deletes, and the id is the only
way back to the rows filed under it, so disconnecting an account and connecting
it again mints a second id and strands the first account's undelivered triage
where nothing can name it.

ADR-0318 then replaced the classification test, and the new test answers this
application differently than the old one did.

Gmail's restricted scopes make a server the expensive boundary: an application
that keeps every byte on the machine stays in personal use, and one that moves
Gmail-derived rows through a server acquires an annual third-party security
assessment.

## Decision

**Run ADR-0318's test per artifact, not per application, and Local Mail holds no
Epicenter Data for any artifact it has today.**

```txt
  the mail copy          Gmail is the authority           -> the app's SQLite
  undelivered triage     a command to Gmail (ADR-0318)    -> the app's SQLite
  the credential         Google issued it                 -> the OS keychain
  which accounts are     the credential that makes a      -> the app's SQLite
  connected here         connection real is device-local
```

The claim is about these four artifacts and not about the application. A
preference belongs to nobody but the person, so Epicenter is the authority for
it and it is an Epicenter Data document with empty tables on the day the first
one exists.

**The partition key is the provider subject.** Google returns the same `sub`
every time, so a reconnected account lands on its own rows by arithmetic rather
than by lookup. Nothing is allocated, so nothing can be allocated twice, and the
stranded-partition failure above is unrepresentable rather than guarded against.

**Storage splits by lifetime, and there are two.**

```txt
 <epicenter-data-root>/apps/so.epicenter.local-mail/sqlite/
 ├── local.sqlite            durable, kilobytes, migrated, never unlinked
 │     accounts       (sub PK, email, connected_at, last_synced_at)
 │     label_intents  (sub, message_id, label_id, want, seq, asserted_at)
 │     intent_meta    (sub, key, value)
 └── mail-<sub>.sqlite       borrowed, gigabytes, unlinked routinely
       cache_meta (key, value)
       messages   (id, resource, subject, sender, body_text, ...)
       labels     (id, resource, ...)
```

`local.sqlite` is the file a person would copy to keep their own bytes, and
nothing copies it for them. No backup verb is decided here and none should be:
the exposure is that losing the device loses triage Gmail was never told about,
the window is bounded by delivering continuously while the application is open,
and it is the same loss as an unsent draft in any mail client. That sentence has
to stay true when read aloud, and it does.

The account registry joins the triage because they share a lifetime, which makes
removing an account one transaction over one file. The mail copy stays out
because it shares nothing with them but an owner.

**The schema version lives in `PRAGMA user_version`, never in a filename.** The
same integer means opposite things, which is the split stated a second way: in
`local.sqlite` it is a migration cursor, and in a mail file it is a demolition
trigger, so a build that wants a shape the file does not have closes it, unlinks
it, recreates it, and pulls Gmail again.

**`openSqlite(name)` is unchanged.** It still refuses an account argument, for
the reason the earlier draft gave and this record keeps: an arbitrary-SQL handle
cannot enforce row scoping by receiving an id, so account scoping is application
meaning. A per-account file is the scoping a SQL handle does enforce, and the
application derives the name.

## Consequences

- An account's rows leave `local.sqlite` one at a time inside a transaction, and
  a mail file leaves all at once through unlink. Never the reverse.
- Clearing a borrowed copy is a syscall rather than a delete of millions of rows
  followed by a `VACUUM` that needs as much free disk again as the file it
  rewrites. The platform never grows a compaction verb.
- Corruption in a mail file costs one account's re-pull, in hours and metered
  quota, and costs nothing a person authored. The file being rewritten hardest
  is no longer the file holding the only irreplaceable bytes.
- A person's own data is one small file, so backing it up is a copy rather than
  a selective exporter that has to be kept in step with the schema. Nothing
  performs that copy today, and this record does not decide that anything should.
- An account is connected per device. The credential could never synchronize, so
  no convenience is lost that was ever available.
- `TRUSTED_DEFINITIONS` (since deleted with the admission protocol, ADR-0334) becomes an
  empty array when Local Mail's registry leaves, and ADR-0313's admission path
  keeps compiling with no member. That is expected, not rot: Honeycrisp earns a
  row the day it opens through the scoped handle, and Local Mail earns one the
  day it holds its first preference.
- Nothing derived from Gmail leaves the machine, which is the compliance posture
  and the product promise in one clause.

## Considered alternatives

- **One file for everything.** Rejected. The write path never crosses the two,
  because the effective-label overlay is applied at read time from a small
  pending set, so the collapse buys no atomicity. What it costs is real: the only
  irreplaceable bytes would share a file, a backup unit, and a corruption fate
  with the most disposable ones.
- **A minted row id as the partition key.** Rejected. It is allocated by the row
  that removal deletes, so it can be allocated twice for one account.
- **One shared mail file partitioned by a column.** Rejected. Removing an account
  becomes a multi-table delete leaving free pages, and resetting one account's
  copy stops being a syscall.
- **A version in the filename.** Rejected. The version is a property of the
  contents and the name is the identity, and a versioned name needs a sweeper to
  delete the file the previous build left behind.
