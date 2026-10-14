# 0196. Local Mail's mirror is a reader, and one full message fetch is its entire budget

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates:** [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) (push-free `history.list` polling is the change feed this budget is spent against), [ADR-0083](0083-apps-email-is-refused-local-mail-is-the-only-gmail-client.md) (Local Mail is the only Gmail client, so no second surface can quietly fetch what this refuses), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (Gmail holds every state a human acts on; this record decides what the mirror keeps a copy of, not what it authorizes), [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) (Gmail owns truth and the mirror is disposable; this record prices what "disposable" costs to rebuild), [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (the shipped distribution's Gmail identity, whose per-user quota this budget draws on), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (a corpus-version bump names a new artifact and costs a full re-pull, which is what makes the per-message budget the dominant rebuild cost)

## Context

Local Mail's mirror is about to be redeclared under ADR-0197: the hand-stamped
<!-- doc-path-check: ignore-next-line -->
`SCHEMA_VERSION` in `apps/local-mail/src/db.ts` goes away, and the stored shape
becomes a reviewed declaration whose fingerprint names the file. That turns the
column set from something that accretes into something decided once, and it puts
a price on the decision. Under ADR-0197 a version bump is a full re-pull, and
Gmail's backfill is paginated `messages.list` plus one `messages.get` per id. So
"what does Mail store" and "what does Mail spend per message" stopped being two
questions.

The code answered both by accident. `messages` stores the parsed
`messages.get(format=full)` resource in a column named `raw`, which is exactly
the name of the format the app never fetches
<!-- doc-path-check: ignore-next-line -->
(`apps/local-mail/src/gmail-client.ts` sends `format: 'full'`). Three scalar
columns sit beside it (`subject`, `sender`, `body_text`) while `thread_id`,
`snippet`, `label_ids`, and `internal_date` are SQLite generated columns and
`To`, `Date`, and the HTML body are recomputed on every read
<!-- doc-path-check: ignore-next-line -->
(`apps/local-mail/src/db.ts`, `apps/local-mail/src/message-fields.ts`). The split
is defensible but nothing recorded why it falls there, so the next column has no
test to pass.

Meanwhile there is a standing pull toward archive, and it arrives one small
repair at a time. A message whose body Gmail externalized renders empty; the
obvious fix is one `messages.attachments.get`. Attachments appear in the payload
as metadata with no bytes; the obvious fix is an `attachments` table and a blob
cache beside the mirror. Each fix is individually cheap and each one buys the
same three things: a second per-message network call, an on-disk byte store that
the fingerprint model does not name or reclaim, and an implied promise that the
local copy is complete. Nothing else in Local Mail makes that promise.

## Decision

**Local Mail's mirror is a disposable offline reader, not an archive. It spends
exactly one `messages.get(format=full)` per message and makes no other
per-message network call.**

That sentence is the invariant. Everything below follows from it, and any future
feature that cannot be built within it is refused rather than accommodated.

### What one synchronized message means

A message is synchronized when its `messages.get(format=full)` resource is
stored. There is no partially synchronized message, no completion pass, and no
background job that returns to finish one. A row is the whole of what Local Mail
will ever hold about that message until Gmail's own change feed says the message
changed.

Per-mailbox calls stay as they are: `messages.list` for the id spine,
`history.list` for the incremental feed, `labels.list` for the label set,
`getProfile` for the pre-backfill `historyId` baseline. Those are per-page or
per-pass, not per-message, and this record does not touch them.

### What it stores

Three tiers, in this order:

1. **The parsed resource, verbatim, as JSON.** One column holds exactly what
   `messages.get(format=full)` returned. Storing it whole is what makes every
   other tier optional: a field nobody projected today is still on disk
   tomorrow.
2. **Every column SQLite can project from it.** If SQLite can compute a column
   from the stored JSON (`json_extract` and friends, as generated columns), it is
   a generated column and not a stored derivation. These cost nothing to keep
   correct, because they cannot disagree with the resource.
3. **Exactly those additional columns that SQL cannot project but pushed-down
   search and sort need.** This set is currently closed at `subject`, `sender`,
   and `body_text`. Each earns its place the same way: the triage read pushes
   its filter and its ordering into SQL so the process never materializes the
   mailbox, and none of the three is reachable by `json_extract` (headers are a
   name/value array, and the body is base64url inside a MIME tree).

Everything else is derived at read time. `To`, `Date`, and the HTML body already
are; nothing in the current surface needs a fourth stored derivation.

The test for a proposed column is therefore not "is it useful" but: **can SQLite
project it, and if not, does a pushed-down filter or sort require it?** A column
that fails both is a read-time derivation. Adding one is not free either way,
because under ADR-0197 it bumps the corpus version and costs a full re-pull.

### What it refuses

- **`format=raw`.** The reader wants the parsed payload Gmail already assembled,
  not an RFC 5322 blob to parse locally. Fetching both is two per-message calls
  for one message.
- **`messages.attachments.get`.** This is the single refusal that keeps the
  budget at one call.
- **Attachment and media bytes on disk, in any form.** No attachment table, no
  blob cache, no media directory beside the mirror. ADR-0197's filename grammar
  and grammar-scoped `reclaim` cover mirror artifacts only; a byte store beside
  them would be unnamed, unreclaimed, and would silently survive every rebuild.
- **Fetching or rendering remote and inline media in the UI.**
<!-- doc-path-check: ignore-next-line -->
  `apps/local-mail/ui/src/lib/sanitize-email.ts` already strips `src`, `srcset`,
  `background`, `poster`, `lowsrc`, and `url(...)` styles, and
<!-- doc-path-check: ignore-next-line -->
  `apps/local-mail/ui/src/lib/components/MessageBody.svelte` renders only that
  sanitized output. That was written as a tracking-pixel defence; this record
  makes it a storage decision too. There is no inline-media path for locally
  stored bytes to feed, because there are no locally stored bytes.

Attachments and media are metadata only: the filename, MIME type, and size that
ride inside the stored resource. That is enough to say "this message has a
42 KB PDF" and not enough to open it. Opening it is Gmail's job, on the same
account, in the browser or the phone app that ADR-0098 already routes to.

### What happens when Gmail externalizes a body part

A message part body carries either inline base64url `data` or an `attachmentId`
naming bytes that only `messages.attachments.get` returns. Gmail decides which,
and `format=full` does not guarantee the first. When the body part a reader would
show arrives as an `attachmentId`, **Local Mail reports that it has no offline
body for that message and does not fetch it.** The row is still synchronized; its
headers, labels, snippet, and metadata are all present and all correct. The body
is simply not local.

This is stated plainly so nobody reads the mirror as complete. Some messages have
no offline body, and the honest reader says so rather than spending a second call
per message to make the sentence "every message has a body" true.

### The stored payload is named `resource`, not `raw`

In Local Mail the column holding the parsed `messages.get(format=full)` payload
is named `resource`. `raw` is Gmail's own term for a precisely different thing:
`format=raw` returns the base64url RFC 5322 message, which this app never
fetches. A column named `raw` holding a parsed resource is a false statement in
<!-- doc-path-check: ignore-next-line -->
the schema, and it has already leaked into prose (`apps/local-mail/src/db.ts` and
<!-- doc-path-check: ignore-next-line -->
`apps/local-mail/src/message-fields.ts` both describe deriving HTML "from `raw`",
meaning the parsed JSON).

The rename covers the messages table, which is where the collision is. The
labels table stores `labels.list` output, a format Gmail offers no `raw`
alternative to, so renaming it is a coherence call for whoever writes the
declaration, not a decision this record makes.

This is a Local Mail rename, decided by Gmail's vocabulary. It is not a
cross-app symmetry requirement: Local Books' `raw` column holds verbatim
QuickBooks JSON, QuickBooks has no competing meaning for the word, and nothing
here asks Books to change.

## Consequences

- **The blob subsystem never gets built.** No attachment table, no byte store, no
  cache eviction policy, no reclaim path that ADR-0197's filename grammar cannot
  express, no partial-message state machine, no completion protocol. The one
  invariant at the top of the Decision forecloses the entire family, which is
  the point of writing it as an invariant rather than a feature list.
- **Rebuild cost is a straight multiplication, so it can be reasoned about.**
  Verified against Gmail's per-method quota table (2026-07-31):
  `messages.get` costs 20 quota units, `messages.attachments.get` costs another
  20, `messages.list` costs 5 per page, `history.list` costs 2, and a user is
  capped at 6,000 units per minute. A full backfill is therefore ~20 units per
  message plus 5 per page. Adding a second per-message call would roughly double
  a rebuild that ADR-0197 already makes routine (any corpus-version bump triggers
  one), against a per-user ceiling that a large mailbox already spends hours
  under.
- **Some messages show no body.** Accepted, named, and surfaced rather than
  papered over. The alternative costs the doubling above on every message to fix
  a minority of them.
- **The mirror is honestly disposable, which keeps ADR-0116 and ADR-0197 true.**
  Nothing in it is irreplaceable, so retaining a predecessor is a convenience and
  reclaiming it is safe. Had attachment bytes lived here, deleting an artifact
  could destroy the only local copy of something Gmail no longer serves, and the
  cheap reclamation of ADR-0197 would have become a data-loss decision.
- **No archive, export, backup, or fidelity promise.** Local Mail does not claim
  the local copy reproduces the mailbox, and does not ship an export. Google
  Takeout is the tool for that and Local Mail does not compete with it. This is a
  refusal, not a deferral with a roadmap slot.
- **Two stale sentences elsewhere are corrected, not by this record.** ADR-0098's
  "a `SCHEMA_VERSION` bump destroys any state stored in mirror tables" and
  ADR-0116's "it can be dropped and rebuilt on a schema-version bump" both
  described the destroy-on-open mechanism ADR-0194 withdrew and ADR-0197 keeps
  withdrawn. Both are amended in place with `Amended by: ADR-0197`. The
  substance ADR-0098 loses is a mechanical guard against smuggling local-only
  state into the mirror; under ADR-0197 that guard is review of the declaration
  shape, which is where a new column now has to appear to exist at all.
- **Reversible if a promise ever earns it.** The reopen trigger is a concrete
  product commitment that requires bytes offline (an offline attachment viewer, a
  stated backup claim). That takes a new ADR that names where the bytes live, who
  reclaims them, and what the rebuild then costs. Until then, "it would be nice
  to have the PDF" is not a reason.

## Considered alternatives

- **Fetch `messages.attachments.get` for externalized bodies only.** Rejected: the
  narrow version is not narrow. The mirror cannot know a part is externalized
  without already having the resource, so it becomes a conditional second pass
  with its own retry, partial state, and completion definition, plus the byte
  store the bytes have to land in. It also has no stable boundary: once the
  machinery exists, "just the body" and "also the PDF" differ by one predicate.
- **`format=raw` instead of `format=full`.** Rejected: it moves MIME parsing into
  the app, throws away the payload tree Gmail already built and the read surface
  already walks, and does not solve externalized parts anyway.
- **Store both `full` and `raw`.** Rejected: two calls per message, and the second
  buys archive fidelity the product explicitly does not promise.
- **Add an `attachments` table with metadata only, no bytes.** Rejected as
  redundant rather than harmful: attachment metadata is already inside the stored
  resource, so a table is a projection SQLite can compute, and by tier 2 above it
  would be a generated column if a surface ever needed one.
- **Keep the column named `raw` for symmetry with Local Books.** Rejected:
  symmetry between two apps is worth less than a column name that does not
  contradict the API it mirrors. The two mirrors share a lifecycle contract
  (ADR-0197), not a schema, so their column names answer to their own upstreams.
- **Cache media the sanitizer strips, so formatted mail renders fully.**
  Rejected: it reintroduces per-message network calls, an unreclaimed byte store,
  and the tracking-pixel exposure the sanitizer exists to refuse, in exchange for
  visual fidelity in a triage reader.
