# Browser folder sync clean break

**Date**: 2026-10-22
**Status**: In Progress
**Owner**: Epicenter

## One Sentence

A browser folder keeps a complete last-pulled snapshot and the latest local value per changed path; an explicit sync attachment sends frozen changes to Epicenter, which merges and publishes them in Git.

The proposed durable rules are [ADR-0684](../docs/adr/0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md) for the browser boundary and [ADR-0685](../docs/adr/0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md) for hosted retry receipts.

## Current state and target

The public Folder opens and saves without an account. Browser storage currently retains a Git object pool and workingTree, remoteBase, and pendingCommit roots. Browser sync constructs commits and exchanges Git history; the hosted Worker forwards authorized receive-pack to Artifacts. A disposable Artifacts probe showed that this forwarding accepts deletion and force updates to main. The public browser sync lifetime is not wired into Vocab.

The clean break removes browser Git objects, Git transfer, ancestry recovery, and the unbounded per-path edit queue proposed in the earlier storage experiment. There is no migration: the new opener does not read the old database, and this work does not delete it. Desktop folders retain local Git and compatible remotes. A browser saves while offline and attempts upload when the app next opens; it need not upload while closed. A local save acknowledges IndexedDB only. A separate status reports Git publication.

Completion means a saved browser edit survives close/reopen, eventually lands in Epicenter's main, and has an exact publication commit. Independent fields and body regions merge under [ADR-0622](../docs/adr/0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md). Overlaps choose a deterministic winner without a conflict UI; a submitted losing proposal remains a parent of the merge commit. An unsealed local value overwritten before upload need not remain individually recoverable.

## Public API and ownership

Keep the account-free `openFolder({ tables })` and its current Folder read and write API local. Browser-only sync is a separate attachment:

    const opened = await openFolder({ tables });
    if (opened.error !== null) return opened;

    // The app obtains repository selection and first-combine consent.
    const attached = await attachFolderSync(opened.data, {
      account,
      repositoryId: selectedRepository.id,
      firstConnection: 'combine',
    });
    if (attached.error !== null) return attached;

    const sync = attached.data;
    const stop = sync.onStatusChange(renderSyncStatus);
    await sync.syncNow();
    stop();
    sync.close(); // the local Folder remains open

attachFolderSync is a proposed browser entry, not a current export. It returns Promise<Result<FolderSync, AttachError>> and refuses a closed or non-browser Folder. FolderSync exposes getStatus(), onStatusChange(fn), syncNow(): Promise<Result<void, SyncError>>, abandonBlocked(): Promise<Result<void, SyncError>>, and close(). Successful syncNow means one bounded exchange and atomic installation of its response, including the exact receipt if it submitted an operation; it does not mean no edits remain. abandonBlocked is an explicit online repair action for a permanently refused sealed operation; it preserves that operation's latest file content as unsealed unless a newer local value already exists, and it requires a service-authoritative fence or original receipt. Its status names pending and masked paths, connection failure or blocked work, last fully pulled head, and the last exact publication receipt { operationId, candidate, publication }. It does not report local save success. The attachment starts an attempt when attached after open/reopen and schedules later attempts after saved changes and browser connectivity/visibility signals without an immediate failure loop. Closing Folder also closes its attachment. The app closes the attachment on account change; the captured Account itself permanently refuses network access after retirement. Reattachment with a new Account is explicit.

The binding persisted with the local folder is { authorityId, principalId, repositoryId }, not a display name or URL. A different account or repository is refused before any network mutation. Reattaching the same binding resumes without new consent. The firstConnection option is consumed only when creating the binding after an informed choice to combine nonempty local and remote folders; it cannot silently authorize a later change of destination. [ADR-0633](../docs/adr/0633-apps-open-local-data-before-connecting-services.md) already requires that explicit connection and choice. Sign-in alone does nothing. A signed-out folder is a normal local folder. Opening it never creates a repository.

Reuse the app's existing API-audience Account.fetch, with folders:read and folders:write added to its scope request and the API audience's advertised scopes. Vocab currently has one API-bound account for inference. Creating a second browser OAuth client with the same client ID would compete for its stored token and PKCE state. Native Git continues to use the Git audience. The service authorizes the immutable repository ID and current principal on every request.

