# 0134. Application data generations own immutable workspace namespaces

- **Status:** Superseded
- **Date:** 2026-07-13
- **Superseded by:** [ADR-0136](0136-applications-declare-immutable-data-versions.md)
- **Supersedes:** [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)
- **Amends:** [ADR-0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md), [ADR-0121](0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md), [ADR-0124](0124-workspace-kv-keeps-one-logical-identity-outside-the-record-database.md), [ADR-0126](0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md), [ADR-0133](0133-ordinary-record-sync-requests-carry-only-the-records-epoch.md)
- **Relates:** [ADR-0131](0131-every-durable-records-materialization-carries-its-canonical-descriptor.md), [ADR-0132](0132-an-obsolete-replica-exports-one-read-only-recovery-checkpoint.md)

## Context

ADR-0130 made a records epoch identify both one history incarnation and one
records schema. That removed online succession machinery, but it still let an
application replace one workspace with a different schema. The records hash
also cannot describe the complete durable application contract because KV,
child-document formats, and application-owned blobs have separate identities.

Epicenter applications currently use one fixed workspace identity per app.
Turning schema evolution into arbitrary runtime workspace creation would add a
catalog and another identity layer without a product that needs either.

## Decision

An application data generation is one immutable durable application contract.
It spans the records descriptor, synchronized KV declaration, child-document
formats and addressing, and every application-owned blob or artifact layout.
Any change to one of those contracts publishes a new data generation, including
an additive change that another system might classify as compatible. UI-only
and executable-behavior changes may publish another build for the same data
generation.

The application developer authors one stable `appId` and a positive,
increasing `dataGeneration`. The framework derives the workspace ID as
`<appId>-g<number>`, writes it into the generation lock, and exposes the
validated lock entry as runtime identity. Applications do not author, override,
or parse that generated value. There is one workspace namespace per application
data generation. Epicenter does not add arbitrary runtime workspace IDs or a
user-facing workspace catalog.

A committed append-only generation lock records each published generation's
generated workspace ID, records schema hash, and explicit identity tokens for
the other durable planes. Published lock entries never change or disappear. CI
refuses drift inside an existing entry, including a later change to the ID
derivation rule. The lock records identities only; it defines no compatibility
relation, migration edge, predecessor graph, or wire negotiation.

Every durable plane must be qualified by that derived workspace namespace or by
another generation-qualified identity recorded in the same entry. Sharing a
mutable blob store across generations does not satisfy this boundary. An
application that later copies blobs duplicates them into the target generation
unless a separately justified immutable content store already exists.

A records epoch remains an authority-minted identity for one continuous records
history inside one application data generation. Same-descriptor restore or
authority repair may mint a new epoch to fence stale cursors and writes. A
records schema change never rebinds an existing workspace ID or starts another
epoch inside it.

## Consequences

- The latest application build never interprets historical durable shapes.
- Schema evolution no longer needs administrative records replacement,
  application transformation chains, schema compatibility rules, or successor
  lineage.
- Every durable contract change pays the full cost of a new namespace, even
  when the change looks additive or harmless.
- Generation changes should be rare, batched, and deliberate. During rapid
  pre-release development, an app may discard development-only generations
  before publication rather than weakening the production invariant.
- `appId` plus `dataGeneration` is the only app-authored workspace identity;
  callers cannot make the three values disagree.
- The records epoch, descriptor persistence, ordinary sync fence, and frozen
  recovery checkpoint remain useful within their narrower generation scope.
- A future need for several independent user-created workspaces is a separate
  product decision. It does not enter schema evolution preemptively.

## Considered alternatives

- **Change schemas by replacing the records epoch in one workspace.** Rejected:
  it preserves semantic transformation and stale-device recovery as a permanent
  application lifecycle while covering only the records plane.
- **Author a workspace ID independently.** Rejected: a third app-authored value
  can disagree with the application and generation it is meant to identify.
- **Use the records schema hash as the application generation.** Rejected: the
  hash deliberately excludes KV, child documents, blobs, and executable
  meaning.
- **Canonicalize the entire application into one universal descriptor.**
  Rejected: application-owned storage and semantics cannot be inferred
  completely, and such a descriptor would grow into a compatibility language.
- **Allow additive changes inside a generation.** Rejected: classifying which
  changes old readers and writers may safely ignore recreates the compatibility
  system this decision removes.
