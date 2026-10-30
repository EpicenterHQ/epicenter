# 0685. Hosted Git records browser publication receipts in a protected ref

- **Status:** Rejected
- **Date:** 2026-10-23
- **Rejected:** 2026-10-30, in favor of the file contract's decisions 11 and 12 (2026-10-30): the web never syncs; a browser keeps its own files (OPFS through `openDevice`) and uploads new ones through the server, which commits them. No browser submission protocol exists to need an operations ref; the server's write translator keys a capture's receipt by its capture id instead. Never built.
- **Relates:** [ADR-0620](0620-history-in-a-repository-only-grows.md) (main never rewinds), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (merge units and losing candidates).
- **Unbuilt:** protected native receive-pack gateway, initial operations ref, browser submission publisher, versioned request hashing, paired backup and restore, and real-client Artifacts tests.

## Context

Artifacts accepts a force update or deletion of main when the current Worker forwards native receive-pack unchanged. The browser cannot infer whether an uncertain upload landed from object existence: an object may have been staged but never promoted. Scanning all parents of main for a years-old candidate is unbounded after native merges, and a membership check alone does not return the original merge commit.

The service must make a retry of one frozen browser request return its exact first publication, even after later pushes. A submitted proposal that loses a field or body region must also remain reachable in main.

## Decision

**Every hosted repository with main has a protected operations ref that is updated atomically with main for each browser publication.** The ref refs/epicenter/ops maps a stable operation ID to either a publication { versioned canonical submission hash, candidate P, publication M } or an abandonment { versioned canonical submission hash, abandoned }. The hash covers the authorized principal, repository identity, operation ID, and path-sorted before/after values and modes; it excludes the pull cursor, current Git head, and transport framing. A retry with the same ID and hash returns the original publication or refuses an abandoned request; different content with that ID is refused. The server retains a version's verification encoder while sealed requests of that version may retry. A repository with main but no operations ref fails closed. The first creation of main creates the initial operations ref in the same atomic update unless an abandonment already created it while main was empty.

**A browser submission creates a candidate parent and a resolved merge commit on main.** For existing main H, P records the exact submitted after values. M has parents [H, P] and resolves each path from its observed before value, H's value, and P's proposal under ADR-0622. If an overlap chooses H's value, P still contains the proposal. A server-written operations commit L' records the receipt. One atomic compare-and-swap advances H to M and L to L'. On an empty repository, the first browser submission creates root P directly as main and records P as both candidate and publication in the initial operations ref. After stale or uncertain transport, the server rereads both refs and checks the operation before retrying the same frozen request. Postgres and unpromoted Git objects are not receipt authorities.

**The native Git gateway permits only fast-forward updates to main and no client writes to the operations ref.** It refuses deletion, force updates, and other refs; it hides transient staging refs from both Git protocol versions. It may stage a client pack, verify all-parent ancestry, and promote main by old-OID compare-and-swap. The Worker is the sole holder of the Artifacts write token.

**Abandoning a blocked submission is a server-fenced operation, never a local negative lookup.** The service advances the operations ref to record abandonment by old-OID compare-and-swap, even if main is unchanged. A racing publication that read the old operations head then fails its atomic update. If publication won first, abandonment returns its original receipt. The browser may drop the sealed request and rebase dependent local values only after the abandonment record is durable; a later attempt with that operation ID is refused.

## Consequences

- An old lost-response retry finds its original publication with a bounded receipt read, independent of the size and shape of later native Git history.
- A blocked operation can be abandoned without racing a slow in-flight publication; the browser needs a server response before it can release the frozen upload for repair.
- The losing candidate is reachable as M's second parent. Recovery must show the candidate and publication IDs because ordinary path-limited Git log can hide the losing parent through path simplification.
- Ordinary Git clients can clone and fetch main. They can read the operations ref but cannot change it.
- Backup and restore must capture main, refs/epicenter/ops, and their objects as a consistent pair. A main-only clone is an export, not a restorable sync-server backup.
- A complete native gateway must ship before browser publication trusts this ledger. Disposable Artifacts probes establish atomic two-ref updates and Worker-written objects, but not full real-client gateway behavior.
- A future connector to another Git host may use a different durable receipt authority. The browser API does not expose this ref; equivalent guarantees require that host to prevent rewinds and let the connector settle uncertain pushes.

## Considered alternatives

- **Search main on every retry.** A candidate behind arbitrary native merges requires an unbounded all-parent walk, and object existence alone can mistake an unpromoted staged object for publication.
- **Derive a Postgres index from main.** A complete ancestor-closed index could answer membership, but exact M recovery also needs parent or operation mapping. Large native pushes and a database restore block browser publication until backfill reaches current main. The current Worker has no background queue and no measured bulk Artifacts ancestry read; atomic two-ref updates have passed a live disposable probe.
- **Use the database as the receipt authority.** A Git update can succeed before the database write, producing a published edit whose retry looks absent.
