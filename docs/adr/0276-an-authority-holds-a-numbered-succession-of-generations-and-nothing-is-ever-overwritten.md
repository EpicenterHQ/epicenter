# 0276. An authority holds a numbered succession of generations, and nothing is ever overwritten

- **Status:** Accepted
- **Date:** 2026-08-28
- **Amended by:** [ADR-0417](0417-a-data-address-holds-one-document.md) withdraws numbered succession and remote replacement for current data; historical numbered storage remains untouched.
- **Supersedes:** [ADR-0274](0274-a-workspaces-history-is-a-generation-and-restore-creates-one-rather-than-overwriting.md). That record proposed retention inside one authority and left five questions open. The shape below answers them by moving the generation into the address, which 0274 considered and leaned against.
- **Amends:** [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) at the Durable Object name; [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) at the bootstrap connection and the identity announcement, both of which leave the socket; [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) at the authority operation, which stops being destructive and therefore stops being deferred; [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) at the deferred whole-document rebuild, which this record makes available.
- **Relates:** [ADR-0241](0241-a-store-is-truth-plus-debts-and-sql-is-a-composed-follower.md) (which reserved a destructive whole-document operation that is now never needed), [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md) and [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (the artifact a restore reads), [ADR-0270](0270-an-application-has-two-workspaces-and-moving-a-row-between-them-is-the-primitive.md) (the vocabulary the routes had wrong), [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md) (blobs stay per principal and outside generations, and now live beside the generation databases under the same app and principal prefix).
- **Amended by:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md) at what a generation holds: a set of Yjs documents rather than a log and a snapshot. The numbering, the two verbs, the retention rule and the routes are unchanged, and one Durable Object per generation is now load-bearing rather than merely chosen.
- **Unbuilt:** all of it. `readArtifact` and the client's discard-on-supersession exist; the generation address, the two authority verbs, the HTTP surface, and the actions that call them do not.
- **Amended by:** [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) at what a generation does to a device: `current`, `setCurrent`, `PUT /current`, `supersededBy` as a client signal, and "discards and refills" are all withdrawn. Numbering, retention, and person-only deletion are unchanged.
- **Amended by:** [ADR-0283](0283-a-generations-collection-is-a-ledger-that-allocates-admits-and-sweeps.md) at the route table. The small object holding the list stays and becomes the ledger that allocates, admits, and sweeps.
- **Amended by:** [ADR-0286](0286-every-generation-is-minted-from-an-artifact-and-compaction-is-an-export-then-an-import.md) by withdrawing the Restore/Rebuild split and the lease Rebuild required: a mint is always additive, so there is nothing to compare and swap.
- **Amended by:** [ADR-0287](0287-the-authority-does-not-delete-a-generation-and-erasure-is-an-account-operation.md) at the route table, which loses `DELETE`. "Nothing is ever deleted except by a person" becomes true of the authority without exception, and erasure moves to the account.
- **Amended by:** [ADR-0379](0379-reconstruction-is-an-explicit-destructive-library-operation.md) at product availability: storage maintenance preserves live document lineage, and no restore-over-live product is selected; existing generation and retirement mechanisms remain implementation inventory until audited.

## Context

ADR-0272 specified restore as an authority that installs an envelope and renames what it holds, then deferred the half that runs over a live workspace because that half needed the authority's first destructive whole-document operation. ADR-0274 proposed keeping the previous state instead of destroying it, and stalled on five questions, the first of which was whether a generation is its own Durable Object.

Three separate refusals turned out to have one cause. `authority.ts` refuses root-document compaction because "a root-document rewrite must prove the replacement covers what it replaces, and that proof needs semantics the authority was defined not to have." ADR-0256 deferred Compact workspace for the same reason. ADR-0241 reserved the destructive operation rather than exposing it. All three are consequences of overwriting, not of compaction, and none of them survives a design where the previous state is still there.

## Decision

**An authority is not one object holding a current document. It is a succession of generations, each its own Durable Object, and a small object holding which one is current.**

```txt
  principals/prn_9f2c/data/so.epicenter.honeycrisp              current = 3, and the list
  principals/prn_9f2c/data/so.epicenter.honeycrisp/generations/1   retained, supersededBy = 2
  principals/prn_9f2c/data/so.epicenter.honeycrisp/generations/2   retained, supersededBy = 3
  principals/prn_9f2c/data/so.epicenter.honeycrisp/generations/3   current
```

**A generation is a number, allocated by increment.** It is public, ordered, and speakable, because a person browses generations and names one. A generation object stores no identity of its own: it *is* that document and knows its own name from `ctx.id.name`, which Cloudflare populates for ids built with `idFromName`. Ids must therefore never be routed through `idFromString`, which drops the name.

**The object's name is the principal prefixed onto the request path.** There is nothing to keep in sync between the URL and the address, because they are the same string.

| | route | |
| --- | --- | --- |
| WS | `/v1/data/<id>/generations/3?cursor=812` | sync, and the only thing on a socket |
| GET | `/v1/data/<id>/current` | what a replica with no state asks once |
| GET | `/v1/data/<id>/generations` | browse: number, created-at, size, reason |
| POST | `/v1/data/<id>/generations` | create from an envelope the client built |
| PUT | `/v1/data/<id>/current` | promote an existing generation |
| DELETE | `/v1/data/<id>/generations/1` | the only destructive verb in the system |

