# Local browser repository evidence

Recorded on 2026-10-19 with Bun 1.4.3 on macOS arm64.
[Raw results](results.json) retain engine versions and timings.

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
| Chromium 153.0.8010.12 | 275 | 3 ms | 35.8 ms |
| WebKit 26.5 | 352 | 11 ms | 35 ms |
| Firefox 151.0 | 385 | 5 ms | 12 ms |

The failed-check counts include commit attempts and saves. They are not the
number of retries of one save. The workload has continuous back-to-back writes;
the intended scheduler normally waits for editing to settle. These finite
results show convergence, not a starvation bound or a phone latency budget.
Timings varied across runs and are not performance thresholds.

## Capture scaling

A second fixture has 500 distinct nested folders. Capturing one file reads
502 tree objects: capture currently walks the complete trees. Five captures
and one save were measured per engine, with no latency assertions.

| Engine | Five one-file captures | One save |
| --- | --- | ---: |
| Chromium | 13.8 to 14.3 ms | 16.1 ms |
| WebKit | 33 to 35 ms | 36 ms |
| Firefox | 24 to 29 ms | 27 ms |

This supports narrowing reads to the requested paths before app migration.
All E values are also loaded today; prolonged offline editing with large E
still needs a discriminating measurement. No pack cache, immutable snapshot
cache, or per-edit base store has been added to hide either cost.

## Unit regressions and review

The final focused suite passes 85 tests with 333 assertions. Package typecheck,
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
planner protocol was deferred; path-scoped capture is the next concrete task.

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
