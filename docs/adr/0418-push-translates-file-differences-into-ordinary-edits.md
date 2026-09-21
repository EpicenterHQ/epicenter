# 0418. Push translates file differences into ordinary edits

- **Status:** Proposed
- **Date:** 2026-09-21
- **Amends:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at three-way comparison against the current store and remote-conflict previews. The readable working copy and field-level writes remain.
- **Relates:** [ADR-0417](0417-a-data-address-holds-one-document.md) removes generation identity independently. [ADR-0341](0341-the-folder-moves-only-when-a-person-says-so-in-both-directions.md) defines baseline advancement; [ADR-0343](0343-a-preview-is-an-output-and-the-side-that-showed-it-applies-it.md) separates change inspection from application.
- **Unbuilt:** Permitted-field Push planning, complete preflight including body-edit refusal, durable baseline advancement and retry recovery, and running-owner CLI wiring. Current checkout is not this narrowed contract.

## Context

The desired workflow materializes a document as Markdown and root `kv.json`,
lets a person or agent edit those files, and submits their changes through the
same store used by the app. Export/import alone cannot express edits to existing
rows. Comparing the files with the live store adds a second conflict workflow
on top of ordinary synchronization.

## Decision

**Push compares files with the baseline from the last Pull or successful Push.
It translates those differences into ordinary CRDT edits.**

The comparison is field by field within each row, not whole-row replacement.
An unchanged field produces no write. A changed permitted field produces a
field update. Settings use the same per-key comparison. Writable fields follow
the application mutation contract; serialization alone does not permit editing
row identity, ownership, blob references, internal paths, or computed values.

Bodies remain readable, but any body difference from the materialized baseline
refuses the complete submission before writes. Push does not silently skip the
body, decode it into a collaborative node, or offer a content-edit mode.
Creation and deletion remain a separate scope decision; until specified, added
or removed row files and edits targeting deleted rows refuse without resurrection.

The baseline records the values and content fingerprints corresponding to the
files handed over or successfully submitted. It is neither the latest remote
state nor a saved Yjs fork. The replica continues to hold its ordinary durable
updates, cursor, and outbox independently of that file baseline.

Push does not compare current store values to decide which file changes to
submit. Reading the store to locate a row or recover a retry remains legitimate. Such reads do not introduce a remote-conflict plan.
No unchanged file field may overwrite a change made elsewhere.

**One synchronization system resolves concurrent edits.**

Push writes onto the current replica. A scalar assignment follows edits that
replica has already observed. Concurrent assignments it has not observed resolve
through Yjs ordering; server arrival time and wall clocks do not define a new
winner policy. Push does not promise that its value remains the eventual value.
The working-copy baseline is not a conditional-write precondition. An explicit
field edit can supersede an observed edit to that same field. Conditional
mutations are not promised by this workflow.

For example, changing a title in Markdown does not submit its untouched status.
A phone's status edit survives. If both devices change the title, ordinary CRDT
resolution applies. There is no separate Markdown conflict resolver.

**A successful Push advances only the submitted baseline.**

The edits must be durable locally before the baseline claims success. Remote
acknowledgement may follow later through the outbox. Changes received remotely
must not enter the baseline unless the corresponding files are materialized.
A second Push with unchanged files must submit no new edits.

The implementation must recover interrupted field edits and baseline writes
without repeating their intent. A public request ID is unnecessary, but internal
durable submission recovery remains required. A flush followed by a
manifest write is an ordering requirement, not an atomic transaction across
storage and files. Yjs transactions do not roll back on exceptions. Prove crash
recovery before claiming exactly-once application; do not add a distributed
reset or replacement protocol to solve this local problem.

## Scope and implementation boundaries

**Push is the sole supported agent write path.** Agents read files or optional
SQL results and use any tool, including TypeScript scripts, to edit working-copy
fields. They do not open authoritative persistence, own Yjs replicas, or use a
second direct-mutation API. This is an integration contract, not an OS sandbox.

