# 0282. The authority hydrates the document, and one object per document bounds the blast radius

- **Status:** Accepted
- **Date:** 2026-08-28
- **Amended by:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) at one-object-per-document. The hydration decision stands; the granularity is now one object per generation.
- **Amends:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md) at three stated reasons, not at its decision. The authority still reads, the granularity is still one Durable Object per document, and the transport is still three messages. Withdrawn: "an update that will not apply is refused at the door"; "the memory ceiling... is 128 MB per isolate, shared" as the mechanism; and "the ceiling is worth more than the request count" as the argument against per-generation.
- **Unbuilt:** all of it.

## Context

ADR-0277 justified one Durable Object per document with a hydration cost: 128 MB per isolate, a hydrated document at roughly four times its bytes, therefore keep the largest hydration to one document. It also promised that a reading authority refuses a bad update at the door, in trade for the byte-blind design it replaced.

Yjs has exported a documented path for answering sync without a document since 13.5, under a README heading that says so: `encodeStateVectorFromUpdateV2`, `diffUpdateV2`, `mergeUpdatesV2`. If that path were cheap, ADR-0277's headline reason for its granularity would be doing no work, and the decision would be resting on less than the record claims. It is not cheap, and the reason is already in this tree.

## Decision

**The authority hydrates the document. One Durable Object per document, because an out-of-memory confines itself to the document that caused it.**

Three measurements settle it. All are re-runnable: `bun run evidence/bench/validate.ts`.

- **The bytes path costs more than the hydration it avoids.** On a 27.7 MB corpus, `diffUpdateV2` costs 79.5 ms and 284.0 MB rss; `applyUpdateV2` into a document costs 67.9 ms and 106.8 MB. `diffUpdateV2` decodes every struct and re-encodes a full copy before discarding it, so it allocates roughly 2.7 times what building the whole document allocates, transiently and per request rather than once and resident. That bench's own closing paragraph already said this: "That it costs MORE than building the document it was chosen to avoid building is the measurement that removed it."
- **Merging bytes never collects garbage.** `mergeUpdatesV2` deduplicates; it does not GC. Deleted content stays in a byte-fold as full content structs, where a hydrated `Y.Doc({ gc: true })` replaces it with an id range and no payload. Fifty insert-then-delete cycles of 2,000 characters fold to 100,080 bytes through bytes and 71 bytes through a document. The ratio is total edit history over live content, which is exactly a prose editor's workload, and it lands on stored size and on every fresh device's backfill.
- **Upstream is moving away from it.** `diffUpdateV2` carries `@deprecated` and `@todo remove this in favor of intersectupdate` in the installed `@y/y` 14.0.0-rc.24. Every comparable server hydrates: y-websocket, y-partykit, y-sweet, and hocuspocus all hold a document per room and use the byte functions only in persistence.

**Validation is a parse, and the alarm is the mechanism.** A well-formed update whose dependency is missing is accepted silently by `applyUpdateV2` and buffered into `pendingStructs`; only malformed bytes throw, and they throw in the bytes path too. `hasUnresolvedDependencies()` is the honest surface, and its own JSDoc already calls itself an alarm rather than a state. ADR-0277's door metaphor overstates what a reading authority buys, and this record withdraws it rather than letting it justify anything further.

**The granularity's reason is blast radius.** Co-located objects share machines and idle ones evict, so per-document does not buy a private 128 MB. What it buys is that the largest hydration any object ever performs is one document, so a document too large to hold kills only itself instead of the object carrying every socket for the whole store. Against per-generation, the honest residual trade is the sweep fan-out and ledger discipline that per-document costs (ADR-0283), set against a 10 GB whole-store storage cap, single-threaded contention with live editing, and a whole-store failure domain. It lands per-document.

**The transport is implemented, not imported.** `y-protocols/sync` is v1: `writeSyncStep2` calls `encodeStateAsUpdate` and `readSyncStep2` calls `applyUpdate`. This tree is `updateV2` everywhere, including in ADR-0277's own line about v2 being the compatibility surface to watch, and no v2 variant exists upstream. `y-protocols` is not a dependency of this repo and must not become one: the three messages are written over `lib0/encoding`, which is what ADR-0277's "131 lines" was pointing at. State vectors are format-independent, so only the two payloads differ.

## Consequences

- ADR-0277's decision is unchanged and better supported. What changes is that its reasons now cite a measurement in this repository rather than an estimate, and the record stops claiming a validation guarantee it does not provide.
- The fold stays a hydrating operation, so an authority that never woke a document still must wake one to fold it. That is not a cost to remove; it is where garbage collection happens.
- The 128 MB figure's ambiguity in Cloudflare's documentation, between per-isolate-with-co-location and per-object allocation, does not need resolving. Both readings land per-document: a private budget makes it stronger, a shared one makes confinement the point.
- Wire chunking is probably deletable and should be measured before it is ported. `frames.ts` chunks at `DO_SQLITE_VALUE_CAP`, which is the 2 MB *storage* value cap; the WebSocket limit is 32 MiB. Storage chunking survives and moves into the authority when `frames.ts` is deleted.
<!-- doc-path-check: ignore-next-line -->
- A live defect, independent of this record and worth fixing on its own: `packages/server/src/store-sync/authority.ts` handles `webSocketClose` without calling `ws.close()`. At this compatibility date the auto-reply flag is off, so peers observe a 1006 abnormal closure instead of a clean handshake.

## Considered alternatives

- **A byte-only authority.** Measured and rejected, twice: once when it shipped and was removed, and again here. It is correct for sync and incomplete as an architecture, because it never collects garbage.
- **One Durable Object per generation.** Removes the sweep fan-out and makes deletion one `deleteAll`. Refused for the 10 GB per-object cap over a whole store, single-threaded contention between backfill and live editing, and a failure domain that includes every document a person has.
