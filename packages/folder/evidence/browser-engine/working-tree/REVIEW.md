# Save-to-sync collapse review

The coherent model is one saved folder, one incorporated remote checkpoint,
and one exact sending checkpoint. Storage publishes and retains those snapshots;
sync settles their network meaning. Temporary captures protect a computation
while other tabs change storage. This review covers the complete browser
save-to-sync flow, including the shared public handle, but does not propose a
custom Git transport.

## Files read for the review

```text
packages/folder/
|-- README.md, package.json, tsconfig.json
|-- src/
|   |-- handle.ts, local-folder.ts, local-folder.test.ts
|   |-- git/{raw-objects,tree-merge}.ts, git/tree-merge.test.ts
|   |-- shared/{merge,row}.ts, shared/content/canonical.ts
|   `-- browser/
|       |-- README.md, repository.ts, storage.ts, sync.ts
|       |-- repository{,.capture,.change,.native}.test.ts
|       |-- storage{,.retention}.test.ts, sync{,.transport}.test.ts
|       `-- git/
|           |-- snapshot.ts, snapshot.test.ts, closure.ts, ancestry.ts
|           `-- transfer.ts, transfer-fs.ts, transfer.test.ts, transfer.test-support.ts
|-- smoke/{client,local,sync-client,sync,git-server}.ts
`-- evidence/browser-engine/
    |-- working-tree/{REVIEW.md,RESULTS.md,local.json,sync.json}
    `-- working-tree-prototype/{RESULTS.md,root-guards.json}
