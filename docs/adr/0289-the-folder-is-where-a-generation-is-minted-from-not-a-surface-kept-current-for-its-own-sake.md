# 0289. The folder is where a generation is minted from, not a surface kept current for its own sake

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amends:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) at why the render runs continuously, not at what it renders. The layout, the one direction, the manifest, the leave-it-alone rule for a failed row, and the do-not-rewrite-matching-bytes rule are all unchanged and still govern. What is withdrawn is the premise it revived from ADR-0207: that an always-current folder is the product, such that a stale folder is a defect. It is a mint source, so its freshness is a convenience.
- **Amends:** [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) at one supporting reason, not at its decision. It refuses a pre-restore backup feature because "the mirror is already on disk and already current," which this record makes untrue: the folder may be stale, and an application that does not attach the mirror has none. The refusal still stands, on the ground ADR-0281 already gave it, which is stronger: a restore discards nothing because the generation it replaces is retained. The backup is the previous generation, not the folder.
- **Relates:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (the file shape), ADR-0286 (what consumes it), ADR-0290.
- **Amended by:** ADR-0337. This record made the folder a mint source whose freshness is a convenience; that record makes it a working copy a person fills and sends back, and takes the deletion of `mirror.ts` that this one left available.

## Context

ADR-0271 gave the mirror the `onCommitted` seam the SQL projection vacated and justified the continuous render with ADR-0207's premise: `ls ~/Epicenter` is the database, so point an agent at it. On that reading a stale folder is a defect, and the render's cost is a scaling problem to solve.

The folder has since acquired a second consumer that ADR-0271 mentions in one line and does not design around: ADR-0286 mints every generation from an artifact, and a folder is one place an artifact comes from. That consumer wants something different. It does not read the folder continuously; it reads it once, deliberately, and its correctness gates a generation.

The two roles want opposite things. A product wants legibility and currency. A mint source wants fidelity at the one instant it is read, and does not care what the folder said an hour ago.

## Decision

**The folder is a mint source and a legible copy a person owns. It is not a surface whose currency is a correctness property.**

- **A stale folder is not a defect.** The render still runs on the `onCommitted` seam, still debounces, and still states a whole pass. But `mirror.ts` exists to make the folder convenient rather than to make it true, so its schedule, its cost, and whether an application attaches it at all are convenience questions. `attachMirror` is already opt-in at the application layer, imports nothing private, and ships behind its own subpath; an application that does not call it has a working store and no folder.
- **`renderArtifact` is the load-bearing half, not `mirror.ts`.** The pure state-to-files function is what a mint consumes and what a person's copy is made of. Keeping it current is the optional part.
- **Currency at mint time is the mint's problem, not the mirror's.** A mint that reads the folder is responsible for the folder being current, and gets there by rendering rather than by asking the mirror for a guarantee it was never designed to make. This is the concrete reason the roles had to be separated: ADR-0271's manifest rule deliberately leaves a stale file in place when a row fails to render, which is right for a mirror and wrong for a mint source. (ADR-0290's precondition is a different check with a similar shape: it asks whether this *device* holds every body, not whether the *folder* is current. A compaction mint never touches the folder at all.)
- **Consequently, three things stop being scaling problems.** The whole-render cost (~71 ms per thousand rows per pass), opaque row-id filenames, and the folder's on-disk footprint are all costs of convenience. None of them bounds what Epicenter supports.

## Consequences

- ADR-0271's `cp -r` backup story survives, but it is a backup of a folder that is current as of the last render rather than a continuously true replica. Say that, rather than implying a live mirror.
- **Epicenter has no always-current agent-facing surface**, and this record is where that is chosen rather than discovered. ADR-0207 called that surface the whole product; ADR-0226 and ADR-0227 deleted the machinery for it; this declines to restore its premise. An agent gets a folder that is fresh in practice and guaranteed only when someone asks for it.
- The two Markdown-serialising ProseMirror schemas in `apps/honeycrisp/src/lib/editor/` become a **restore** hazard rather than a vault hazard. Lower frequency, higher consequence: drift no longer means a folder that reads slightly wrong, it means a generation minted from bodies the editor never produced. Deduplicating them is now the cheapest correctness fix on the branch.
- Deleting `mirror.ts` becomes a decision that is available and is not taken here. Nothing depends on the schedule for correctness after this record, so the question is only whether the convenience earns 328 lines.

## Considered alternatives

- **Keep the product framing and optimise the render.** The incremental render needs the store to name the changed row unconditionally on both the local and remote arms, which is real work in service of a property nobody consumes. It was worth doing when the folder was the product.
- **Delete the mirror and make the folder purely on-demand.** Tempting and premature. It forecloses the agent story entirely rather than declining to guarantee it, and `renderArtifact` already gives an on-demand path without removing anything.
