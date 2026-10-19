# 0628. Browser sync uses transactions and Git updates instead of cross-tab ownership

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) at the exhaustive browser inventory, allowing Git boundary metadata and a local publication revision; [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) at retention, save transactions, reconciliation, collection, fetch depth, sync ownership, and commit timing; and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) at principles 2 and 5, which summarize that browser design.
- **Relates:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) (the data Git records), [ADR-0620](0620-history-in-a-repository-only-grows.md) (conditional, fast-forward server updates), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (field and text-region merging), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the browser engine), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) (offline reads and saves), and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) (the maintained summary).
- **Unbuilt:** the replacement browser engine, its isolated fetch workspaces, ancestry recovery, safe collection, and coalesced attempts. Separate local Git transport and IndexedDB contention prototypes exercise parts of the design, not the complete engine, Cloudflare Artifacts, or an iPhone.

## Context

On 2026-10-19 the owner chose to relax internal storage restrictions while
preserving offline saves, automatic merging, and ordinary Git exchange. The
owner approved removing the planned Web Lock lease, expiration, and takeover
machinery, with one coalesced attempt per page.

ADR-0623 describes an unbuilt engine with those leases, no retained history,
and a changed-path sweep. Its recovery rule asks whether a server commit
descends from a pending commit without specifying the missing ancestry.
Its sweep does not establish whether another path still needs an object.
Revision-checked publication removes ADR-0623's synchronous-only save
requirement and validates refs and the complete edit set without a sync owner.

The owner also chose a whole active repository available offline, browser
support focused on Epicenter's Git service, automatic conflict resolution,
and recovery of committed versions through ordinary Git. Every intermediate
save need not become a recoverable version. Sync may wait for a pause in
editing; offline saves must continue.

## Decision

**Storage and sync preserve ADR-0622's merge units.** Markdown frontmatter
merges by field, taking each field's value whole; the body and other UTF-8
text merge by diff3 region. Independent fields and body regions survive.
Simultaneous insertions both stay, and an edit beats a deletion it never saw.
Competing replacements of the same unit follow ADR-0622's winner rule.
Passing complete files to the merge does not make the file the winning unit.

**The browser keeps the whole active repository for offline use.** It need
only support Epicenter's Git service. This narrows the compatibility target;
it does not add a custom sync protocol, selective offline files, or a partial
repository cache. Git records committed versions; the app needs no conflict
review UI or history of every intermediate local save.
Whole describes the current files; retained Git history follows the snapshot
boundary rule below.

**Recovery through Git covers versions incorporated into server history.**
A pending local C is retained until its fate is established, but may be
replaced after proven rejection. It is not a permanent offline checkpoint.
An intermediate save overwritten in E before incorporation may have no
recoverable version. A later sync cannot reconstruct bytes already replaced
there. Independent fields and text regions still survive through the merge.

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

**Sync may wait for a pause in editing.** Saves still acknowledge local
transaction completion while offline. A revision mismatch during sync may
end the attempt and leave work for the next trigger after edits settle.
ADR-0623's maximum 60-second wait does not apply while editing continues.
Do not add per-edit bases or ownership machinery to guarantee network
publication during uninterrupted typing.

**Commits batch pending saves at sync attempts.** Schedule an attempt about
10 seconds after the last edit, and make a best-effort attempt when the tab
hides. Visibility and connectivity triggers remain as in ADR-0623. A trigger
does not promise completion before suspension or page closure.
An attempt with no pending changes creates no checkpoint merely because a
timer fired.

Once the repository has its initial snapshot, an attempt with B = C and
pending E creates C locally before pushing; this preparation needs no network
reply. While C awaits resolution, keep that exact commit and save newer work
in E. There is no fixed commit interval during uninterrupted editing, an
offline period, or a failed push. The 10-second settling delay is not a
maximum age for an edit without a recoverable history entry.

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
- Another device may not see changes until editing pauses and a sync
  succeeds. Versions incorporated into server history remain recoverable
  through Git; an overlapping save replaced before incorporation may have no
  history entry, even if an earlier local candidate was committed.
- Replacing an uncommitted title twice in one editing burst routinely leaves
  only its final value in history. Two tabs replacing the same unincorporated
  field or body region can similarly leave the earlier edit without recovery.
  The contention prototype measured independent edits, not the frequency of
  those overlaps in actual use; no probability of accidental loss is known.
- Temporary recovery traffic can grow with server activity since B. Bounded
  retained snapshots do not promise a bounded recovery download.
- The actual engine must demonstrate transaction aborts, new edits during
  publication, delayed pushes, shared-object collection, and mobile reopening.
  Two tabs must demonstrate preserved saves and adoption after editing pauses,
  with unpacking completed before the revision snapshot. A desktop prototype
  exercised revision checks, independent fields/body regions, and ordinary
  reopening ([results](../../packages/folder/evidence/revision/RESULTS.md));
  the actual engine must reproduce them on the target phone.
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