docs/adr/{README.md,0628-*,0636-*,0650-*}
```

The first-read path is public handle -> local file/row operation -> storage
capture/publication. The independent sync path owns checkpoint creation and
settlement. Keep each boundary for its invariant rather than combining them
into a manager with callbacks.

## What disappeared

| Before | Information or coordination it carried | Result |
| --- | --- | --- |
| Commit head plus persisted `edits` | Reconstruct current files by applying text and prefix tombstones | W directly names current contents. Delete overlay storage, normalization, shadowing, and prefix markers together. |
| Publication `revision` | Detect changes to the mutable overlay or refs | Immutable W guards file saves; W/B/P guards preparation and adoption; exact B/P guards acknowledgement. No counter to update across those owners. |
| `snapshot.head.root` and metadata W | Two names for the same current root | Metadata owns W once. Capture exposes file and directory projections directly. |
| `snapshotPaths`, `snapshotDirectories`, local path and union sets | Reconstruct effective occupancy from committed entries plus E | Read captured file and directory entries directly. No overlay-to-occupancy synchronization or opaque-directory set. |
| Repository and storage `closed` flags | The same connection lifetime in two owners | Storage owns one flag; repository consults its getter and directly forwards close and subscription. The public handle's earlier closing phase remains distinct. |
| Nested row-save storage-error wrapper | Repeated the file save's error adaptation | Row preparation checks its source, then calls the one guarded file-save owner. |
| Local `prepareCommit`, `PendingCommit` type, commit capture scope | File layer coordinated Git preparation and overlay folding | Sync owns preparation; a small atomic `checkpoint()` read provides metadata and B's tree without loading working files. |
| `publishedSnapshot` plus a sync-finally sweep | Sync tracked whether storage should collect | Storage maintains after its own durable transitions. No attempt-wide maintenance flag. |
| `accepted` / `unchanged` / `pending` attempt outcome | Summarized one attempt while newer saves could already exist | `run()` returns a bounded `Result<void, SyncError>`; B/P/W retain the durable facts. Transport's pushed/rejected distinction remains necessary. |
| Capture cache plus a discarded closure map during sync capture | Both accumulated the same captured objects | The closure result owns sync capture directly. |
| New reconciliation pool copied from incoming and captured maps | Repeated ownership of the operation's available objects | Extend the fresh private captured map with starting-capture, fetched, and generated objects. Retention still selects a separate publishable closure. |
| `TransferInput.refs` plus outer push B/head arguments | Repeated the exact request identity in two places | Fetch and push receive direct objects/base/shallow fields; push adds head once. No duplicated pair to keep aligned. |
| Caller-supplied boundary on the sync push helper | Repeated the rule that B is the retained boundary | The helper derives it from its captured B. Low-level transport still accepts explicit boundaries for protocol tests. |
| Fetch result `shallow` and its accumulator set | Reported reachable Git boundaries that sync never consumed | Fetch returns only the remote tip and new objects. Keep the internal boundary that stops traversal; ancestry proofs inspect held commit objects and leave missing parents unknown. |
| Working-tree prototype variants and migration plan | Experimental modes and conversion work | Archive the measured prototype source with its evidence. Production has one fresh database layout and no migration or compatibility path. |

These removals eliminate reconstruction, mirrored lifecycle, and inter-layer
maintenance obligations. They do not claim that every removed name was an
independent concept. The main durable content-model reduction is two
representations becoming one; three logical folder versions remain necessary.

## Current nouns and persisted keys

| Owner and concept | Distinct information or responsibility |
| --- | --- |
| Public `Folder` mirror | Landed files and rows, one serial write queue, and draining close across browser and native engines. |
| Local repository | Browser file admission and unconditional whole-file publication. Its identity is the database key, independent of account or remote. |
| Repository storage | One IndexedDB connection, atomic captures/publications, notification delivery, and snapshot collection. |
| Sync instance | One coalesced network attempt per instance. It owns the URL, author callback, optional request function, and abort signal. No cross-tab leader exists. |
| W: `meta.state.workingTree` | Current saved folder. Always a valid tree, including empty. |
| B: `meta.state.remoteBase` | Last incorporated server commit; undefined/empty/commit knowledge is significant. |
| P: `meta.state.pendingCommit` | Exact prepared send that later saves cannot replace until its outcome is established. |
| `meta.state.retiredBytes` | Persisted conservative collection budget. An exact garbage count would require additional accounting. |
| `objects[hash].type`, `.bytes` | Shared immutable Git object contents. Trees hold raw names/modes/child hashes; blobs hold bytes; B/P commits hold tree and parent references. |
| Object-type index | IndexedDB-maintained projection used to find blob keys without reading their values. No separate membership authority. |
| `RepositorySnapshot` | One transaction's metadata, scoped files/directories, and captured object bytes. It is neither another saved folder nor a backup. |
| `from` and row `sent` | A draft's actual starting source and its submitted candidate. They can differ from current W after another writer saves. |
| Transient D on rejected P | P after witnessed P-to-W deletions. Prevents resurrecting rejected text before newer replacements are merged. Never persisted. |
| Fetched remote and retained candidate | Remote input may contain connecting history; only current snapshot closures may enter durable storage. |
| Git transfer scratch repository | The filesystem representation isomorphic-git needs for one call. It is never the browser's durable working folder. |

The database is `epicenter.folder.<key>`, version 1, with only `meta` and
`objects`. There is no old-schema detection, import, reset state, fallback,
persisted queue, dirty flag, lease, connection record, or per-file base store.

## Current methods and options

| Boundary or method | Responsibility |
| --- | --- |
| `openFolder({ tables })` | Open this origin's default folder; schemas describe reads, not save admission. |
| `files.list(prefix)`, `read(path)` | Select current file paths or bytes. Exclude gitlinks from readable files. |
| `files.write(path, from, content)`, `delete(path, from)` | Save a witnessed change; text repairs use this same API. |
| `tables.<name>.list()`, `get(id)` | Parse immediate Markdown rows and report schema/source issues. |
| `tables.<name>.set(id, from, change)`, `delete(id, from)` | Construct a row candidate and delegate its file change. `change.fields` and `change.body` express different edits. |
| Private `saveFile(..., rowFields)` | Own merge/retry/publication. The field-edit flag protects concurrently malformed frontmatter; it is not a separate storage mode. |
| `onChange(listener)` | Observe durable content changes. Paths are hints; null permits whole-folder invalidation. Origin distinguishes this handle from a peer. |
| `status`, `onStatusChange(listener)` | Saving activity and last storage failure. They are local operation/UI state, not sync completion. |
| Public `close()` | Stop new calls and wait for already-started work before releasing the engine. |
| `storage.capture(scope)` | Capture needed bytes atomically. Path arrays, prefix, rows, tree-only `[]`, full current files, and sync closures have distinct read costs. |
| `storage.checkpoint()` | Capture refs and B's tree when preparation needs it; no working directory/blob traversal. `baseTree` is a temporary projection. |
| `storage.publish({ expected, workingTree?, objects?, refs?, retiredBytes?, paths? })` | Compare and publish in one strict write transaction. A string expected value guards W only and cannot change refs; a captured state guards W/B/P. Other fields supply candidate bytes, changed refs, accounting, or notifications. |
| `storage.acknowledge(base, head)` | Settle the exact network request while preserving latest W. |
| `storage.collect()` | Verify the three live closures and atomically sweep unreachable objects. |
| `storage.subscribe`, `closed`, `close` | Own the one connection's listeners and terminal lifetime. |
| Private `transact`, `requested`, `completed`, `maintain` | Own IDB completion/abort semantics and best-effort post-publication collection. A failed request and transaction abort are separate events. |
| `readSnapshot`, `snapshotContent`, `snapshotObject` | Decode scoped tree occupancy and access captured bytes, failing precisely when required objects were not captured. |
| `changeSnapshot` | Hash file changes and rewrite only affected ancestor trees while retaining unrelated raw entries. |
| `withoutDeletedEntries`, `mergeTrees` | Derive transient D and reconcile raw structure plus field/region contents. |
| `snapshotObjects` | Select complete file closures without following commit parents. Selection for publication is distinct from all available fetched history. |
| `prepareCommit(storage, author)` | Freeze W into one exact P; return an existing P unchanged. |
| `createSync(...).run()` | Prepare, fetch, prove ancestry, reconcile, publish, and attempt at most one push. Return one bounded attempt's result. |
| Private `transferRefs`, `push` | Derive protocol boundary from B; translate a definitive push outcome into exact acknowledgement. |
| `includesCommit` | Follow every held parent; preserve included/excluded/unknown evidence. |
| `fetchRemote({ url, objects, base, shallow, initial, recover?, request?, signal? })` | Ordinary Git negotiation and verified incoming objects. Initial depth and recovery have different meanings. |
| `pushRemote({ url, objects, base, head, shallow, request?, signal? })` | Conditionally send the exact request; distinguish rejection from an unknown outcome. |
| Adapter `openScratch`, `readShallow`, `readVerified`, `readFetched`, `readFetchedTree`, `ancestry`, `ordinary`, `assertLive` | Isolate filesystem lifetime, Git boundaries, verification, shallow proof, library failures, and cancellation. |
| Adapter `createHttp`, `bodyOf`, `fail`, `failure`, `close`, request-body `collect` | Bridge fetch to the library while preserving interrupted streams and releasing readers. |
| Scratch FS `readFile`, `writeFile`, `unlink`, `readdir`, `mkdir`, `rmdir`, `stat`, `lstat`, `readlink`, `symlink`, `clear` | Implement the filesystem protocol required by isomorphic-git. Links deliberately refuse; no authored-folder operations use this filesystem. |

## Temporary maps, sets, and buffers

| Structure and lifetime | Why it remains |
| --- | --- |
| Handle `inflight` promise set | Close must wait for exact started calls, including a status observer that closes reentrantly. |
| Handle/status/storage listener sets | Actual subscriber membership; cannot be derived from content. |
| Fresh captured `objects` map | Immutable input bytes survive another tab's publication/GC. Sync extends this map rather than making another full pool. |
| Starting fetch `objects` map | A fetched snapshot can borrow a W blob another tab has since collected. Fresh storage cannot reconstruct those bytes; retain the original capture until the response is settled. |
| Captured `files` map and `directories` set | Scoped path lookup and raw/unexpanded structural occupancy. Derived once from W, never maintained between operations. |
| Reader decoded-tree cache, ancestor set, per-tree name set | Avoid repeated decoding, detect cycles, and reject duplicate raw names. These are different facts. |
| Rewrite path-edit trie (`children` maps) | Organize one candidate's paths for ancestor rewriting. No edit trie survives publication. |
| Rewrite new-object map, known-object set, decoded-tree cache | Separate newly created bytes, already-present identities, and reusable decoded contents. |
| D-pruning raw-name map and new-object map | Match raw entries and retain newly constructed trees. File replacements stay separate from deletion evidence. |
| Content/tree merge maps and override list | Compare base/current/change units and retain the facts needed for override trailers. |
| Closure result map and traversal queue | Own selected objects and graph work. Storage directly reuses this map for a sync capture. |
| Retained candidate closure map | Filter available history to exactly the objects allowed into durable storage. Values share byte references with the available pool. |
| GC live set, blob-key set, traversal queue | Distinct liveness, verified presence/type, and remaining traversal work inside one transaction. No blob payload cache. |
| Ancestry visited set and queue | Detect all-parent reachability without looping; missing parents are uncertainty. |
| Override trailer set | Deduplicate diagnostics after comparing final values with remote values. |
| Adapter known and fetched maps | Borrow held objects and own verified new bytes. Whole-history recovery starts without known objects. |
| Adapter commit/tree traversal sets, shallow set, queues | Stop at real Git boundaries and avoid rereading DAG nodes. |
| Scratch directory-child maps and file buffers | The temporary filesystem representation required by the library, not a second durable content model. |
| Per-transfer Git cache | Library-owned decoded objects and pack/index caches; discarded with the transfer. |
| HTTP reader list and outgoing chunk list/buffer | Cancel unfinished replies; adapt generated request chunks to one browser fetch body. |
| Copied caller byte witness, submitted row, Blob output | Preserve mutable input and draft identity across awaits; return isolated readable bytes. |

## Lifecycle and proof states

| State | Independent fact |
| --- | --- |
| Public open / closing / closed | Whether new calls may start and whether existing calls still need draining. The closing promise also makes repeated close calls share completion. |
| Storage open / closed | Whether the underlying connection can start another transaction. It becomes closed after the public handle drains, or immediately for direct internal close. |
| Active save count and status snapshot | Overlapping save activity versus the last storage failure. The status object is an observable snapshot, not a dirty-content flag. |
| IDB request pending/success/error and transaction complete/abort | A request completing does not yet acknowledge a committed save. |
| Root guard matches / changed | Whether captured immutable inputs still apply. A changed guard leaves candidate bytes unpublished and causes recapture or another bounded sync attempt. |
| B unknown / observed empty / incorporated commit | First-contact knowledge and ancestry, not three different folder storage modes. |
| P absent / exact unsettled commit | Whether an exact send still needs settlement. Newer W is independent. |
| Sync idle / running promise | Coalescing within this instance; it says nothing about another tab or unsent content. |
| Pending included / excluded / unknown | Evidence about remote ancestry. Only proven exclusion permits replacing P. |
| Recovery not attempted / attempted once | Bound network recovery without turning missing ancestry into rejection. |
| Push pushed / rejected / transport failure | Definitive acceptance, definitive ref rejection, or uncertainty. |
| Adapter decision unset / pushed / rejected / limited | What the push advertisement established; limited history is not rejection. |
| Adapter HTTP failure latch and protocol defect | A failed stream outranks a partly parsed reply. A wrong local ref/head is a programming defect, distinct from an ordinary transfer failure. Neither can be inferred from the durable pending pointer. |
| GC below budget / due / failed | Scheduling and failure follow from metadata or the current call; there is no persisted GC state machine. A failed sweep keeps the budget and all objects. |

## Resulting calls

Applications continue to save files or partial rows:

```ts
await folder.files.write(path, from, text);
await folder.tables.notes.set(id, fromRow, { fields: { title: 'New' } });
```

Internal preparation and networking remain outside the public Folder:

```ts
await prepareCommit(repository.storage, author());
await createSync(repository, { url, author, request, signal }).run();
```

`run()` invokes preparation itself. Its low-level calls now have one request
identity:

```ts
await fetchRemote({ url, objects, base, shallow, initial, request, signal });
await pushRemote({ url, objects, base, head, shallow, request, signal });
```

A local save follows capture -> merge -> tree rewrite -> W-guarded publication.
Preparation follows atomic checkpoint read -> hash one commit -> W/B/P-guarded P.
Network sync follows capture -> fetch -> fresh capture/proof -> reconcile ->
W/B/P-guarded adoption -> conditional push -> exact B/P acknowledgement.
Storage owns maintenance after those durable transitions.

## Transport is a separate bargain

The adapter copies and encodes data in ways root/map simplification does not
remove. IndexedDB captures inflated bytes. `openScratch` sends each held object
through isomorphic-git's `writeObject`; installed version 1.38.5 wraps, hashes,
and deflates that content. Scratch writes copy their input. A transfer can
also hold compressed packs, index structures, and decoded-object caches.
`readVerified` copies inflated library output and verifies its hash. Outgoing
request chunks coexist with a concatenated body buffer during assembly.

Map copies mostly copy references, not blob payloads. Removing those maps does
not establish a comparable reduction in peak heap. Seed inputs can still
include unsent W objects that are irrelevant to the wire. Captured W/B/P,
fetched history, scratch objects/packs, and outgoing buffers can overlap.
Another tab can run another independent transfer. Full ancestry recovery can
cost much more memory and traffic than the active folder.

Keeping isomorphic-git buys tested negotiation, pack/delta decoding, shallow
push, conditional-ref advertisement checks, and server-report parsing. A custom
transport would need to own those behaviors and interrupted-response handling.
We removed duplicated request fields, not this adapter. Measure representative
binary/history peak memory before deciding whether narrowing scratch seed
closures or replacing transport repays its new obligations. No peak-memory
or custom-transport performance claim is made here.

## Correctness and costs

See [recorded validation](RESULTS.md). Coverage preserves exact pending sends,
newer reversals, independent fields and paragraphs, raw native entries,
publication aborts and retries, snapshot retention, and graceful reopening.
A dedicated native-server regression proves canceled folder replacement has no
hidden deletion intent. Phone durability, eviction, hosted protocol behavior,
forced termination, and measured peak transport memory remain unproven.

The costs retained are file hashing, ancestor-tree rewriting, periodic atomic
collection, possible retries or sync deferral under continuous editing, and the
transport's temporary encoding/copying. These costs own actual work. No extra
coordinator was added to hide them.

## Follow-up collapse pass

The follow-up traced the public local handle, repository, storage, sync,
snapshot closure and ancestry owners, and transport through their tests and
smoke callers. The fresh deletion is the unused fetched-boundary result above.
Exact object-set and wire-request assertions still verify tip-only fetches,
B-based negotiation, and full recovery. Three assertions of the removed result
field disappear with that private contract.

The three durable snapshots, captured input bytes, selected publication closure,
and public close drain retain distinct information. Combining them would add
coordination or lose concurrent work. No further structural deletion cleared
that bar. The runtime search found no migration, legacy reader, compatibility
branch, persisted revision, or superseded overlay helper. This is a clean break
in browser storage; the shared merge rules and ordinary Git adapter remain.

The landing review also removed the archived prototype report's superseded
migration gate. Its measurements remain historical evidence, while the current
validation owns acceptance claims. Source comments now distinguish the wired
public offline handle from the still-internal manual sync trigger. Commit labels
such as C1/C2 are explanatory only; no numeric version or ordering ledger exists.
