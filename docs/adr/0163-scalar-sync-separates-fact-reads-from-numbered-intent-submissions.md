# 0163. Scalar sync separates fact reads from numbered intent submissions

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-21: one kindless fact shape, four
  discriminated operations, named replica lanes, persisted sealed request
  bytes, and a restricted address grammar; revised 2026-07-22: dotted values
  record keys)
- **Supersedes:** [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md), [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md), and [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
- **Amends:** the scalar protocol in [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md)
- **Amended by:** [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md) (the convergence unit), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md) (lifetime replacement), and [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md) (the obligation law)
- **Relates:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md) and [ADR-0177](0177-replica-and-authority-owners-use-role-specific-wide-record-relations.md)

## Context

Scalar synchronization has two independent jobs. A replica learns current
authority facts, and it submits durable local intents for authority
adjudication. Combining those jobs into one exchange introduced a frozen scan
ceiling, page continuations, batch receipts, and settlement watermarks whose
meanings overlapped. It also made transport grouping look like a semantic
commit even though records converge independently under ADR-0164.

The protocol needs exact retry, bounded transfer, crash-resumable progress,
terminal deletion, and authority-lifetime replacement. It does not need a
retained change log, an exact authority checkpoint, remote transaction groups,
or a distinct acquisition mode. It also does not need to know how a Lens
interprets a record: collection kinds exist only in Lens definitions
(ADR-0160), so the wire carries no address kind.

## Decision

One automatic runtime coordinates two versioned HTTP operations for the whole
Epicenter:

```txt
GET  /api/sync/v1/facts
POST /api/sync/v1/submissions
```

They are separate wire operations, not separate application actions or public
sync controls. Applications only make typed local reads and writes.

### Facts are current authority state

The authority stores one current fact at every record address. Each change to
that current fact receives one unique increasing authority sequence. Sequence
zero means that a replica has learned nothing; every assigned sequence and
submission number is a JSON-safe positive integer. There is one fact shape:

```ts
type RecordAddress = {
  namespace: string;
  collection: string;
  recordKey: string;
};

type Fact = {
  address: RecordAddress;
  sequence: number;
  state: "live" | "tombstone" | "unset";
  payload?: JsonValue; // present exactly when state is "live"
};
```

The stored state, not a caller species, carries the meaning of absence:
`tombstone` is terminal absence within one authority lifetime, and `unset` is
reversible absence. An empty object and `null` are ordinary live payloads,
never absence. The wire contains no address kind, flat qualified key, prefix
parser, or redundant definition-owned key.

Address coordinates admit a restricted grammar, enforced at every admission
boundary: no lone surrogates, no NUL, no unpaired combining edge cases. Table
record keys are runtime-minted `[a-z0-9]{24}`. Namespaces use the
reverse-domain grammar; collections use the Lens local-key grammar, and a
values collection's declared record keys use the dotted values-key grammar
(one or more dot-separated local-key segments, such as
`transcription.language`), both enforced by `parseLens` (revised 2026-07-22:
values record keys admit dotted segments; dotted names are durable
interoperation vocabulary and hidden aliasing is refused). Because the wire
carries no collection kind, record-key admission is the union of the mint and
the dotted values grammar; mints contain no dots, so the grammars cannot
collide. All patterns remain ASCII, so canonical address ordering is
unsigned bytewise UTF-8 comparison with no Unicode ambiguity.

### A replica reads after one sequence

A bound replica requests facts whose current `sequence` is greater than its
durable `afterSequence`:

```http
GET /api/sync/v1/facts?authorityLifetime=01J...&afterSequence=84
```

A fresh replica may omit `authorityLifetime` only with `afterSequence=0`. The
response supplies the active lifetime, and the replica binds to it before it
may submit local intents. Every later facts request supplies the bound lifetime.
A different lifetime is a terminal mismatch: erase the superseded replica,
bind to the successor, and reacquire from zero. An `afterSequence` beyond the
active authority's sequence in the same lifetime is corruption, not Restore
recovery.

The authority reads one consistent snapshot and returns the largest ordered
prefix that fits the V1 response budget:

```ts
type FactsResponse = {
  authorityLifetime: string;
  facts: Fact[];
  hasMore: boolean;
};
```

`hasMore` means that the same read snapshot contained at least one additional
qualifying fact after the returned prefix. It is not a remaining count or a
promise that newer writes cannot appear after the response.

Inside one local transaction, the replica verifies that the response lifetime
still equals its attached lifetime, installs the complete returned prefix, and
persists the final returned sequence. This admission check prevents a delayed
response from a superseded lifetime contaminating a replica that has erased and
rebound after Restore. Fact installation is monotonic per address: a higher
sequence replaces the confirmed fact, a lower sequence is ignored, and an
equal sequence must be semantically identical or the replica reports
corruption. The facts feed still advances `afterSequence` to the prefix's final
sequence when an older per-address fact is ignored. The next sequence is
derived, never sent:

