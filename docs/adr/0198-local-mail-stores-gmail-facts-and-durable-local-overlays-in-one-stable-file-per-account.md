# 0198. Local Mail stores Gmail facts and durable local overlays in one stable file per account

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amends:** [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) at its disposability clause only (the mirror is no longer wholly replaceable, because one tier of it is now the only copy); [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) by withdrawing its versioned-artifact lifecycle from Local Mail, which stops being a mirror (the record continues to govern Local Books unchanged); [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) at its local-only-state refusal, which gains one bounded exception: a Gmail-expressible mutation may be staged durably on disk before it round-trips
- **Relates:** [ADR-0199](0199-every-local-mail-write-is-a-local-intent-and-sync-is-the-only-provider-transition.md) (who may write this file), [ADR-0200](0200-an-offline-draft-edit-replaces-a-known-gmail-drafts-whole-mime-content.md) (the second overlay kind), [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) (the process topology this storage sits inside), [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) (the change feed that refreshes the fact tier), [ADR-0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md) (Local Books' write door, which stays a mirror discipline and is not what this record builds)

## Context

ADR-0196 and ADR-0197 settled Local Mail's storage as a mirror: a disposable
local copy, named by a corpus version, rebuilt by re-pull, with the predecessor
retained but never consulted. That whole lifecycle rests on one sentence in
ADR-0196: "Nothing in it is irreplaceable, so retaining a predecessor is a
convenience and reclaiming it is safe."

The accepted product direction breaks that sentence. Local Mail is to hold
durable local pending state: an edit to a Gmail draft typed with no network, an
archive performed offline that Gmail has not seen yet. Neither is re-pullable.
For as long as it is pending, the local file is the only copy.

One irreplaceable byte invalidates the mirror lifecycle around it. Under
ADR-0197 a corpus bump names a **new, empty** artifact, and that record
explicitly refuses to carry the predecessor's rows forward ("this is a
migration, and the authority is one re-pull away"). So a routine version bump
would strand a user's unsent draft in a file nothing ever reads again.
ADR-0196 predicted this exact failure for a different payload: "Had attachment
bytes lived here, deleting an artifact could destroy the only local copy of
something Gmail no longer serves, and the cheap reclamation of ADR-0197 would
have become a data-loss decision."

## Decision

**Local Mail's storage is one stable SQLite file per Gmail account holding three
tiers with different truth ownership. It is a mailbox database, not a mirror,
and ADR-0197's versioned-artifact lifecycle no longer applies to it.**

### The three tiers

1. **Provider facts.** Gmail owns them; Local Mail materializes them. Messages,
   labels, Gmail drafts, and the sync cursors. Every value here is re-pullable
   and nothing here is ever authored locally. ADR-0196 continues to govern this
   tier in full: what a message row stores, the column test, and the one
   `messages.get(format=full)` per message that is the entire per-message
   budget.
2. **Local overlays.** Local Mail owns them; Gmail has not confirmed them yet.
   An overlay row is **a desired end state keyed by the provider's own stable
   identifier**, never an operation log. Exactly two kinds exist in v1: a
   label, archive, and trash override keyed by message id and label id, and a
   draft body replacement keyed by Gmail draft id (ADR-0200).
3. **Derived indexes and projections.** Owned by neither, recomputable from
   tiers 1 and 2 at any moment, and therefore free to add or drop.

The tier a piece of state belongs to is decided by one question: **if this file
were deleted, could Gmail supply it again?** Yes is tier 1. No is tier 2. Tier 3
never has to answer, because it is computed from the other two.

### One file, and its name is stable

The artifact is `<dataDir>/<accountEmail>/mail.db`. There is no versioned
filename, no artifact inventory, no predecessor, no reclamation, and no filename
grammar for Local Mail.

A corpus-contract change rebuilds **tier 1 in place**: in one transaction, drop
the fact tables, recreate them from the current declaration, and clear the
cursor. Tier 2 is never touched by a rebuild, which is the entire reason the
tiers are separate tables rather than columns on one row. Tier 3 is recreated on
every open, exactly as indexes already are.

The corpus version therefore lives in `_meta` and governs tier 1 alone. Bumping
it still costs a full re-pull at ADR-0196's price; what it no longer costs is a
new file, a retained predecessor, or a user's pending work.

### Reads compose facts and overlays

A normal read returns tier 1 composed with tier 2. The composition lives in SQL,
as views over the fact and overlay tables, so every read surface (the HTTP read
model, the MCP `query` verb, the CLI) receives one composition and none of them
can drift from another.

**Every composed row states whether an overlay contributes to it.** A UI may
show a message as archived while the archive is still local, and it must say
that the change has not reached Gmail. Looking updated is allowed; looking
synchronized is not.

### Accounts are independent

One account, one file, one set of cursors, one set of overlays. Nothing is
stored across accounts. An aggregate inbox is a UI composition over several
mailboxes and has no storage of its own.

### What this record does not change

- ADR-0196's per-message budget, refusals, and column test. Untouched.
- ADR-0197's decision for Local Books, which remains a pure mirror and keeps
  `mirrorAt`. Untouched.
- ADR-0098's round-trip rule. Every overlay is a Gmail-expressible mutation that
  round-trips on the next sync; snooze and send-later stay refused.

## Consequences

- **Local Mail stops importing `@epicenter/sqlite/bun-mirror`.** Deleted with
  it: the versioned filename, `mailMirror`, `artifacts()`,
  `reclaimPredecessors()`, the `predecessors` field on `status`, the retention
  story, and ADR-0197's standing "inert pre-grammar `mail.db` a human removes by
  hand" consequence, since `mail.db` is the file again.
- **ADR-0197's quiescence blocker disappears for Local Mail.** That record could
  not automate reclamation because unlinking a predecessor's `-wal` under a live
  read-only handle is a corruption vector. With one file there is nothing to
  unlink; an in-place tier-1 rebuild is an ordinary WAL transaction, and a
  concurrent reader sees a consistent snapshot on either side of it.
- **`packages/sqlite/bun-mirror` drops to one consumer.** Named, not decided
  here: if Local Books ever stops being a pure mirror, the primitive has no
  consumers left and should be deleted with its last one rather than kept as
  infrastructure.
- **The file is now partly irreplaceable, so its loss posture changes.** Losing
  it loses unsynchronized local work, not merely a cache. The exposure is
  bounded by the refusals in ADR-0199 and ADR-0200: nothing can sit pending
  invisibly, and no promise is made that pending work lands while the app is
  closed.
- **A corpus rebuild is destructive to tier 1 in place.** During a rebuild the
  user holds a partial mailbox and no complete local copy, where ADR-0197 kept a
  complete predecessor beside the successor. Accepted: `status` already reports
  `building` for exactly this state, and the alternative is a second file that
  every read has to compose across.
- **The revert-a-bad-bump property is lost.** Under ADR-0197 a bad version bump
  was a revert; here it is a re-pull. Accepted, because the thing that made the
  predecessor precious (it might hold the only copy of something) is precisely
  what tier 2 now guarantees survives a rebuild anyway.
- **ADR-0098's mechanical guard gets sharper, not weaker.** That record's
  surviving guard is that local-only state must appear in a reviewed table
  declaration to exist at all. Tier 2 makes the declaration say so out loud: an
  overlay table is visibly not a fact table, and a reviewer asking "why is this
  not re-pullable" has a named place to ask it.

## Considered alternatives

- **Two files per account: a versioned facts file plus a stable overlay file.**
  Rejected. Every read composes across both, so composition becomes a
  cross-file join (an `ATTACH` or an application-level merge), the write door
  spans two files, and "which file is the mailbox" has no answer. It buys back
  predecessor retention at the cost of the single-owner property this record
  exists to establish.
- **Keep the versioned filename and reproject overlays into the successor on
  bump.** Rejected. That is the migration ADR-0197 already refused, and it is
  strictly worse here: a failed reprojection destroys the only copy of the
  user's unsent work, where under ADR-0197 the worst case was repeating a
  re-pull.
- **Keep overlays outside SQLite, in a JSON sidecar.** Rejected. Reads compose
  facts and overlays on every triage query, so overlays must be joinable. A
  sidecar means loading it into the process on every read and reimplementing the
  read model's filters and ordering in TypeScript, which is exactly where the
  UI's `optimistic.ts` already is and exactly what this direction deletes.
- **Store overlays as extra columns on the message fact row.** Rejected. It puts
  the only local copy inside the table a rebuild drops, which is the failure
  this record exists to prevent, and it makes local state visually
  indistinguishable from a fact column in review.
- **Keep the mirror and refuse offline writes entirely.** Rejected: it is the
  current shape. A triage action with no network fails outright while the UI
  shows optimism that evaporates on the next reload, and a draft cannot be
  touched at all.