**The authority gains two verbs, and neither destroys anything.** `create(envelope) -> G` writes into an object nothing has used. `setCurrent(G)` writes one number, and writes `supersededBy` into the generation it demotes. Three product actions compose from those two:

| action | bytes come from | lease on (generation, head) |
| --- | --- | --- |
| **Restore** | an artifact folder, parsed by `readArtifact` | refused |
| **Rebuild workspace** | this client's own live `Y.Doc`, copied into a fresh one | required |
| first sync | nothing; an empty generation 1 | n/a |

The lease is the only difference, and the reason is one sentence: Rebuild claims to be the current state, so it must still be current when it lands; Restore decides what the current state will be, and a lease would make it fail because someone on another device typed a word.

**A device learns which generation is current, and never sees the list.** It dials its own generation directly, so a current replica pays nothing. A replica on an old generation is told by that generation's own `supersededBy` and discards and refills exactly as `client.ts` already implements. Browsing and promoting are a person's operations over plain HTTP against the small object, and they are not part of the sync protocol.

**Nothing is ever deleted except by a person.** Every generation is retained until someone presses delete on it. There is no retention policy, no keep-N, and no expiry. `SNAPSHOTS_KEPT = 2` is not the model to copy: a fallback snapshot exists to survive a replica that produced a bad one, while a generation is a state a person chose, and choosing when to stop being able to return to it is theirs.

**The zip never reaches the authority.** The authority has no Yjs, no codec, and never decodes a byte. A client parses the folder and posts an envelope.

## Consequences

- **Restore stops being two features.** ADR-0272 split it because restore-over-live needed an expensive destructive verb. It needs `setCurrent`. The confirmation dialog is still work; the mechanism is not.
- **The destructive whole-document operation is never built.** ADR-0241's reservation never comes due, and `authority.ts` keeps its refusal intact, because a generation asserts only that a person pointed at it, never that its bytes cover anyone else's.
- **Whole-document rebuild becomes available, and satisfies four of the five things ADR-0256 required of it:** an explicit application-owned action, a visible loss boundary, a stable logical address (`/current` never moves), and an atomic compare-and-swap. It deliberately fails the fifth, a *private* replacement identity, because a person has to be able to name a generation. ADR-0256 licenses this: the future design "may choose a different authority protocol; the deleted replacement route is not a reserved seam."
- **The action is named Rebuild workspace, not Compact.** Because it retains its predecessor, it frees nothing on the server until someone deletes that predecessor. Rebuild describes what it does; Compact would be a button that lies. ADR-0231's name returns for the action it always described.
- **Generations bound Yjs growth; they do not replace snapshot folding.** A generation's own log still grows and still folds. What a rebuild removes is tombstones, struct history, and deleted rows, which folding preserves on purpose.
- **The bootstrap connection is deleted.** `Admission` loses `'bootstrap'`, and the hub loses the branch where a socket carries one frame and no membership. ADR-0231's "a bootstrap connection carries the announcement and nothing else" becomes a `GET`, and the required check that went with it becomes a route test.
- **The identity announcement is deleted.** A replica dialed an address, so nothing has to be announced and compared. `superseded` stops being an inference the client draws and becomes a fact the generation states.
- **Storage grows with restores, visibly.** Twelve restores are twelve generations and twelve generations of bytes. The browse list shows size per generation because that is the only thing that makes the cost actionable.
- **The addressing noun is `data`, and the tree must follow.** `defineData` produces a `DataDefinition` whose `id` is this segment. `mount.ts` currently calls the same value four things in nine lines: `parseDataId` checks `WORKSPACE_ID`, on a query parameter named `databaseId`, erroring "must be a workspace id". `databaseId` (116 sites) becomes `dataId` and `WORKSPACE_ID` becomes `DATA_ID`. `database` is a fossil of the SQL projection ADR-0269 deleted; `workspace` is wrong under ADR-0270, where an application *has* two workspaces and this id names the thing that has them.
- **Blobs are unaffected.** R2 keys are `principals/<id>/blobs/<blobId>`, per principal rather than per generation, so an older generation finds its blobs present and pruning one collects nothing. `packages/data` references no blob today at all.

## Considered alternatives

- **Overwrite and rotate, as ADR-0272 describes.** Refused: it is the sole cause of the proof obligation that killed four authority designs, and it makes retention a copy-before-destroy step whose failure mode is losing the thing it was copying.
- **One object with generation-scoped storage,** ADR-0274's likely shape. Refused: a `WHERE generation = ?` on every read forever, pruning as a careful delete inside a live object, and no isolation. Per-generation objects were rejected in 0274 because their pointer looked like a registry with no reader. The browse surface is that reader.
- **An opaque generation name, or a number with a random suffix.** Refused. It survives one scenario, a Durable Object losing its storage and being re-created at a name a stale replica still holds, and losing an authority's storage is catastrophic on its own terms. Paying for it in every URL a person reads is the wrong trade.
- **Devices see the list of generations and pick one.** Refused for now. It would add a frame, durable client state, a picker, and a rule for who may re-point, to buy rollback from a device that does not hold the folder. Browsing over HTTP gets most of it without touching the sync protocol.
- **Rebuild deletes the generation it rebuilt from.** Refused. "The system never deletes, the person does" is worth more as a rule without exceptions than the immediate space it would reclaim, and the exception would be the one place a person loses state they did not ask to lose.
- **A global registry of document identities.** Still refused, and unchanged from ADR-0274. Identities are never resolved; the small per-application object holds a pointer and a list, not a cross-application index.
