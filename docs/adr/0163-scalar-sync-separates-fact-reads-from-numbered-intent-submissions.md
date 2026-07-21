# 0163. Scalar sync separates fact reads from numbered intent submissions

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md), [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md), and [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
- **Amends:** the scalar protocol in [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md)
- **Relates:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), and [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)

## Context

Scalar synchronization has two independent jobs. A replica learns current
authority facts, and it submits durable local intents for authority
adjudication. Combining those jobs into one exchange introduced a frozen scan
ceiling, page continuations, batch receipts, and settlement watermarks whose
meanings overlapped. It also made transport grouping look like a semantic
commit even though scalar addresses converge independently under ADR-0164.

The protocol needs exact retry, bounded transfer, crash-resumable progress,
terminal row deletion, and authority-lifetime replacement. It does not need a
retained change log, an exact authority checkpoint, remote transaction groups,
or a distinct acquisition mode.

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

The authority stores one current fact at every scalar address. Each change to
that current fact receives one unique increasing authority sequence. Sequence
zero means that a replica has learned nothing; every assigned sequence and
submission number is a JSON-safe positive integer. A fact is one of four valid
shapes:

```ts
type RowAddress = {
  kind: "row";
  namespace: string;
  table: string;
  rowId: string;
};

type ValueAddress = {
  kind: "value";
  namespace: string;
  value: string;
};

type Fact =
  | {
      address: RowAddress;
      sequence: number;
      presence: "present";
      fields: JsonObject;
    }
  | {
      address: RowAddress;
      sequence: number;
      presence: "absent";
    }
  | {
      address: ValueAddress;
      sequence: number;
      presence: "present";
      content: JsonValue;
    }
  | {
      address: ValueAddress;
      sequence: number;
      presence: "absent";
    };
```

Address kind answers what is addressed. Presence answers whether that address
currently exists. The axes remain separate because an empty object is a valid
row and `null` is a valid value. Row absence is a terminal tombstone within one
authority lifetime. Value absence is a reversible unset.

Facts expose structured addresses directly. The wire contains no flat
qualified key, prefix parser, or redundant definition-owned key.

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

### Submissions carry desired scalar transitions

Typed table `create`, `update`, and `delete` remain useful application verbs.
They lower into a smaller synchronization algebra:

```ts
type Intent =
  | {
      address: RowAddress;
      presence: "present";
      set: JsonObject;
      unset: string[];
    }
  | {
      address: RowAddress;
      presence: "absent";
    }
  | {
      address: ValueAddress;
      presence: "present";
      content: JsonValue;
    }
  | {
      address: ValueAddress;
      presence: "absent";
    };
```

Row create and update do not exist on the wire. Both become a row-present field
patch. The authority folds it over the live fields, or over an empty object when
the address has no fact. A terminal row tombstone remains absent and therefore
settles a later row-present intent as superseded without resurrection. A
row-absent intent installs or preserves the tombstone. Value-present replaces
the value; value-absent installs or preserves the reversible unset.

Before sealing, the replica compacts pending work to at most one intent per
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

### Current facts are the scalar settlement proof

One authority transaction validates the lifetime and next submission number,
folds every intent, assigns fact sequences, records the canonical request hash
and bounded parked results, and reads the result facts. A crash commits all of
those effects or none of them. The response returns the current fact for every
distinct touched address, in sealed intent order:

```ts
type SubmissionResponse = {
  authorityLifetime: string;
  facts: Fact[];
  parked: ParkedIntent[];
};

type ParkedIntent = {
  address: RowAddress;
  code: "fact-too-large";
  measuredBytes: number;
  limitBytes: number;
};
```

Locally constructed intents already satisfy individual admission limits. The
only address-scoped authority refusal is therefore a row patch whose fold over
a different live base exceeds the encoded fact limit. Malformed requests,
submission-wide bound violations, authentication failure, and storage failure
reject or retry the operation; they do not become parked application data.

The authority remembers the last submission's bounded parked results so an
exact retry cannot re-adjudicate them against a different state. It may return
newer current facts for the touched addresses on retry; newer authority truth
is always safe to learn.

Inside one local transaction, the replica verifies that the response lifetime
still equals its attached lifetime, applies the same per-address monotonic
installation rule, and retires the sealed submission. This matters when a
delayed submission response carries an older fact than the facts feed already
installed. Settled intents disappear. A reported parked intent normally remains
a visible local overlay with an explicit diagnostic, but does not retry
automatically. After monotonic installation, the replica inspects the resulting
stored confirmed fact, not merely the returned fact. If the stored fact is a
terminal row tombstone, it discards any parked row overlay and diagnostic as
superseded. This also covers a delayed response whose older live fact was
ignored beneath a newer tombstone. Otherwise, a later local write at that
address compacts with parked work, clears the diagnostic, and creates newly
pending work. No `applied`, `superseded`, receipt, or learned-through marker is
required because the fact is the authority outcome.

