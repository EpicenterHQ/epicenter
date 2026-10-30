# 0684. Browser folders submit frozen file changes instead of running Git

- **Status:** Rejected
- **Date:** 2026-10-23
- **Rejected:** 2026-10-30, in favor of the file contract's decisions 11 and 12 (2026-10-30): the web never syncs; a browser keeps its own files (OPFS through `openDevice`) and uploads new ones through the server, which commits them. A browser holds no snapshot of a repository and submits no frozen changes to merge into one. Never built.
- **Supersedes:** [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at browser Git storage, commit construction, ancestry recovery, and sync transactions; [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) at the browser clone.
- **Relates:** [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (local opening and explicit connection), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (merge units and recovery), [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) and [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md) (local saves and sync merges).
- **Unbuilt:** browser snapshot/overlay storage, the sync attachment and transport, atomic pull reconciliation, and replacement of the browser Git engine.

## Context

The browser Folder currently retains Git objects and roots for a working tree, remote base, and pending commit. It constructs commits and resolves uncertain pushes with Git ancestry. The public Folder already saves locally without a connection. The owner chose a clean break: an overwritten unsynced local version does not need an individual Git commit, while each submitted proposal must be recoverable if a merge chooses another value.

The browser can use an Epicenter-specific protocol even though desktop folders continue to use local Git and compatible remotes. That lets the service own Git publication and leaves the browser with the state needed for local reads, offline saves, and exact retry.

## Decision

**A browser Folder stores a complete last-pulled remote snapshot, one latest unsealed local value per changed path, and at most one immutable sealed submission.** The snapshot names one fully installed main commit and contains every path needed for offline reads. A local value has latest content or deletion, the value before its first unsealed write, a possible dependency on the sealed submission, and a generation for guarded writes. A later local write replaces that path's unsealed value. A sealed submission retains its exact request through lost responses; later writes remain unsealed. No Git object pool, edit history, or published-revision markers live in the browser.

**The public Folder remains a local API and browser sync is an explicit attachment to one Account and immutable repository ID.** Opening, reading, and saving require no sign-in. A successful Folder save means local persistence; a distinct sync status reports pending paths and the exact Git publication receipt. Sign-in alone never attaches a folder, and a different account or repository cannot silently inherit its binding. Local saves follow ADR-0689 and ADR-0690: the Folder queue orders them, and the later write wins per field, body, or whole file without a local merge. A clean save is a no-op; an explicit restore uses a direct file write.

**A completed pull installs one pinned remote head and conflict-free local rebases atomically.** An eligible unsealed file is rebased as a whole against the incoming remote value when the shared merge finds no competing unit and the result is valid for its format. Its local base becomes the incoming value. An overlapping file keeps its old base and local value until the hosted Git merge can record which unit lost in an `Overrode` trailer. An unsettled sealed submission remains immutable, and dependent local files may stay masked until its receipt or fenced abandonment. A guarded transaction installs the complete remote snapshot, matching receipt, eligible rebases, and head together; it never advances the head after a partial install. This keeps independent pulled changes visible without erasing the Git diagnostics for actual overlaps.

**The browser sends frozen file changes to an account-bound Epicenter sync route and does not construct or transfer Git history.** The server returns a complete remote delta or snapshot and the original publication receipt. Browser storage contains no Git object pool, commit graph, fetch negotiation, or ancestry recovery. The browser sync contract names neither Artifacts nor a Git ref.

This proposed browser path would replace ADR-0690's current browser replica, which is a Git working tree, for the browser runtime.

## Consequences

- IndexedDB keeps the active remote files and changed local files, not committed history. A path with repeated offline saves needs one latest unsealed value; an earlier sealed value remains until its receipt is established.
- The shared merge's missing comment-only YAML diagnostic must be repaired before its `overridden` result gates rebasing. Valid JSON inputs must not become invalid through the new local save or rebase path; changing the existing Git merge fallback is a separate decision under ADR-0622.
- The browser can close offline and upload on reopen. It need not run while closed.
- The clean-break opener does not read or delete the previous browser database. There is no automatic migration; ADR-0633's carry-before-deletion rule remains applicable if that old storage is later removed.
- A submitted losing proposal stays recoverable through Git parentage. An unsealed value overwritten before submission may disappear.
- The service, not the browser, must enforce idempotency, merge rules, conditional main updates, and an exact publication receipt. A blocked sealed submission cannot be released locally after sign-out or an uncertain response without a service-authoritative receipt or durable abandonment fence.
- A future server-side connector can fetch, commit, and push to another Git host without changing Folder or the browser protocol. It must independently satisfy the receipt and no-rewind guarantees before claiming equivalent behavior.
- Complete reconciliation, mode and Gitlink handling, ignored local files, and large-file transport require focused implementation and tests.

## Considered alternatives

- **Keep the browser Git clone.** It preserves generic Git transport in the browser but retains an object pool, commit creation, ancestry recovery, and CORS-sensitive hosting despite the Epicenter-specific browser destination.
- **Order whole files on the service.** It is smaller than semantic publication but lets an independent field or body edit disappear from the visible result. This would change the owner's explicit merge requirement.
- **Make semantic records primary and export Git afterward.** It creates two competing authorities for arbitrary files and for desktop commits made directly through Git.
- **Use OPFS or SQLite for the browser file store.** Neither changes the sealed-request, cross-tab transaction, or Git receipt problem. IndexedDB already provides atomic updates for the needed records; revisit storage only with measured size or throughput evidence.
- **Keep every local edit as a queue entry.** It preserves the intent of intermediate offline saves that the owner explicitly allowed to be coalesced, while making cross-tab ordering and reconciliation more complex.
- **Seal one operation per changed path.** One refused path would not delay the others, but it multiplies receipts, Git commits, and retry states. Start with one bounded batch and preseal validation; reconsider per-path sealing if real blocked batches are frequent.
- **Rebase every overlap during pull.** It makes more remote fields visible before upload but settles competing units outside Git, so the later publication loses the `Overrode` diagnostic that identifies the losing unit. Rebase only whole files whose changes do not compete.
- **Record every path action in the candidate commit.** A losing positive value is in the candidate tree; a losing deletion against an edited file appears as its absence relative to the main parent. No-op intent audit would need extra metadata but is not required to recover competing content or return an exact receipt.
- **Advance the pulled head after partial installation.** Canceling a local edit can then reveal stale remote bytes that a later delta will not resend.
- **Add sync to openFolder.** It couples account-free local opening to a credential and repository that may not exist yet.
