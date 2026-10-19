# Browser repository engine

**Date**: 2026-10-19
**Status**: In Progress
**Owner**: Codex

## One sentence

Replace browser folder storage with a Git-backed IndexedDB repository that
preserves offline saves and merges independent edits across tabs and devices.

## Current and target

`packages/folder/src/git/browser-backend.ts` still uses OPFS, a Git index,
publishing refs, and Web Locks. The first local engine exists in
`packages/data/`; its browser checks exercise production storage, merge and
commit preparation. Network exchange and migration remain unbuilt.

Build `@epicenter/data` under `packages/data/` against ADR-0626 and ADR-0628.
Keep existing applications on their current backend until the replacement and
migration preserve their saved and unsent data. The public app API does not
expose commits, sync scheduling, history, or an alternate legacy mode.

The browser stores inflated Git objects, confirmed and pending refs, newer
pending edits, Git shallow-boundary metadata, first-fetch knowledge, and one
publication revision.
Saves merge from their actual starting source and acknowledge local transaction
completion. Sync can wait for a pause; retained server history is the recovery
boundary. No per-file bases, network ownership lease, or custom server protocol.

## Implementation milestones

1. **Local repository foundation.** Native-compatible object codec,
   field and region merging, IndexedDB capture and atomic publication, offline
   file and row operations, and exact pending commit preparation exist. The
   [local evidence](../packages/data/evidence/local/RESULTS.md) covers two pages,
   reopening, native objects, and the distinction between an unknown and empty
   remote. This is an internal engine, not the public app opening API.
2. **Git sync after scoped capture.** Point, prefix, immediate-row and commit
   scopes now capture only C and the trees needed by the operation or E.
   The 500-folder probe captures 3 trees for one path, down from 502; raw
   directory occupancy and E prefix tombstones remain protected. All E values
   and their ancestor trees are still read. A 500-edit, 2 MB backlog captures
   502 trees in 19 to 38 ms on desktop; measure this on phones before adding
   another storage mechanism. Next exchange normal Git with
   a local native server. Preserve exact
   uncertain commits; recover connecting ancestry through all parents and name
   sync's competing units in `Overrode:` trailers. Prove
   lost replies, later native edits, saves during sync, and resumed stale work.
3. **Retention.** Isolate candidate/fetch objects and collect only unreachable
   snapshot objects with publication checks. Prove shared blobs, interrupted
   work, and concurrent publications survive collection.
4. **Todos.** Integrate `open`, typed/raw rows, `from`/`sent`, raw file repair,
   subscription and status, and automatic scheduled sync through account auth.
   Exercise edit, offline save, reopening, reconnect, and native Git round-trip.
5. **Migration and deletion.** Transfer committed and unsent legacy work, verify
   readback, then remove the replaced OPFS/index/publication/locking machinery
   and migrate remaining consumers. Retire this spec after implementation;
   record completed work in `docs/spec-history.md`.

## Acceptance and review

The local repository slice passes focused tests and real Chromium, WebKit and
Firefox checks. In-memory IndexedDB tests establish transaction behavior in the
test implementation, not phone durability. Scoped capture passes 89 tests and
the repeated browser workload; the next slice proves ordinary Git exchange
against a local native server.

Claude Sonnet 5.5 delivered the object codec in an isolated clone. Codex reviewed
and integrated it and reran its native Git checks. Independent Codex agents
implemented the merge, raw tree helpers, and row codec. Codex owns IndexedDB
publication, integration, and final verification.

The local checkpoint used independent GPT-6.1 Sol and Claude Opus 5.5 reviews,
both with source and tests. Both retained B/C/E and revision publication. Repairs
cover EOF frontmatter framing, exact byte bases, truthful gitlink deletion,
raw directory occupancy, first-fetch knowledge, and an exact pending ref pair.
The owner chose safe refusal of local file-directory replacements. A focused
follow-up found no new blocker in prefix tombstones and opaque occupancy.
These were informed implementation reviews, not blind design proposals.

Keep the three operation-specific retry loops; each owns a distinct transition.
A generic planner protocol does not yet remove enough work to justify its new
types and callbacks. Scoped capture adds no persistent index or cache. A focused
Claude Opus 5.5 read-only pass found no missed-input or occupancy counterexample;
Codex reproduced the covered behaviors and browser checks. Directory collision
diagnostics may name a different existing case twin when native Git already
contains several; refusal remains the same. An operation no longer checks
unrelated subtrees for corruption. Capture is not an integrity audit.
ADR-0629 through
ADR-0631 record these local API and bootstrap clarifications as proposals.

Hosted Git must separately establish conditional ref updates, initial shallow
fetches, and recovery negotiation in an isolated test repository. Do not run
production operations. Real iPhone persistence, quota, termination and reopening
remain release gates; desktop results cannot satisfy them.

## Active evidence

- Accepted decisions: ADR-0613, ADR-0622, ADR-0623 as amended by ADR-0628,
  ADR-0624, and ADR-0626.
- `packages/folder/evidence/revision/RESULTS.md`: bounded contention results and
  the source commit of the removed throwaway prototype.
- `packages/data/evidence/local/RESULTS.md`: current production-source local
  browser evidence and its limits.
- `packages/folder/src/merge-file.ts`: existing pure merge evidence, with older
  deletion and JSON behavior that must not be copied as the target policy.

The new package must not depend on the old folder backend. Small pure codecs
may temporarily coexist during migration; remove their replaced copies when
their remaining legacy consumers move. Do not make a new abstraction solely
to keep both engines permanently supported.
