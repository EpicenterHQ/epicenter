# Working-tree engine validation

The production browser engine now stores W directly and retains B/P as separate
checkpoints. It has no persisted overlay, revision, hidden prefix-deletion
intent, migration, or legacy runtime. The
[complete save-to-sync review](REVIEW.md) inventories what remains and why.

Recorded October 20, 2026 on an Apple M4 Max, macOS arm64, Bun 1.4.3. Browser
runs used Chromium 151.0.7922.34, WebKit 26.5, and Firefox 153. Checks ran on an
active development machine alongside package/workspace checks. Timings are
observations under contention, not a controlled performance comparison.

## Correctness

- The complete Folder package run passed 571 tests with 2,320 assertions across
  48 files. This includes the native engine, public browser handle, raw tree
  rewriting, storage, merge, and actual native smart-HTTP regressions.
- After the final concurrency fix, the focused browser/shared suite passed
  137 tests with 563 assertions across 15 files. The earlier complete run
  preceded that last fix; the final focused and browser runs cover it.
- Browser/shared/smoke TypeScript validation passed with unchanged project
  compiler options: 35 root files and their dependency closure, zero diagnostics.
  Package-wide checking also passed earlier in implementation. The final
  workspace-wide check exited 2 in concurrent declaration-schema and desktop
  draft-test work outside this change. A later package-wide check also failed
  in concurrent declaration/schema tests and exports. Neither is reported as
  a clean check; the final browser/shared/smoke dependency closure passes.
- Biome's error-level check passed for the browser engine, smoke runners, shared
  handle adapter changes, and touched tests. Existing non-null assertion warnings
  remain; no unsafe automatic fixes were applied.
- Documentation links and scoped whitespace checks pass. The repository-wide
  documentation hygiene check remains nonzero for unrelated ADR dependency
  warnings; it reports no working-tree or retired-spec issue.

Storage regressions establish atomic candidate refusal/abort, root guard
behavior including A -> B -> A, exact B/P acknowledgement preserving newer W,
metadata-only publication without file notification, offline collection-budget
persistence, failed post-publication collection retaining success, and one quota
collection/retry before reporting failure. An instrumented object-read test shows
commit preparation reads only B's commit, and indexed collection reads no blob
payloads. Fake IndexedDB tests do not establish real-device quota behavior.

Native-server regressions establish first-contact empty/nonempty repositories,
independent fields and paragraphs, later reversals across P, two-generation
rejection/deletion handling, canceled folder replacement without hidden deletion
intent, actual incoming deltas, shallow pushes, all-parent ancestry, incomplete
recovery, stale fetches/adoptions, exact retries, lost replies, and native fsck.
An empty working tree observing an empty server creates no unnecessary commit.

A final concurrency review reproduced a missing-object failure when an initial
fetch reused a local W blob that another tab replaced and collected before the
reply resumed. The regression failed before retaining the starting capture and
passed after the fix. Reconciliation now keeps starting and fresh captured bytes
alongside fetched objects, while publication still selects only live closures.
This temporary input is required for concurrency; current storage alone cannot
reconstruct it after collection.

## Three-browser checks

[Local results](local.json) and [network results](sync.json) each retain the exact
browser bundle SHA-256. Profiles and Git servers are disposable. Local
acknowledgements are simulated; the network run uses actual loopback native Git.

| Browser | Local saves | Network-run saves | Local save p95 | Local max |
| --- | --- | --- | --- | --- |
| Chromium | 205 | 54 | 8.4 ms | 15.3 ms |
| WebKit | 205 | 54 | 15 ms | 32 ms |
| Firefox | 205 | 54 | 10 ms | 40 ms |

The local run covers offline saving before first fetch, full-profile reopening,
two pages saving alongside commit preparation, independent paragraphs, exact P,
newer W through acknowledgement, shared blobs, atomic collection alongside saves,
and another persistent-profile reopen. It acknowledged 615 measured saves across
the engines. Root mismatches caused retries rather than lost writes.

