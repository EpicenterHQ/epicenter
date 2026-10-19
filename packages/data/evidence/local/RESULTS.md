# Local browser repository evidence

Recorded on 2026-10-19 with Bun 1.4.3 on macOS arm64.
[Raw results](results.json) retain engine versions and timings after scoped
capture. [Baseline results](results-before-narrow.json) retain the full-walk
measurements from `bff5a8cf8e`. Runs used the same fixture and browser binaries;
timings are individual desktop samples, not controlled latency guarantees.

## What ran

`smoke/local.ts` bundles the production local engine and opens two pages in
each engine's temporary persistent profile. It saves before any remote is
known, abandons a computed candidate without publishing it, closes the browser,
and reopens the same profile. A simulated successful empty-remote observation
then permits commit preparation.

Each page submits 100 successive edits to its own field while 30 commit
preparation/acknowledgement iterations run. A later save cannot replace an
exact pending commit. Acknowledging that commit preserves newer E. Both pages
then change independent body paragraphs, and both survive the next commit and
browser reopening. Each engine acknowledges 205 workload saves, 615 total.
Neither final field nor paragraph was missing.

The runner writes the production engine's captured objects into a temporary
native Git repository. `git hash-object` agrees on every identity,
`git fsck --strict` accepts the snapshot with its explicit shallow boundary,
and `git show main:notes/one.md` reads both final fields and paragraphs.

| Engine | Failed revision checks | Field-save p95 | Maximum field save |
| --- | ---: | ---: | ---: |
| Chromium 153.0.8010.12 | 269 | 2.5 ms | 75.2 ms |
| WebKit 26.5 | 328 | 5 ms | 115 ms |
| Firefox 151.0 | 325 | 4 ms | 80 ms |

The failed-check counts include commit attempts and saves. They are not the
number of retries of one save. The workload has continuous back-to-back writes;
the intended scheduler normally waits for editing to settle. These finite
results show convergence, not a starvation bound or a phone latency budget.
Timings varied across runs and are not performance thresholds.

## Capture scaling

A second fixture has 500 distinct nested folders. Capturing one file now
reads 3 tree objects: root, `archive`, and `archive/0`, down from 502. Five
captures and one save were measured per engine, with no latency assertions.

| Engine | Captures before | Captures after | Save before | Save after |
| --- | --- | --- | ---: | ---: |
| Chromium | 13.8 to 14.3 ms | 0.8 to 1.6 ms | 16.1 ms | 2.5 ms |
| WebKit | 33 to 35 ms | 1 to 3 ms | 36 ms | 3 ms |
| Firefox | 24 to 29 ms | 1 to 2 ms | 27 ms | 2 ms |

This demonstrates the intended tree-read reduction. It does not establish an
overall save-latency bound: the contention run still had outliers above 75 ms.

Afterward, the fixture seeds 500 pending edits, one in every folder, containing
2,050,890 UTF-8 bytes. One capture of the same file then reads 502 trees and all
E values. Its measured duration is 19.1 ms in Chromium, 38 ms in WebKit, and
25 ms in Firefox. This is a combined tree-expansion and pending-payload probe;
it does not isolate IndexedDB payload copying from tree reads, and does not
measure a whole save under that backlog.

All E values are still read, and their ancestor trees are opened to evaluate
effective directory occupancy after deletions. Large offline backlogs remain a
specific phone performance test. No persistent path index, pack cache,
immutable snapshot cache, or per-edit base store has been added.

## Unit regressions and review

The final focused suite passes 89 tests with 355 assertions. Package typecheck,
formatting and lint checks pass. Repository document hygiene retains the same
94 findings recorded before this implementation.

The focused suite covers native object encoding, raw tree preservation,
field/region merge, row source and schema issues, stale publication rejection,
aborted batches, exact acknowledgements, first-fetch knowledge, byte bases,
close during an unpublished operation, and local structural refusals.
Folder tombstones remove opaque names and permit restoring one child without
resurrecting its siblings. Row deletion does not confuse another row's file
with the attachment directory.

Claude Sonnet 5.5 implemented the object codec in a disposable clone. Codex
inspected its returned files, fixed header decoding, and reproduced its native
Git checks. Independent GPT-6.1 Sol and Claude Opus 5.5 implementation reviews
retained B/C/E plus revision publication. Findings produced regressions for
EOF framing, gitlinks, exact witnesses, opaque occupancy, and remote knowledge.
A focused Codex follow-up checked hierarchical E against tree rebuilding.
The owner chose safe refusal of local file-directory replacements. A generic
planner protocol was deferred.

Scoped capture adds regressions for exact tree-read bounds, commit input scope,
row lists without attachment traversal, partial-name prefixes, pending-child
listings, folders emptied by pending deletions, and current-data reads that do
not decode B. A focused Claude Opus 5.5 read-only pass found no lost-input or
occupancy counterexample; Codex inspected the cumulative change and ran the
tests and browser workload. This was a standalone informed review, not a fresh
cross-model design panel. The reviewer did not execute checks.

The collision refusal still identifies an actual conflicting path. If native
Git already contains multiple case twins, the named path may differ with walk
order. Unvisited subtrees are no longer checked for corruption by unrelated
operations. Full integrity checks and complete raw object traversal for future
collection must have their own scope; this optimization does not establish
that object-retention machinery.

## Limits

Acknowledgement and the first empty observation are local simulations, not
network evidence. This does not exercise Git fetch/push, pack deltas, uncertain
push ancestry, replay prevention after a lost reply, collection, a resumed
network attempt, or Cloudflare Artifacts. No production operation ran.

Profile reopening is graceful. The failed-batch test uses in-memory IndexedDB;
it is not a forced browser process kill, a power-loss test, quota exhaustion,
or iPhone evidence. The fixture page loads from loopback, so this also does
not establish an application's cold offline boot or service-worker caching.
No app uses this engine yet, and no existing app data has been migrated.
