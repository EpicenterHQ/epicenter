# 0628. Browser sync uses transactions and Git updates instead of cross-tab ownership

- **Status:** Proposed
- **Date:** 2026-10-19
- **Relates:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) (the data Git records), [ADR-0620](0620-history-in-a-repository-only-grows.md) (conditional, fast-forward server updates), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (field and text-region merging), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the browser engine this would amend), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) (offline reads and saves), and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) (the summary this would amend).
- **Unbuilt:** the replacement browser engine, its revision-checked publications, isolated fetch workspaces, ancestry recovery, safe collection, and coalesced attempts. Local transport probes exercised isomorphic-git against native Git, not this IndexedDB engine, Cloudflare Artifacts, or an iPhone.

## Context

On 2026-10-19 the owner chose to relax internal storage restrictions while
preserving offline saves, automatic merging, and ordinary Git exchange. The
owner approved removing the planned Web Lock lease, expiration, and takeover
machinery, with one coalesced attempt per page.

ADR-0623 describes an unbuilt engine with those leases, no retained history,
and a changed-path sweep. Its recovery rule asks whether a server commit
descends from a pending commit without specifying the missing ancestry.
Its sweep does not establish whether another path still needs an object.
This proposed amendment specifies the safety conditions behind the approved
coordination change. It removes ADR-0623's synchronous-only save requirement
and uses one repository revision to validate refs and the complete edit set.

## Decision

**Storage and sync preserve ADR-0622's merge units.** Markdown frontmatter
merges by field, taking each field's value whole; the body and other UTF-8
text merge by diff3 region. Independent fields and body regions survive.
Simultaneous insertions both stay, and an edit beats a deletion it never saw.
Competing replacements of the same unit follow ADR-0622's winner rule.
Passing complete files to the merge does not make the file the winning unit.

**No browser page owns synchronization across tabs.** Each page runs at most
one attempt per open repository at a time and coalesces requests made while
it runs. Separate pages may overlap. Delete the planned sync Web Lock,
lease, expiration, and takeover protocol. Duplicate network requests are an
accepted cost.

**The clone retains saved work and enough Git information to settle sync.**

```txt
B   origin/main: the last incorporated server commit
C   main: B, or one exact pending commit whose parent is B
E   newer unsent text or deletions, relative to C
revision   one monotonically increasing value for local publication checks
```

Retain B and C and the complete trees and blobs needed for their file
snapshots. Ordinary Git reachability includes commit parents; snapshot
retention deliberately stops parent traversal at an explicit shallow
boundary. Fetches may temporarily retain connecting ancestry and objects.
The browser needs no history interface, but synchronization may need history.
Git boundary metadata and small operational bookkeeping are allowed; neither
introduces another authority or an edit history outside Git.

**Saves, commits, and adoptions validate the revision they read.** Every change
to B, C, E, or the snapshot's shallow-boundary metadata increments the revision
in the same transaction. A readonly transaction captures the revision and the
bytes needed for a save, commit, or adoption. Compute merges and hashes
outside the write transaction; the merge may be asynchronous. Publication
compares the captured revision, then writes the result and increments the
revision atomically. A mismatch leaves refs and saved edits unchanged and
requires recomputation. This catches new and removed paths without comparing
the entire edit set or keeping a transaction open through computation.

Commit and adoption publish required objects, refs, and incorporated-edit
cleanup together. A save acknowledges success after its publication
transaction completes, including while offline. Push only the exact commit
a transaction published. Snapshot reads materialize their required bytes
before collection can remove objects they need.

A push acknowledgement validates the captured B/C pair, changes only the
confirmed ref, preserves newer E, and increments the revision. It does not
require the revision captured before the request: newer saves do not
invalidate evidence that exact C landed. After C lands, merge E onto incoming
server data with C as the base. A stale acknowledgement or fetch result
cannot rewind refs or mark a different, unpushed commit accepted.

**An uncertain push preserves exact C until its fate is established.**

- If the server still holds B, retain C unchanged: a delayed request can
  still land. Retry C rather than reconstructing its bytes as a new commit.
