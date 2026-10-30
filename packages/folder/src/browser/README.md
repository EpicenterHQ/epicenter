# Browser folder engine

This is the engine behind the legacy `openFolder({ tables })` from
`@epicenter/folder/browser`: one current folder per origin, saved in IndexedDB
as an immutable Git tree. Unchanged files share objects. Files and table
views expose no commits, roots, history, or collection controls; rows remain
views of Markdown files. Opening and saving require no account, network, or
declaration file. The Folder mirror drains queued writes before releasing
storage.

**The browser no longer exchanges Git.** Its sync (`prepareCommit`,
`createSync`, the isomorphic-git transport) is deleted: the web never syncs
(file contract decisions 11 and 12). A browser keeps its own files and
uploads new ones through the server. [ADR-0623](../../../../docs/adr/0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md)
is superseded, and [ADR-0684](../../../../docs/adr/0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md)
and [ADR-0685](../../../../docs/adr/0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md)
are rejected. New apps open a contract's files with `openDevice(contract)`,
over this origin's private file system ([`src/device/`](../device/)). This
engine stays until Whispering, Todos, Honeycrisp, Capture, and Vocab move to
that opener.

[ADR-0650](../../../../docs/adr/0650-a-browsers-current-folder-is-one-immutable-tree.md)
records the working-tree decision.

## Stored data

Each origin's default folder opens `epicenter.folder.default`, version 1.
Internal tests can select another key. This is a clean break: there is no
migration, legacy reader, or fallback to the earlier IndexedDB or OPFS storage.
Existing older databases and OPFS files are not opened or changed.

| Store | Key | Stored value |
| --- | --- | --- |
| `meta` | `state` | `workingTree`, `remoteBase`, `pendingCommit`, `retiredBytes` |
| `objects` | Git object hash | Immutable `{ type, bytes }` with inflated commit, tree, or blob contents |

`workingTree` always names a valid tree, including Git's canonical empty tree.
`remoteBase` and `pendingCommit` were sync's checkpoints. Nothing writes them
now; a database that holds them from before keeps their closures alive until
this engine retires. `retiredBytes` conservatively schedules
collection; it is neither an exact garbage count nor a physical storage limit.
An IndexedDB index on object `type` is database-maintained, not another ledger.

There is no saved edit overlay, deletion marker, dirty-path map, revision,
per-file merge base, or local save history. Diffs are temporary comparisons of
trees. Retention keeps current snapshot closures and stops at commit parents.
Git history needed for ancestry proofs can be fetched into temporary memory.

## Saving

A file save captures W's required trees and the current file bytes in one
read transaction. The Folder queues writes in call order. A row update first
reads the file from storage at its turn and shows that fresh value in the
mirror, then submits one unconditional put when its patch changes a value.
The Folder shows the put result only after it lands.
The engine hashes the submitted file and
rewrites its ancestor directories. A write transaction compares captured W,
then publishes the new objects and root together. A changed root retries the
operation. Other tabs' B/P changes do not invalidate a local file save, and the
save preserves the stored checkpoints and collection accounting.

A point capture reads only the path's ancestor trees and blob. Prefix lists
walk matching directories without loading file bytes. Row lists load immediate
Markdown rows. `capture([])` walks all trees without blobs; an omitted scope
captures all current files; `capture('sync')` includes W and both checkpoint
closures, which retention still honors. Captured objects stay in an operation-local map so a later save or
collection cannot change the inputs of an in-progress computation.

Public saves compare no prior file content and perform no content merge.
The last publication wins. The Svelte editor draft retains typed input
through outside observations and failures until its own save answers.

Native names, untouched modes, symlinks, gitlinks, and directory occupancy
survive tree rewriting. File/directory replacements require a witnessed
removal before reusing the path. A gitlink stays a structural leaf and is not
reported as a readable or successfully deleted file. Raw writes retain BOM and
binary content; mutable caller buffers are copied before awaits.

Only a changed W notifies subscribers. Local saves name their paths. Checkpoint-only changes and collection do
not notify file views. Failed publication reports `StorageFailed`, including
the browser's reason, without replacing the old root. No-op engine saves notify
nobody; the public Folder still announces a successful explicit publication.

## Collection and costs

Storage collects after checkpoint retirement and when conservative retired
bytes reach 8 MiB. It marks W's tree and B/P's commits plus file snapshots, then
sweeps other objects in the same write transaction. A missing or wrongly typed
live object aborts the sweep. Blob keys from the type index establish liveness
without loading blob payloads. No reference counts or incremental collector
state are maintained.

Collection remains in the operation's lifetime. It can delay completion and
queue other tabs. A failure after publication is logged and leaves that save
successful. A quota failure before publication collects and retries once with
the same guards; another failure leaves the previous root and caller's draft.
The budget persists across reopening and is reset only by successful collection.

Saves hash contents and rewrite ancestor directories. Wide directories and
repeated large-file overwrites can cost more than a small overlay. Large offline
backlogs no longer force each point read to load all saved edits. The
[prototype measurements](../../evidence/browser-engine/working-tree-prototype/RESULTS.md)
show that tradeoff; they are not a timing guarantee for this implementation.

## Verification

From the repository root:

```sh
bun run --cwd packages/folder typecheck
bun run --cwd packages/folder test:engine
```

[Working-tree evidence](../../evidence/browser-engine/working-tree/RESULTS.md)
records the engine's concurrency, collection, and full-profile reopening as
they stood with sync. The browser smoke for the contract opener is
`bun run --cwd packages/folder smoke:device`.