The browser protocol has two logical operations, exchange and publish. One POST /api/repositories/:id/sync may carry a pull cursor and an optional frozen submission, and return an exact receipt plus the current main delta. The HTTP framing may page a large delta, but its head is pinned to one Git commit and the browser installs it only when every page is present. The public FolderSync API does not expose Artifacts, Git ref names, commit construction, or the server's receipt implementation.

    type SyncRequest = {
      knownHead: string | null;
      submission?: {
        operationId: string;
        hashVersion: 1;
        changes: Array<{
          path: string;
          before: { content: bytes | null; mode: GitMode | null };
          after: { content: bytes | null; mode: GitMode | null };
        }>;
      };
    };

    type SyncResponse = {
      head: string | null; // null means main does not exist yet
      delta: CompleteTreeDelta; // knownHead to head, one pinned version
      receipt?: {
        operationId: string;
        candidate: string;
        publication: string;
      };
    };

The bytes and CompleteTreeDelta types describe the logical protocol, not a commitment to base64 JSON. The transport must bound memory and support the folder's supported file sizes. Content-addressed blob references can replace repeated before bytes after a focused Artifacts read test; that is an optimization, not a second browser object store. A release cannot claim eventual upload for a file size its transport permanently refuses. Define limits or resumable transfer before promising arbitrary binary files.

## Browser records and transitions

Use one new IndexedDB database per origin, keyed by an explicit local folder identity. The logical records are:

| Record | Key | Value |
| --- | --- | --- |
| snapshot | folder ID, path | Entry at the fully installed head: mode, blob identity, bytes for readable files; structural identity for Gitlinks. |
| local | folder ID, path | Latest unsealed value or deletion, the visible value before its first unsealed write, a possible dependency on the sealed operation, a generation for guarded writes, and tracked-at-intent or local-only state. |
| sealed | folder ID, operation ID, path | Exact immutable before and after values, frozen request version, and authorized identity. At most one bounded operation per folder is sealed. |
| meta | folder ID | Binding, fully installed head, sealed operation ID, and reconciliation state. |

These are logical ownership boundaries. Physical object-store count is an IndexedDB implementation choice; a keyed transaction must cover the records whose transition is atomic. IndexedDB is the first backend because its transactions cover cross-tab writes and reconciliation. OPFS or SQLite adds a second crash and coordination problem without a demonstrated size or throughput need. Measure real folders before changing that backend.

The visible file tree is local over sealed over snapshot, with one shared projection for file reads, lists, table views, ignore rules, and structural checks. A Folder write changes that path's unsealed value at its queue turn; the later write wins per named field, body, or whole file. A net-zero unsealed change can disappear. If a sealed A to B is in flight and the user changes B back to A, keep frozen B and a new unsealed reversal. A lost response cannot mutate B.

Local saves follow [ADR-0689](../docs/adr/0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) and [ADR-0690](../docs/adr/0690-merges-happen-only-where-history-records-the-common-ancestor.md). One Folder queue orders writes; the later write wins per named field, body, or whole file. An editor-owned `edit(source, save)` keeps typed text until its write lands or fails. No local document merge or observed-source lineage is part of this proposal. A local record's `before` is the visible underlay at its first unsealed write, for later remote reconciliation, not a base for merging local saves. The browser storage transition must preserve the Folder's checked update, replace, write, create, and move behavior.

The comment-only YAML header case currently drops a competing change without an `Overrode` diagnostic and must be fixed before the remote rebase predicate below can be trusted. Changing the existing Git merge's JSON outcome would separately amend ADR-0622.

An already tracked edit remains eligible after a remote deletion or a new ignore rule. An ignored, untracked local file stays local; changing .gitignore can make its latest value eligible. If any positive local file obstructs an incoming Git path through a file/directory or case-twin collision, install the exact remote snapshot, show the local file, hide the obstructed remote entry in the derived view, and report both paths as shadowed in sync status. Other paths may continue syncing. A deletion hides only its exact path, not a newly arrived remote directory beneath it. The projection must never present an impossible file tree. Preserve executable modes, symlink-to-regular-file replacement, and unreadable Gitlink occupancy.

