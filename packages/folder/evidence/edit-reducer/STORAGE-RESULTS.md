# Exact source, recovery and guarded storage

Date: 2026-10-21. Runtime: Bun 1.4.3.

The bounded representation preserved the frozen owner's observable behavior in
**6,048 exact-source scenarios**, with no differences. The tested simplification
groups each named assignment's value, editing witness and accepted revision, and
makes source reconciliation at save completion synchronous.

It was applied and verified before concurrent work began replacing the same owner
with the separately requested one-source-draft/whole-file-conflict contract. The
results here apply to the archived merging-intent implementation, not that newer
contract or an actively changing checkout. The complete
[validated snapshot](validated-snapshot.tar.gz) preserves the tested owner,
original codec and storage implementations, and tests for isolated inspection.

## Comparison and scope

This extends the [semantic command-history experiment](RESULTS.md). That earlier
oracle tested value-level compaction. This run compares the actual owner before
this refactor, including the equal-assignment acknowledgment fix, with the
production candidate. Both execute the real Markdown codec, Folder handle,
repository save loop and IndexedDB storage over independent connections.
`fake-indexeddb` supplies the IndexedDB API, as it does in the repository suite;
neither the merge nor the guarded-publication loop is replaced by a fake.

The reference owner and handle were copied before editing. The candidate was
tested separately before being applied to production, then the final production
source was copied back into the experiment for the final comparison. The
comparison checks:

- Acceptance and refusal of every command, exact displayed source, parsed raw
  fields and body availability, schema diagnostics and pending recovery values.
- State before receipt delivery, after delivery, after a second save and after
  external source repair, including whether input still reports a failure.
- Final stored bytes, not merely parsed values.
- The number of rejected stale publications and injected storage failures.

This is behavioral equivalence against the frozen implementation, not a new
independent specification for all its behaviors. An additional check requires
the exact original header bytes to survive body-only edits. The semantic run's
negative controls separately established that clearing equal-valued assignments
or replacing editing witnesses unconditionally is detectable.

## Cases

Eight source fixtures cover ordinary Markdown, comments, quote style, key order,
unknown fields, anchors and aliases, a block scalar, BOM and CRLF, closed broken
YAML, an unclosed opener, and headerless prose. Actions include named assignments
and removals, nested values, a field named `body`, a key named `__proto__`, schema
mismatches, source and form alternation, body edits, source reversions, and
presentation-only source edits to comments and quotes.

Each of nine prefixes runs with each of twelve tails and seven storage schedules:
successful save, publication failure, a competing body edit, a competing YAML
presentation edit, closed malformed YAML, an unclosed header, or binary content.

Publication races write through a second real repository connection between the
first connection's capture and publish. Its original publish then rejects the
stale tree, so the production save loop must capture, validate and merge again.
Failures throw the storage boundary's `StorageFailure` from publication. Receipt
delivery is delayed independently so later typing can race either outcome.

Observed totals from [storage-results.json](storage-results.json):

| Measurement | Result |
| --- | ---: |
| Differential scenarios | 6,048 |
| Behavioral or byte differences | 0 |
| Stale publications rejected | 3,024 |
| Injected publication failures | 624 |
| Independent exact-header checks | 504 |
| External-repair recovery attempts | 2,280 |
| Recovery attempts that cleared pending input | 2,280 |
| Final candidate bytes compared | 476,143 |

## Production result

Previously, document input manually coordinated a raw value record, a base-value
record and an assignment-revision map. It now has one sparse assignment map with
`{ value, base, revision }` per field. The public `Pending.fields` record is an
immutable snapshot derived from those entries. Acknowledgment removes submitted
occurrences and rebases surviving entries together, preserving later equal-valued
assignments without resending untouched fields. The body retains its own witness.

The frozen submission and current bounded input already encode the two save
continuations: on failure the combined input remains; on success acknowledgment
derives the remainder. No command log or new set of parallel editor lifecycles is
needed. Whole-source drafts still retain exact source and merge witnesses; their
reconciliation with a submitted structured edit now uses the already-loaded
synchronous merger and publishes one completed transition. This removes the
asynchronous reconciliation phase and its post-await identity guard.

The document/source payload distinction remains. Flattening those payloads into
only parsed fields and body would discard presentation and unrepresentable input.
The public `FileEdit` API, pending recovery shapes, storage checks, framing policy
and outside-writer merge rules are unchanged.

## Validation and limits

Before the concurrent contract rewrite, the complete Folder suite passed:
**753 tests, 3,155 assertions**. The new permanent
storage regression independently checks exact BOM, CRLF, comments, quotes and
aliases after a stale publication. The existing unknown-boundary race now also
verifies that accepted body input saves after external repair. Both prior
equal-assignment regressions remain. The affected Svelte edit and lifetime suites
passed: **21 tests, 98 assertions**. Package type checking passed for the tested
implementation. After detecting the overlap, the exact-source experiment was
also rerun with the original codec and storage in isolation and reproduced every
reported count with zero differences. The complete isolated Folder suite also
passed with the same 753 tests and 3,155 assertions, and isolated package type
checking passed. Its first isolated test attempt lacked sibling fixtures and a
local definition package; restoring those baseline dependencies resolved those
environment failures without changing the tested implementation.

The extension exercises real browser repository retries with an in-memory
IndexedDB implementation. It does not inject native filesystem races, crash or
lost-reply failures, or enumerate arbitrary YAML and command schedules. The full
Folder suite retains its existing native-engine coverage. Passing this finite
corpus supports the applied refactor; it is not proof of every possible collapse
of document and source intent, nor an implementation of all remaining ADR-0666
work.

## Reproduce

[storage-source.tar.gz](storage-source.tar.gz) contains the frozen reference,
the tested candidate, their handle wiring and the comparison runner. The loose
prototype modules were removed after the experiment. From `packages/folder`, in
a checkout with the same codec and repository implementations:

```sh
tar -xzf evidence/edit-reducer/storage-source.tar.gz -C src
bun src/edit-reducer-storage.prototype.ts
rm src/edit-owner.reference.prototype.ts src/handle.reference.prototype.ts
rm src/edit-owner.bounded.prototype.ts src/handle.bounded.prototype.ts
rm src/edit-reducer-storage.prototype.ts
```