```ts
const nextAfterSequence =
  response.facts.at(-1)?.sequence ?? requestedAfterSequence;
```

The replica never adds one because the query is already exclusive and sequence
gaps are valid. `hasMore: true` causes an immediate request with the derived
`afterSequence`. An empty response has `hasMore: false`.

There is no `next`, `through`, `position`, opaque cursor, completed checkpoint,
or separately durable acquisition state. A crash after a committed prefix
resumes after that prefix. A crash before commit repeats it. Concurrently
rewritten facts move forward to a higher sequence and remain discoverable.

### Submissions carry four desired operations

Typed application verbs remain ergonomic: table `create`, `update`, and
`delete`; value `set` and `unset`. They lower into a smaller synchronization
algebra of four discriminated operations at one record address:

```ts
type Intent = { address: RecordAddress } & Operation;

type Operation =
  | { op: "patch"; set: JsonObject; unset: string[] } // make or keep present by folding fields
  | { op: "replace"; value: JsonValue } // make or keep present by whole replacement
  | { op: "tombstone" } // terminal absence in this lifetime
  | { op: "unset" }; // reversible absence
```

Table create and update do not exist on the wire: both become a `patch`, which
the authority folds over the live payload, or over an empty object when the
address has no live fact. `patch` requires an object base; folding it over a
non-object live payload is refused as `patch-base-not-object`. `replace`
installs a complete value. `tombstone` installs or preserves terminal absence.
`unset` installs or preserves reversible absence.

One composition law governs pending compaction, parked compaction at
settlement, and the authority fold alike, and absorption is evaluated first:
if the existing state or existing composed operation is `tombstone`, every
later operation composes to `tombstone`. Only then do the remaining rows of
the composition table apply. A stored tombstone therefore settles any later
operation as superseded without resurrection, even across independently
installed Lenses that disagree about a collection. `unset` followed by
`replace` is legal resurrection, because `unset` is a different stored state
than `tombstone`.

Every pre-attachment write already records its ordinary compacted pending
operation. When an unattached replica chooses `Bring local data` under
ADR-0161, attachment preserves those operations, learns the authority
lifetime, and makes them eligible to seal. It never derives intents by
scanning visible state. Independently minted table record keys ordinarily form
a union. At a shared live address, the brought operation is ordinary newer
desired state: disjoint top-level patches compose, and a brought `replace` or
same-field `patch` may replace the current live value when the authority folds
it. A stored tombstone still settles a brought operation as superseded, and a
brought `tombstone` is an ordinary offline deletion. First attachment adds no
import operation, historical fact replay, timestamp comparison, or conflict
record.

### Replica lanes carry the crash state

Each replica record has three lanes plus one overlay, each required by a named
crash:

```txt
confirmed   the latest authority truth learned locally
sealed      the immutable in-flight desire
pending     the mutable compactable current desire
parked      the retained refused operation: a visible, non-retrying overlay
```

Before sealing, the replica compacts pending work to at most one operation per
address. One replica has at most one sealed submission in flight:

```ts
type SubmissionRequest = {
  authorityLifetime: string;
  replicaId: string;
  submissionNumber: number;
  intents: Intent[];
};
```

`replicaId` owns one ordered retry stream. `submissionNumber` starts at one and
increases by one after each completed submission. A lost response retries the
same replica ID, number, and semantic intents. The authority stores the last
number and an internal hash of the canonical parsed request. The same number
and hash is an exact retry; the same number with another hash is a replica fork
or corruption; a skipped number is refused. The hash is not a public wire
field, digest identity, or application concept.

V1 canonicalizes every validated semantic request with the
[JSON Canonicalization Scheme in RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)
and hashes its UTF-8 bytes. The same canonical bytes define semantic admission
sizes across browser, Bun, and Cloudflare runtimes. The V1 schemas separately
bound every address coordinate, lifetime, replica ID, sequence, intent array,
parked result, and enclosing object. A raw HTTP body cap rejects oversized input
before parsing; it does not replace semantic admission.

The sealing transaction persists the exact canonical request bytes and their
hash beside the sealed lanes, bounded by the submission size, and clears them
at settlement. Retry sends those persisted bytes. Reconstructing the request
from the sealed lanes must reproduce them under one encoder version and is
retained as a debug assertion, not the retry path: byte-exact reconstruction
across an application upgrade is unproven, and a same-number,
different-hash retry would be correctly refused as a fork, stranding the
replica. One bounded transient blob per replica deletes that failure class.

### Current facts are the scalar settlement proof

One authority transaction validates the lifetime and next submission number,
folds every operation, assigns fact sequences, records the canonical request
hash and bounded parked results, and reads the result facts. A crash commits
all of those effects or none of them. The response returns the current fact for
every distinct touched address, in sealed intent order:

