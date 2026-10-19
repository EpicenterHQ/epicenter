# Repository revision contention experiment

Date: 2026-10-19. Question: does one repository revision cause enough retries
during two-tab saves and sync to justify storing a base and revision for each
pending file?

Keep the repository revision. The desktop prototype preserved both tabs' latest
independent fields and body regions in all 24 runs, with 2,360 acknowledged
saves. Natural workloads continued adopting incoming data. A deliberately
extended computation window stopped adoption during fast saves and converged
after they paused. These are bounded prototype observations, not production
engine or iPhone acceptance results.

## Product requirements used

The owner clarified these requirements during the experiment:

- The browser need only support Epicenter's Git service. This permits a smaller
  compatibility target; it does not select a custom server sync protocol.
- Downloading the whole active repository for offline use is acceptable.
  Selective offline files and partially available repository states are not
  required.
- Automatic resolution is sufficient. Recovering committed versions through
  ordinary desktop Git is sufficient; every intermediate acknowledged save need
  not have its own recoverable version. Independent fields and text regions
  must still survive. The durable recovery boundary is incorporation into
  server history; a rejected pending local commit can be replaced during
  reconciliation.
- Automatic sync may wait for a brief pause in editing. There is no requirement
  that network publication progress during uninterrupted typing. Local saves
  must continue to complete while offline.

## What ran

Two pages of the same origin shared a fresh scratch IndexedDB database in each
browser. The fixture had 5,000 Markdown rows in one flat table. Each tab saved
its own frontmatter field and body line. A sync task on the first tab repeatedly
prepared 50 incoming rows, changed a third field and body line, merged pending
edits, constructed Git blobs/trees/commits, and attempted atomic publication.

Objects were hashed with the Git object header and held inflated by oid.
The fixture read its commit and two directory trees inside each snapshot read.
The content merge was the existing `packages/folder/src/merge-file.ts` with
its field and independent text-region behavior. Its older deletion and JSON
policies were not exercised. The large-file case put about 100 KB of text in
one row, edited by both tabs.