A 500-directory probe captured three trees for one file. After saving 500
roughly 4 KB files offline, the same point capture still read three trees,
taking 1 ms in Chromium, 2 ms in WebKit, and 1 ms in Firefox in these runs.
There is no overlay backlog to load or normalize. This is one workload, not a
phone or wide-directory latency guarantee.

The network run acknowledged 162 saves. All three engines synchronized concurrent
fields/paragraphs, verified native readback, lost an actual successful push reply,
retained exact P and newer W through graceful profile reopening and collection,
then incorporated a later native edit without replaying accepted work. The
accepted pending commit occurred once in server ancestry. Native `fsck --strict`
passed in each run.

## Reproduction

From the repository root, with the installed Playwright browser binaries:

```sh
bun run --cwd packages/folder test
bun run --cwd packages/folder smoke:local --output "$PWD/packages/folder/evidence/browser-engine/working-tree/local.json"
bun run --cwd packages/folder smoke:sync:local --output "$PWD/packages/folder/evidence/browser-engine/working-tree/sync.json"
```

The [historical prototype](../working-tree-prototype/RESULTS.md) retains its
controlled model comparison, raw samples, and archived source. Its timings must
not be attributed to this later production bundle.

## Remaining costs and limits

Every content-changing save hashes its changed file and rewrites ancestor trees.
Wide directories and repeated large-file overwrites can be slower than a small
overlay. Atomic collection queues other operations; the 8 MiB retired-byte
budget does not bound physical storage or browser memory. Endless edits can
cause retries and defer synchronization.

The isomorphic-git adapter still recompresses known inflated objects into a
scratch repository, builds/reads packs and indexes, copies verified fetched
bytes, and assembles outgoing request bodies. Sync maps share byte references,
but these encoding steps create additional buffers. Full ancestry recovery and
parallel tabs can multiply temporary memory. Peak transport heap has not been
measured; no custom transport is proposed on these results alone.

These checks do not establish forced-process termination, browser eviction,
phone performance, real-device quota recovery, or hosted-service conditional
updates. Automatic public sync integration, retry scheduling, and network
deadlines remain separate work. There is no migration gate: the owner explicitly
authorized a fresh layout with zero users.

## Follow-up collapse verification

After removing fetch's unused returned `shallow` field and accumulator, the
browser/shared suite passed 137 tests with 560 assertions across 15 files.
The three removed assertions belonged to that deleted private result field;
object-set and wire-negotiation assertions remain. Folder package TypeScript
validation and error-level Biome checks on the changed code passed.

The complete package run passed 635 tests and failed one of 636 tests across
51 files. `local-patterns.test.ts` expected malformed JSON's reason to contain
`not JSON`, but received `JSON Parse error: Unexpected EOF`. That assertion
also fails when run alone without browser tests. This is outside the browser
save/sync path; no claim is made that the complete package is green or that
this failure predates the original implementation.

[Follow-up network results](collapse-sync.json) record another 162 saves across
Chromium, WebKit, and Firefox using the final adapter. All three passed actual
lost successful replies, later native edits, concurrent saves, pending/newer
work through profile reopen and collection, ancestry recovery without replay,
and native `fsck --strict`. The recorded bundle SHA-256 was checked against a
fresh build after the run. Earlier local timing observations above were not
rerun for this adapter-only cleanup.

## Landing verification

A detached checkout at `f53a0c5d33` received only the working-tree replacement
and its evidence, excluding the live checkout's unrelated unfinished edits.
Folder typechecking passed. The complete package run passed 631 tests and
failed the same malformed-JSON wording assertion, across 632 tests in 50 files.
Error-level Biome checks passed across 28 affected source, test, and smoke files.

[Landing network results](landing-sync.json) record 162 saves across Chromium,
WebKit, and Firefox against native Git. The final bundle hash was verified after
the run. Exact pending identity, lost successful replies, later remote changes,
newer offline work, collection, reopening, and native fsck passed in all three.

The last source changes clarify that the public opener already owns the local
handle and the sync trigger remains internal. The archived prototype report now
points to current validation instead of retaining its superseded migration gate.
There is no commit sequence number: hashes identify exact commits, and their
parent links provide the ancestry needed to settle a send.