Submission facts never advance `afterSequence`. Only the facts feed advances
that watermark. Receiving the same or a newer fact later through the feed is
idempotent.

### Confirmed facts and local intents have separate ownership

The replica's conceptual state is:

```txt
confirmed authority facts
+ compacted pending local intents
= visible local state
```

Every learned authority fact is stored even when its address has pending work.
A pending value intent or live-row intent may continue to determine visible
state until submission settles, but it cannot prevent confirmed progress from
advancing. A learned terminal row tombstone immediately removes every unsealed
row intent at that address as superseded. An already sealed submission remains
immutable for exact retry, but its row intent stops overlaying the tombstone and
retires when the response arrives. A private materialized visible table or
pending-address shadow is permitted only as an optimization of these
invariants, never as the sole copy of authority truth.

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
touched address returns its current fact, and a row-present intent whose fold
exceeds the fact ceiling also returns one bounded parked entry for that same
address.

The authority packs facts under byte and execution budgets. A private count
guard may protect one implementation, but a small fixed fact count is not wire
semantics. The exact V1 constants must be chosen by the browser, Bun, and
Cloudflare scale proof before this ADR becomes Accepted. They may widen in a
later compatible protocol revision but cannot silently shrink.

The maximum encoded fact size is a per-fact V1 admission bound. It is
independent of ADR-0161's aggregate logical-state envelope and cannot be derived
from average bytes per address. Scale evidence reports the largest emitted
protocol fact and its conservative encoding bound separately from aggregate
present logical-state bytes.

## Consequences

- Reading current facts and adjudicating local intents have one owner and one
  vocabulary each. Push, pull, acquisition, exchange, batch receipt, and
  checkpoint are not product or wire operations.
- One durable `afterSequence` is sufficient for crash-resumable acquisition and
  steady-state learning. Successfully installed prefixes become visible
  immediately, so a large scan may expose mixed-time independently convergent
  facts.
- Exact submission retry requires one bounded authority row per replica, not a
  receipt history or retained change log.
- Direct settlement facts remove fold-refusal resequencing and global
  settlement watermarks.
- Permanent compact row tombstones delete retention floors, deletion-history
  windows, baseline acquisition, and replica acknowledgement catalogs.
- The local store must preserve confirmed facts beneath optimistic work. A
  pending-address discard branch violates the protocol.

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
- a fresh replica learns present facts, row tombstones, and value unsets from
  zero without an acquisition mode;
- exact submission retry applies semantic intents once and detects a fork;
- every touched address returns one current fact, while parked results remain
  stable across exact retry;
- authority fact changes, sequences, retry metadata, parked results, and result
  reads commit in one transaction;
- a remembered parked result cannot overlay a newer terminal tombstone;
- an older live submission fact plus remembered parked result cannot overlay a
  tombstone already installed by the facts feed;
- a learned fact is retained beneath pending work, and a terminal row fact
  immediately dominates optimistic row work without resurrection while sealed
  retry bookkeeping remains intact;
- lifetime mismatch erases the superseded replica, while same-lifetime
  sequence-ahead state is diagnosed as corruption; and
- all admission and response bounds satisfy the byte inequality at their exact
  inclusive limits across browser, Bun, and Cloudflare adapters, using one RFC
  8785 canonical semantic encoder. Scale evidence reports these per-fact and
  response bounds separately from ADR-0161's representative aggregate proxy. A
  confirmed-facts read benchmark alone cannot satisfy this protocol proof.

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
- **Infer absence from a missing or null payload.** Rejected because empty rows
  and null values are present data.
- **Separate row-create and row-update wire operations.** Rejected because both
  request row presence and differ only in typed application preconditions.
- **Send complete row postimages.** Rejected because it would delete patch
  folding and parked remote-base overflow, but concurrent edits to different
  top-level fields would overwrite rather than compose. Complete coherent
  replacement remains available through one atomic JSON field; merge-sensitive
  nested state belongs in the row document.
- **Return receipts, settlement sequences, or outcome flags.** Rejected because
  the current authority fact directly proves how each touched address settled.
- **Expose the request hash as a digest.** Rejected because it is private fork
  detection, not a client identity or protocol noun.
- **Invent an authority-private canonical JSON algorithm.** Rejected because
  retry equality and byte admission must agree across browser, Bun, and
  Cloudflare. RFC 8785 supplies one specified representation without adding a
  wire digest.
- **Hide installed prefixes until a complete scan finishes.** Rejected because it
  recreates scratch state and atomic promotion for transaction semantics that
  Epicenter explicitly refuses.