```ts
type SubmissionResponse = {
  authorityLifetime: string;
  facts: Fact[];
  parked: ParkedIntent[];
};

type ParkedIntent = {
  address: RecordAddress;
  code: "fact-too-large" | "patch-base-not-object";
  measuredBytes?: number;
  limitBytes?: number;
};
```

Locally constructed operations already satisfy individual admission limits.
The address-scoped authority refusals are therefore a `patch` whose fold over
a different live base exceeds the encoded fact limit, and a `patch` whose live
base is not an object. Malformed requests, submission-wide bound violations,
authentication failure, and storage failure reject or retry the operation;
they do not become parked application data.

The authority remembers the last submission's bounded parked results so an
exact retry cannot re-adjudicate them against a different state. It may return
newer current facts for the touched addresses on retry; newer authority truth
is always safe to learn.

Inside one local transaction, the replica verifies that the response lifetime
still equals its attached lifetime, applies the same per-address monotonic
installation rule, and retires the sealed submission. This matters when a
delayed submission response carries an older fact than the facts feed already
installed. Settled operations disappear. A reported parked operation moves
into the parked lane whole: the refused operation itself is retained as a
visible local overlay with its refusal code and measurements, and it does not
retry automatically. After monotonic installation, the replica inspects the
resulting stored confirmed fact, not merely the returned fact. If the stored
fact is a tombstone, it discards any parked overlay and diagnostic as
superseded. This also covers a delayed response whose older live fact was
ignored beneath a newer tombstone. Otherwise, a later local write at that
address composes with the parked operation under the one composition law,
clears the diagnostic, and creates newly pending work. No `applied`,
`superseded`, receipt, or learned-through marker is required because the fact
is the authority outcome.

Submission facts never advance `afterSequence`. Only the facts feed advances
that watermark. Receiving the same or a newer fact later through the feed is
idempotent.

### Confirmed facts and local operations have separate ownership

The replica's conceptual state is:

```txt
confirmed authority facts
+ compacted pending operations (with any parked overlay)
= visible local state
```

Every learned authority fact is stored even when its address has pending work.
A pending operation may continue to determine visible state until submission
settles, but it cannot prevent confirmed progress from advancing. A learned
tombstone immediately removes every unsealed operation at that address as
superseded. An already sealed submission remains immutable for exact retry,
but its operation stops overlaying the tombstone and retires when the response
arrives. A private materialized visible projection is permitted only as an
optimization of these invariants, never as the sole copy of authority truth
(ADR-0177 refuses the one such projection whose consumer disappeared).

### Bounds are byte-derived

V1 defines a maximum encoded fact size, facts-response size, submission size,
and number of distinct submission addresses. At least one maximum-size
admissible fact must fit a response. Submission settlement is not paged, so its
bounds must satisfy:

```txt
maxSubmissionAddresses * maxEncodedFactBytes
+ maxSubmissionAddresses * worstCaseParkedEntryBytes
+ worstCaseResponseEnvelopeBytes
<= maxSubmissionResponseBytes
```

The parked term is additive, not an alternative to the fact term. Every
touched address returns its current fact, and a refused operation also returns
one bounded parked entry for that same address.

The authority packs facts under byte and execution budgets. A private count
guard may protect one implementation, but a small fixed fact count is not wire
semantics. The exact V1 constants must be chosen by the browser, Bun, and
Cloudflare scale proof before this ADR becomes Accepted. They may widen in a
later compatible protocol revision but cannot silently shrink. Two platform
bounds are named inputs to that choice: the Cloudflare Durable Object 2 MB row
ceiling bounds the authority record row, and the worst-case combined replica
row (up to three payload lanes plus a parked operation, on the order of four
maximum encoded facts) must be bounded against mobile memory behavior, not
each lane independently.

The maximum encoded fact size is a per-fact V1 admission bound. It is
independent of ADR-0161's aggregate logical-state envelope and cannot be derived
from average bytes per address. Scale evidence reports the largest emitted
protocol fact and its conservative encoding bound separately from aggregate
present logical-state bytes.

## Consequences

- Reading current facts and adjudicating local operations have one owner and
  one vocabulary each. Push, pull, acquisition, exchange, batch receipt, and
  checkpoint are not product or wire operations.
- One durable `afterSequence` is sufficient for crash-resumable acquisition and
  steady-state learning. Successfully installed prefixes become visible
  immediately, so a large scan may expose mixed-time independently convergent
  facts.
- Exact submission retry requires one bounded authority row per replica and one
  bounded persisted request per replica, not a receipt history or retained
  change log.
- Direct settlement facts remove fold-refusal resequencing and global
  settlement watermarks.
- Permanent compact tombstones delete retention floors, deletion-history
  windows, baseline acquisition, and replica acknowledgement catalogs.