- Equality with C, or ancestry proving C is included, establishes acceptance.
- An advanced server commit proven not to include C permits rebasing and
  replacing C: the old B-to-C update can no longer fast-forward the server.
- Missing ancestry is unknown, never proof of rejection. Fetch the connecting
  history through ordinary Git negotiation, traversing all parents. If proof
  remains unavailable, keep C and E for another attempt.

Use depth 1 only for the initial snapshot fetch. Later fetches negotiate
from B without another depth limit. A completed request does not substitute
for the required ancestry evidence. An ancestry helper's negative answer
at a shallow boundary remains unknown.

Prepare fetched objects and ancestry evidence before capturing the revision
and E for adoption. Network waits and unpacking do not belong inside the
revision validation window. Reassess prepared data against the refs captured
for publication.

**Collection deletes only objects absent from the retained snapshot roots.**
Mark the complete snapshot closures; changed paths identify candidates, not
liveness. Shared blobs and trees survive while either snapshot needs them.
Protect the liveness decision and deletion against concurrent publication
with a transaction. Fetch and candidate work stays isolated until publication.
Collection need not run after every attempt; its failure costs space rather
than saved content. Pending objects are unsynchronized data, not a cache that
the server can necessarily restore.

**A failed attempt ends rather than starting an immediate retry loop.** Use
ADR-0623's existing scheduled and connectivity/visibility triggers for later
attempts, coalesced per page. No separate durable retry queue, exponential
failure counter, or jitter system is required. Respect a server's
`Retry-After` deadline. Timing is a resource policy, not part of merge or
publication correctness.

## Consequences

- A suspended page needs no ownership transfer. Its resumed operations face
  the same local publication checks and conditional server updates as any
  other attempt.
- Several tabs may duplicate transfer and packing work. Add coordination
  only if measurements justify that cost.
- A save to an unrelated path can invalidate another computation. Measure
  capture-to-publication latency and progress under continuous saves before
  adding per-edit bases and revisions to avoid those retries.
- A device may remain pending until another scheduled attempt succeeds.
  Closing a page needs no network completion; acknowledged saves are local.
- Temporary recovery traffic can grow with server activity since B. Bounded
  retained snapshots do not promise a bounded recovery download.
- The actual engine must demonstrate transaction aborts, new edits during
  publication, delayed pushes, shared-object collection, and mobile reopening.
  Two tabs must also demonstrate adoption progress while one saves every
  second, with unpacking completed before the revision snapshot; repeat with
  large overlapping text edits and unrelated paths.
  Artifacts must demonstrate the conditional Git updates and recovery fetches
  required here. Existing storage benchmarks do not prove these transitions.

## Considered alternatives

- **One Git commit per save, with no E.** Every potentially sent commit and
  its merge-base snapshot must survive uncertain replies. Inflated table
  trees then grow with offline saves; bounding them safely restores pending
  identity and cleanup bookkeeping. Native Git's delta-packed history size
  does not establish the cost of the browser's pack writer.
- **Lazy edits with their own base blobs and revisions.** Adoption could
  move refs without rewriting E, but reads would merge on demand and
  collection would retain every edit's base. Included edits still need
  revision checks, and namespace collisions need reconciliation. Keep this
  alternative for measured contention in the simpler revision scheme.
- **Shared fetch objects protected only by creation time.** An unfinished
  candidate can need objects created before collection began, or reuse old
  oids. Creation time does not establish their liveness; isolated work avoids
  introducing candidate pins or another recovery lifecycle.
- **Server-side commits.** A custom endpoint removes browser Git transport
  but retains an exact pending request and atomic local adoption. It changes
  the plain Git service and browser exchange contract; ADR-0623 already names
  the measurements that would justify reconsidering it.
- **A sync owner with an expiring lease.** Expiration cannot cancel a request
  already in flight; the same publication and pending-commit rules remain
  necessary.
- **No temporary history.** A shallow snapshot can hide an accepted commit
  and cause its old edit to be replayed over a newer one.
- **A durable retry subsystem.** Pending C and E already survive failed
  attempts; a separate queue adds another lifecycle without protecting more
  saved information.