Sealing moves eligible latest records into one immutable bounded operation in a transaction; later writes create new local records. Paths under `.device/` are never eligible for submission. A local `before` depending on an unsettled sealed value cannot enter another submission until that operation settles. One active page may attempt one exchange; another tab can safely resend the same sealed operation. The service deduplicates it. Validate paths and transport limits before sealing where possible, so one bad path does not hold unrelated work. A permanently refused operation remains sealed until an explicit abandon request atomically records S -> abandoned in the protected operations ref, or returns its original publication receipt. A negative lookup or lost authorization does not release S: an old in-flight request might still land. A signed-out folder remains locally writable, and its sealed upload resumes or receives a durable fence on authorized reattachment.

Reconciliation stages a complete delta for one pinned head. For each eligible unsealed path, compute `merge(path, { base: local.before, current: incomingRemote, change: local.after })` outside the IndexedDB transaction. Rebase the **whole path** only when the merge reports no competing unit, its result is valid for the format, and there is no binary or structural collision; set `before` to the incoming remote value and `after` to the merged value. If any unit competes, keep that local record and its old base so the server's P/M merge can record `Overrode`. A file with both independent and competing units may temporarily mask the independent remote unit until publication. Paths dependent on unsettled S and local structural shadows stay masked with explicit status. Never partially rebase a file while retaining its old base: a later remote edit could then be mistaken for local intent.

In one guarded transaction, install the entire pinned snapshot, settle only the matching sealed receipt, resolve pending bases, install eligible rebased local records, and advance the head. If the head, sealed ID, or relevant local generation changed since computation, recompute before installing; do not report a completed pull while an old head or partial delta remains. A returned receipt may name an old publication while current main is newer. A stale response cannot move the head backward. No published-revision markers or historical source lineage are retained; a mounted edit continues to show its typed text until the Folder reports what landed.

## Git publisher and retry authority

The Artifacts publisher reads main head H and protected refs/epicenter/ops head L from one unfiltered advertisement. If H exists without L, fail closed. The operations ref contains a fan-out map from operation ID to either { versioned request hash, candidate P, publication M } or { versioned request hash, abandoned }. The version 1 hash covers the server-authorized authority, principal, repository ID, operation ID, and a stable path-sorted encoding of each before/after value and mode. Duplicate paths are invalid. It excludes the pull cursor, current Git head, transport framing, and page boundaries, which can change on a retry. The ledger stores the version, and the server retains its verification encoder while version 1 sealed requests may reopen. Reuse of an ID with different content fails.

For a new submission to an existing main H, build candidate P from H's tree overlaid with the submitted after values. P keeps every submitted positive value even if the merge later chooses another value. Resolve each path using its submitted before value, current H value, and after value under [ADR-0622](../docs/adr/0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md). Build M with parents [H, P], even if M's tree equals H, and carry `Overrode` diagnostics. A losing deletion against an edited H file appears as that path's absence in P; a deletion of an already absent path loses no content. The protected receipt records the operation hash and P/M IDs, not a second copy of every path or a forensic record of no-op intent. Build L' with the receipt. One atomic compare-and-swap receive-pack advances H to M and L to L'. On stale or uncertain status, reread both refs and retry the same frozen request; an existing matching operation returns its original M. The server never treats Postgres or object existence as proof that P landed.

A submitted positive path wins a structural collision in P and M: replace a remote file at its ancestor, a remote subtree at its own path, or a remote case twin as needed to form one portable tree. The displaced remote entries remain in H's history. A submitted deletion removes only the exact path it observed; it does not erase a new remote subtree. Writing over a symlink makes a regular file, and an edited executable retains its observed mode after a remote deletion. A Gitlink cannot be silently rewritten as ordinary content. These rules need tree-level tests around the existing per-file content merge.

For an empty repository, a browser's first submission creates root candidate P directly as main and records { candidate: P, publication: P } in the operations ref in the same atomic update. A competing native first push makes that compare-and-swap fail; the browser retries against the new H. A pull from an empty repository returns head null and an empty snapshot. Native first push creates L0 if the operations ref does not already exist; an abandoned browser operation may have created that ref while main was still empty.

    H -- H2 -- M  main: title Two, body new
          \   /
           P       submitted proposal: title Two, body old

    L -------- L'  protected operations ref: S to {hash, P, M}