- The local store must preserve confirmed facts beneath optimistic work. A
  pending-address discard branch violates the protocol.
- Parked work is never silent: the refused operation remains visible at its
  address until a later write consumes it or a tombstone supersedes it.
- First attachment reuses the same desired-state algebra. It does not replay
  another authority's facts or sequences and does not add scalar migration
  semantics to V1.
- Because the wire carries no collection kind, the authority cannot branch on
  one, and independently installed Lenses that disagree about a collection
  cannot corrupt each other beyond their own payloads; tombstone absorption
  closes the resurrection hole that disagreement could otherwise open.

## Acceptance evidence

Before this ADR becomes Accepted, shared model and adapter tests must prove:

- prefix installation and `afterSequence` advance are one transaction;
- delayed submission facts cannot replace newer confirmed facts, and an equal
  sequence with different content is corruption;
- delayed facts and submission responses from a superseded lifetime cannot
  mutate a rebound replica;
- crash recovery repeats no committed prefix and skips no current fact;
- concurrent rewrites before, during, and after a prefix remain discoverable;
- `hasMore` is computed from the same snapshot as the returned prefix;
- a fresh replica learns live facts, tombstones, and unsets from zero without
  an acquisition mode;
- exact submission retry applies semantic operations once and detects a fork,
  and the persisted sealed request bytes equal the first sealing's canonical
  encoding;
- randomized operation composition sequences match sequential application
  under the absorption-first law;
- first-attachment `Bring` composes disjoint patches, resolves direct live
  collisions through ordinary authority ordering, lets a brought tombstone
  terminally delete a shared live record, and cannot resurrect an existing
  tombstone;
- pre-attachment operations survive attachment and a crash before lifetime
  discovery or first submission without reconstruction from visible state;
- every touched address returns one current fact, while parked results remain
  stable across exact retry;
- authority fact changes, sequences, retry metadata, parked results, and result
  reads commit in one transaction;
- a remembered parked result cannot overlay a newer tombstone;
- an older live submission fact plus remembered parked result cannot overlay a
  tombstone already installed by the facts feed;
- a learned fact is retained beneath pending work, and a tombstone immediately
  dominates optimistic work without resurrection while sealed retry
  bookkeeping remains intact;
- lifetime mismatch erases the superseded replica, while same-lifetime
  sequence-ahead state is diagnosed as corruption; and
- all admission and response bounds satisfy the byte inequality at their exact
  inclusive limits across browser, Bun, and Cloudflare adapters, using one RFC
  8785 canonical semantic encoder, with the combined-replica-row bound
  measured explicitly. Scale evidence reports these per-fact and response
  bounds separately from ADR-0161's representative aggregate proxy.

## Considered alternatives

- **One bidirectional exchange.** Rejected because it couples independent read
  and submission lifecycles and creates receipts, scan ceilings, and
  continuation state with overlapping meanings.
- **A fixed `through` ceiling and page position.** Rejected because atomically
  advancing `afterSequence` after each returned prefix already gives durable
  progress under monotonic authority sequences.
- **An opaque cursor or retained change log.** Rejected because replicas need
  one public ordering coordinate over current facts, not server-retained
  history or cursor lifecycle.
- **Kind-discriminated row and value shapes on the wire.** Rejected because
  collection kinds are Lens interpretation (ADR-0160); eight kinded shapes
  collapse to one fact and four operations, and the authority gains nothing to
  branch on.
- **Infer absence from a missing or null payload.** Rejected because empty
  objects and null are present data; absence is a stored state.
- **Separate create and update wire operations.** Rejected because both
  request presence and differ only in typed application preconditions.
- **Send complete postimages for every write.** Rejected because it would
  delete patch folding and parked remote-base overflow, but concurrent edits to
  different top-level fields would overwrite rather than compose. Complete
  coherent replacement remains available through `replace`; merge-sensitive
  nested state belongs in the record's document.
- **Return receipts, settlement sequences, or outcome flags.** Rejected because
  the current authority fact directly proves how each touched address settled.
- **Retry by reconstructing the request from sealed lanes.** Rejected as the
  retry path because byte-exact reconstruction is proven only within one
  encoder version; an upgrade mid-flight would strand the replica behind a
  correct fork refusal. The persisted bytes delete the class; reconstruction
  remains a debug assertion.
- **Expose the request hash as a digest.** Rejected because it is private fork
  detection, not a client identity or protocol noun.
- **Invent an authority-private canonical JSON algorithm.** Rejected because
  retry equality and byte admission must agree across browser, Bun, and
  Cloudflare. RFC 8785 supplies one specified representation without adding a
  wire digest.
- **Hide installed prefixes until a complete scan finishes.** Rejected because it
  recreates scratch state and atomic promotion for transaction semantics that
  Epicenter explicitly refuses.