Pull, live-store queries, and Push require an identified running store owner with
access to the explicit destination. If unavailable, refuse rather than start a
second persistence owner. Editing existing files can happen offline. Dirty Pull
refuses rather than silently replace prepared edits. Successful Push means local
durability and recoverable baseline advancement, not remote acknowledgement.

Keep destination and owner checks, complete materialization, readable-file
validation, and exclusion between working-copy operations. File changes during
an operation must not be silently overwritten or marked submitted. Removing a
confirmation loop does not make filesystem races disappear.

CLI and desktop use the same file-to-edit semantics. The running application
owns the replica and validates the complete submission before applying changes.
Routing and owner admission must prevent duplicate persistence owners. Existing
access checks apply; a working-copy path or SQL result is not authorization.
Preflight is not rollback: store persistence and baseline advancement need
crash recovery. No cross-store atomic batch or agent self-confirmation policy
is introduced.

The current engine is in `packages/app/src/data/artifact/checkout.ts`; its
filesystem host is in `apps/epicenter/src/checkout.ts`. No application surface
currently invokes Pull or Push. Connecting that transport to the running owner
remains implementation work. Native SQLite persistence and headless replica
opening are not prerequisites.

## Matter file contract

Pull emits one generated `matter.json` inside each table folder. The root
contains `kv.json` and Epicenter destination/baseline metadata, not a duplicate
table-schema registry. Matter supplies the shared typed-file interpretation;
Epicenter owns Push validation and recovery. Standalone Matter files remain
authoritative, while checkout edits remain pending until Push.

Generated contracts do not grant write access. Their modification refuses Push
rather than migrating the store. Schema mapping, including nullable values and
root KV, must be implemented faithfully before compatibility is claimed. The
full boundary is recorded in [the Matter working-copy decision](0420-epicenter-working-copies-use-the-matter-file-contract.md).

## Read-only SQL beside a working copy

The authoring format is Markdown frontmatter plus root `kv.json`. SQLite is
read-only for agents and users of the query interface; it is not another
editable working-copy format. Push never imports a SQLite database or replays
SQL statements. Editing query output does not edit the store.

An optional query index can expose table names, stable row IDs, typed field
values, and the corresponding relative Markdown path. SQL selects files;
agents edit those files and submit through the same Push path. For example,
filtering recordings by duration and date or joining a folder with its records
is a relational query. Exact text search can remain a filesystem search.

Every query surface names its source and freshness. A live projection follows
the running store. An index of a working folder reflects its parsed files,
including unpushed field edits, through its last completed build or refresh.
An index produced by Pull alone is a snapshot of that Pull until refreshed.
These indexes must not be presented as interchangeable current views.

A working-copy index is optional, disposable, and excluded from Push. Rebuilding
it does not modify Markdown, KV, or the Push baseline. Missing or invalid files
must be reported rather than silently disappearing from the indexed view.
Returned paths identify candidates, not permission to write them or a promise
that the selection still matches at Push time. Do not add file watching or
mandatory indexing merely to provide the initial file workflow.

## Consequences

Remove current-store values and `storeChanged` from file-change planning,
remote-conflict previews, and the requirement to recompute a live-store preview
across approval. Preserve file-baseline comparisons and normal store delivery.
Do not keep a selectable three-way mode or introduce a second merge engine.

Body decoding and rewriting disappear from Push. Agent-owned persistence,
multi-process store writes, sender election for scripts, and a parallel
`apply(...)` API are unnecessary for this workflow. Batch editing means one
validated submission of file differences within a store.

Generation removal can ship independently. Neither ordinary Push nor its local
baseline starts a new document lineage or invalidates another device.

## Considered alternatives

- Export and import new rows only: loses editing existing records through files.
- Compare files against the latest remote state: unchanged stale fields become
  apparent edits and overwrite work the file author never touched.
- Keep a Yjs fork from Pull: makes file edits concurrent with everything since
  Pull and adds causal-state ownership. It does not remove the need to track
  which bytes were actually materialized across crashes.
- Whole-row replacement or server-arrival last-write-wins: changes the app's
  merge semantics and discards the field-level behavior we want to preserve.