The gateway must ship before this publisher. The current Artifacts forwarding accepts force and delete updates, so its write token cannot remain exposed to ordinary native receive-pack. Native pushes may advance only main by fast-forward; they may not delete it or write any other ref. The gateway advertises the operations ref read-only, hides staging refs for both Git protocol versions, stages a client pack, checks all-parent ancestry, then promotes by old-OID compare-and-swap. The first native push creates main and L0 atomically if the operations ref is absent, or creates main while preserving an existing abandonment ledger. The [disposable Artifacts probes](../packages/server/evidence/git-gateway-staging/NOTES.md) established Worker-written Git objects and atomic two-ref CAS, not a complete real-client gateway. Backups and restores must preserve both refs and their objects as a consistent pair.

A normal path-limited git log can omit a losing P through Git's path simplification. Recovery should expose the receipt's P and M IDs and document git show M^2:path or git log --full-history -m -- path. A comment-only YAML header change currently disappears in shared/merge.ts without an `Overrode` diagnostic; fix that shared merge bug with a focused regression before using its result as the browser's conflict-free rebase gate.

## Future server-side Git connection

The browser still speaks this account-bound sync protocol. A later server-side connector can authenticate to GitHub, GitLab, or another compatible host and run Git fetch, commit, merge, and push using a temporary or cached local clone/object database. Epicenter need not host that repository. It does need a service that holds the host credential securely, identifies the repository, publishes conditionally, and returns a truthful receipt. GitHub's browser CORS limitation does not constrain a server-side connector.

RepositoryPublisher is a server-internal capability for readSnapshot and publishFrozenSubmission; the browser API depends on its outcomes, not the host. The Artifacts implementation uses the protected operations ref. Another host cannot claim the same exact retry and history guarantees merely because it speaks Git: it must prevent rewinds, establish a durable retry authority, and reconcile a lost push result. A derived index of all commits reachable from main is one alternative, but safe negative lookup requires complete catch-up to current main and exact P-to-M recovery. Large native pushes or a database restore can delay publication until backfill finishes. This was the independent review's strongest deletion alternative; it is not the current Artifacts choice.

## Execution and pressure tests

1. **Protect hosted Git.** Build the native gateway first. Exercise ordinary Git clone/fetch/push plus force, delete, other-ref and operations-ref attempts, concurrent pushes, first push, protocol v2 ref visibility, and crash cleanup against disposable Artifacts repositories.
2. **Prove publication.** Implement the service publisher and versioned request hash. Test local bare Git, then Artifacts: two submissions against one base, field/body overlap, losing candidate recovery, lost response followed by later native commits, duplicate senders, hash mismatch, and paired backup/restore.
3. **Preserve shared save semantics.** Keep the Folder queue and checked last-write-wins updates while replacing browser storage. Test cross-tab ordering, typed text through a failed save, and `.device/` exclusion. Repair comment-only YAML diagnostics before using merge results for remote rebasing.
4. **Replace browser storage.** Replace the old Git engine with snapshot/local/sealed/meta and atomic conflict-free pull rebasing. Exercise an editor held across seal and receipt, reversal during sealed send, ignored local files, structural collisions, executable mode, symlinks, Gitlinks, cross-tab saves, out-of-order deltas, overlapping units retained for server `Overrode`, and failed IndexedDB transitions. Compare server outcomes with and without an eligible rebase.
5. **Attach one app.** Add API-audience folder scopes to one existing Account, explicit repository selection and first-combine consent, separate sync status, and reopen retry. Test Vocab signed out, signed in, signed out, and signed in as another account.
6. **Review the result.** Measure real folder sizes and response memory before fixing transport limits. Run folder/server typechecks, local and native Git integration tests, and an end-to-end browser close/reopen publication test. Perform a post-implementation review before staging.

The unresolved transport choice is how to carry large binary files with bounded Worker memory. The correctness rule is fixed: a supported file must not become a permanently stuck sealed upload solely because it exceeds one inline request. The exact paging or resumable-blob framing should follow an Artifacts size and latency probe.