A readonly transaction captured refs, relevant bytes, pending edits, and the
revision. Merging and hashing ran outside transactions. A readwrite transaction
compared the revision, published objects/refs/edit cleanup, and incremented it.
A simulated push acknowledgement checked the ref pair and preserved newer
edits without requiring the old revision. The transaction behavior is grounded
in the [IndexedDB transaction scheduling rules](https://www.w3.org/TR/IndexedDB/#transaction-scheduling).

Fetch preparation and an 80 ms simulated network wait occurred before the
revision snapshot. The simulated push waited 30 ms. Sync ran much more often
than the intended production schedule. There was no real Git network transfer,
pack decoding, server ancestry recovery, object collection, or storage eviction.

Each case ran once per engine for 3 to 6 seconds. Browser code and the merge
module were warmed before measurement. Timings come from a shared macOS desktop,
not controlled hardware. Engines: Chromium 153.0.8010.12, WebKit 27.2, Firefox
151.0, driven by Playwright 1.64.1 using the installed browser executables.

## Results

Each cell below is **save latency p95 in ms / rejected sync revision checks**.
A rejected check leaves persisted data unchanged and causes recomputation.

| Workload per tab | Chromium | WebKit | Firefox |
| --- | ---: | ---: | ---: |
| 100 ms pause after each save, no concurrent sync | 21.7 / 0 | 19 / 0 | 13 / 0 |
| 1,000 ms pause after each save, with sync | 29.7 / 2 | 36 / 1 | 31 / 1 |
| 100 ms pause after each save, with sync | 20.4 / 3 | 20 / 7 | 36 / 15 |
| 20 ms pause after each save, with sync | 25.9 / 16 | 26 / 46 | 20 / 21 |
| 100 ms pause, both tabs editing one large file | 20.5 / 0 | 20 / 7 | 38 / 19 |
| 20 ms pause, injected extra 250 ms adoption window | 14.5 / 9 | 21 / 9 | 17 / 8 |

The pause starts after a save completes; it is not an achieved save rate. In
the 20 ms natural workload each engine acknowledged 258 to 283 saves combined
over about five seconds, approximately 26 to 28 per second per tab.

Across the natural concurrent-sync cases, snapshot-to-revision-check p95 for
adoption was 14.6 to 40 ms. No individual save needed more than two failed
checks before completing in the main matrix. Even the high-rate cases made
20 to 25 successful adoptions before the final acknowledged save.

In the injected 250 ms case, no adoption succeeded before the final save in
any engine. The first success arrived 339 to 521 ms after that save. All
remaining pending edits were subsequently committed and acknowledged. This
demonstrates the expected starvation boundary and post-pause recovery; it does
not establish a production latency promise.

The main matrix acknowledged 1,957 saves. Three additional large-file runs
acknowledged 259 saves, then closed both database connections, reloaded both
pages, reopened the database, and verified the same final data. All passed.
This is ordinary reopening, not a process kill or power-loss test.

Three additional two-tab runs disabled browser networking after loading the
pages. They acknowledged 144 offline saves, then restored networking, drained
pending edits through the simulated sync, reloaded, and passed verification.

Final verification checked each actor's latest acknowledged field and body
change on every touched path, every incoming server field/body change, an
empty pending-edit set, and matching confirmed/current refs. It did not require
retention of earlier values of the same field or body region.

Raw results: [browser measurements](results.json) and
[service-side commit probe](endpoint-result.json).

## The service-side commit comparison

A separate local-only Bun HTTP endpoint constructed commits in a native bare
Git repository. It used an exact request identity to construct a deterministic
pending commit, ordinary Git ancestry to recognize acceptance, the existing
field/region merge, and a conditional ref update.

The probe demonstrated:

- The HTTP client aborted after the server published its commit and before
  receiving the delayed reply. A native desktop commit then changed its field.
  Retrying the exact request recognized acceptance and preserved that change.
- Giving the stale payload a new request identity replayed it over the desktop
  change. This negative control shows that an exact persisted outbox is still
  necessary when the server creates commits.
- Two overlapping requests changing independent content both survived. One ref
  compare-and-swap failed and retried. Native `git fsck --full` passed.

This establishes a local mechanism, not the feasibility or cost of hosting it.
The current `apps/api/worker/git-repositories.ts` authorizes and forwards Git
HTTP requests to Artifacts; it does not construct commits or merge repositories.
The probe used native Git, which is not the hosted Worker implementation.
Authentication, arbitrary files, request versioning/streaming, atomic browser
adoption, and Artifacts support remain unbuilt.

Supporting only Epicenter's service makes this alternative possible to
reconsider. It does not remove the browser's durable local edits, exact pending
request, or atomic adoption. No comparison here establishes that the custom
protocol beats keeping Git transport in the browser.

## Decision and remaining evidence

Keep simple reads and one repository revision. Prepare fetched data before
capturing that revision. When continuous edits invalidate sync, preserve work
and schedule another attempt after editing settles. Do not add per-file bases,
per-file revisions, a durable retry queue, or cross-tab network ownership to
avoid every retry.

The actual engine must reproduce content preservation and post-pause progress,
including a real iPhone. It still needs crash/abort, suspended-page, uncertain
push, namespace collision, shared-object collection, and live-service protocol
evidence. A whole-repository offline model also still needs initial-download
and quota measurements at expected app sizes.

The runnable prototype was removed after recording these results. Its source
is retained at commit `6058e010a9`:

- `6058e010a9:packages/folder/evidence/revision-prototype/page.ts`
- `6058e010a9:packages/folder/evidence/revision-prototype/run.ts`
- `6058e010a9:packages/folder/evidence/revision-prototype/server-endpoint.ts`

At that commit, Bun runs the browser driver or service probe directly. The
driver uses the locally installed Playwright package and browser executables
listed above; those local paths require adjustment on another machine.
The captured driver includes the later offline/reload checks. The initial
matrix preceded those driver checks; the revision and merge algorithm was
unchanged between runs.
These measurements do not make the replacement engine implemented.
