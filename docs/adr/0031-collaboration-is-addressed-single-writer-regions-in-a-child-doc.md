# 0031. Collaboration is addressed single-writer regions in a child doc

- **Status:** Accepted
- **Date:** 2026-06-18
- **Supersedes:** [ADR-0025](0025-agent-conversations-are-durable-child-docs-driven-by-an-observing-worker.md)

> **Vocabulary:** a **participant** is anyone who can write to a doc: a person
> through a UI, or a program through a worker (ADR-0024). An **entry** is a root
> contribution a participant mints. A **reply** is a contribution a participant
> derives, addressed by `(responder, entry)`. A **region** is a single-writer
> territory inside the doc. This ADR generalizes ADR-0025's one-human-one-agent
> conversation to N participants and replaces its message-array-and-claim
> mechanism with addressing.

## Context

ADR-0025 made an agent conversation a child doc keyed by a row, with a single
`messages` array both sides append to, an assistant turn keyed to a client-minted
`generationId`, and a "claim by existence" guard. The same shape recurs for
transcription, polish, extraction, and approval, so it wants to be one named
pattern. But three things in the 0025 mechanism were carrying contention
semantics over a system that has no contention: the word "claim", the separate
`generationId`, and a single array with two writers (single-writer by convention,
not by structure). The answerer is already ordained by the binding, so nothing is
ever claimed. Naming the general shape is the chance to delete the words that lie.

## Decision

When participants co-produce a durable artifact, the artifact is a per-row child
doc made of **addressed single-writer regions**. There are exactly two
operations:

```txt
mint an entry:   entries.push({ id, by, body })        a new thing I say; I own it
write a reply:   replies.get(me).set(entryId, { body }) addressed by (me, entryId)
```

```txt
entries:  Y.Array<{ id, by, body, cancel?, supersedes? }>
            ordered roots. The author owns each entry.

replies:  Y.Map<ParticipantId, Y.Map<entryId, { body, outcome? }>>
            each participant owns exactly replies.get(self).
            inner key = the entry being answered.
```

- **A reply's address is a pure function of `(responder, entry)`**, the same
  identity-addressing the child-doc guid already uses one level up
  (`hash(workspace, table, row, field)`). Writing to your own address is
  idempotent by construction: `replies.get(me).has(entryId)` is the existence
  check, an O(1) lookup, not a scan. There is no claim, no lock, and no
  `generationId`. Two agents answering one entry write `(A, entry)` and
  `(B, entry)`: different addresses, so contention is structurally impossible at
  any N.
- **Single-writer is structural, not by convention.** Humans own `entries`; each
  participant owns its own `replies.get(self)` container. No shared array
  partitioned by a role field.
- **`body` is any Yjs shape**, chosen by the payload: `Y.Text` for streamed prose,
  `Y.Array` for a sequence (transcript segments, tool-call log), `Y.Map` for a
  keyed object (extraction, an approval decision), `Y.XmlFragment` for rich text.
  The shape is payload; the addressing is protocol.
- **Binding is a participant set on the row**, generalizing ADR-0025's single
  immutable `agent`. One bound agent is the common case (a conversation). Adding a
  participant exposes existing content to it, so adding is a confirmable act when
  it crosses a trust boundary; removing is a fork. Attribution falls out of region
  ownership (`by` and the address), so no per-message author field and no agent
  identity in the portable body. These were ADR-0025's load-bearing privacy and
  attribution properties; they survive at N.
- **Entry ids are random** (a nanoid, not a sequential counter). `Y.Array` never
  dedupes by an app-level `id`: two devices that mint the same id leave two
  distinct elements both claiming it, and the address `(responder, entry)` then
  collides. A random id makes that astronomically unlikely; the alternative is to
  address by the entry's Yjs identity (`clientID:clock`) read back after insert.
- **Retry is a new entry** carrying `supersedes: oldEntryId`, not a re-mint, and
  `supersedes` is single-hop (always points at an original, never another
  superseder) so the live head is one pass, not a graph walk. The UI may collapse
  a superseded entry. Cancel is a field on the owner's own entry, read by whoever
  is replying.
- **Answerable regions carry a required liveness triple**, not optional
  decoration: a start marker, a progress timestamp, and the write-once `outcome`.
  They are what tells a reader "still streaming" from "the worker died". Addressing
  removes *contention* (who answers); it does not remove *liveness* (is the one
  answerer alive). Cross-process exclusivity is the **designation** layer's job
  (one daemon per agent), not addressing's.
- **Roles are not stored.** A participant's nature (person or program) lives in
  the participant set, not on every contribution. `role: user | assistant` is
  deleted.

The doctrine is one sentence: *a child doc is ordered entries that participants
mint, plus replies addressed by `(responder, entry)`; each region has one writer;
bodies are any Yjs shape; a reply may stay a region or graduate to its own row by
weight.*

### End-to-end lifecycle (chat)

```txt
1. Alice opens a conversation: a conversations row, set {alice, home-agent},
   with a child doc.
2. Alice mints c1: entries.push({ id: c1, by: alice, body: Y.Text("...") }).
3. home-agent (a spoke on Alice's always-on anchor) observes the doc. onChange:
   c1 has no reply at replies.get(home-agent).get(c1). It reads ALL entries and
   replies in order, flattens them to the model prompt, prepends its own system
   prompt (which lives on the agent, never in the doc), writes an empty body at
   (home-agent, c1), streams tokens into it, then writes outcome: completed.
4. Alice's UI observes the doc, looks up (home-agent, c1), renders it after c1,
   streaming. Order is structural: a reply renders after its entry.
5. Alice mints c2; the agent answers (home-agent, c2). Context is the whole doc,
   re-read each turn. Nothing is re-sent over a wire: the agent reads its own
   synced replica.
6. Cancel: Alice stamps cancel on her own c1; the agent stops and writes
   outcome: cancelled. Retry: Alice mints c3 { supersedes: c1 }.
```

## Consequences

- This is the **multi-turn request/response** band. Chat and multi-round review
  are its instances. One-shot work (a single transcription, an extraction) is the
  *simpler* primitive below it (a row plus one output region, no `entries` array),
  and agent pipelines or scheduled originators (an agent that writes with no entry
  to answer) are the *contribution-graph successor* above it (see alternatives).
  This ADR does not claim those bands; it claims the request/response middle.
  Deleting `generationId`, the re-mint function, the existence-scan, and the `role`
  field removes a whole family of chat-specific code.
- The prompt context is a read, not free: walk `entries` in order and, for each,
  look up its `replies` across participants, then map to messages and prepend the
  agent-owned system prompt. Moving replies out of the ordered array into keyed
  maps is what made single-writer structural, and the cost is that **transcript
  order is now a join, not an iteration**. It is O(n); rebuild it only on
  entry/reply boundary events (from the `YEvent`), never on every streamed token,
  or a long thread re-reads itself once per flush.
- In-progress liveness does not vanish. "Is this empty reply still streaming or did
  the worker die?" shrinks to one address lookup plus optional presence, with a
  stale-time fallback. This is the one residue that is not pure addressing.
- Presence is optional decoration. The durable participant set answers "who is
  bound"; presence answers "who is awake right now" and is not required for
  correctness (the doc is the mailbox). Do not put `agentId` on the presence wire
  until a live-roster UI needs it.
- A reply is fractal: it may be a region in this doc (light: a chat reply) or its
  own row plus child doc (heavy: a coding-agent run with its own transcript),
  chosen by weight. Same addressing, different granularity.
- **Size is bounded by archival, never by in-place deletion.** Across
  conversations it is already bounded: each is its own row-keyed child doc that can
  be destroyed whole. Within one long conversation it is not: Yjs `gc:true`
  reclaims a deleted entry's *content*, but the struct store keeps a
  `(clientID, clock)` floor per insert range ever made (adjacent GC structs merge,
  so contiguous deletes compact, fragmented multi-device history does not).
  Token-streaming is the worst case (many tiny inserts). So bounding a hot
  conversation means **rolling old entries into a fresh re-encoded doc** (which
  resets the clock floor) and keeping the live tail. The fractal graduation above
  is that mechanism, named here as the size answer, not just a weight convenience.
  `YKeyValueLww` (the overwrite-compacting KV that backs the row store) does *not*
  fix this: a conversation is append-and-stream, not key-overwrite, so there is no
  superseded value for it to garbage-collect.
- Forecloses, again, a requests table, a CRDT claim field, and a shared
  message array. It also forecloses absorbing human-to-human co-editing: two
  people editing one region is multi-writer, a neighboring primitive (a plain
  shared `Y.Text`), not an instance of this one.

## Considered alternatives

- **Keep ADR-0025's message array and `generationId`.** Rejected: the array is
  single-writer only by convention, and `generationId` plus "claim by existence"
  name contention that designation already foreclosed. Addressing makes the
  invariant structural and deletes both words.
- **Collapse entries and replies into one contribution graph with `replyTo`.**
  Considered. Fully general (branching, multi-party threads) but dissolves the
  simple linear transcript into a tree the renderer must flatten. Deferred as
  available-if-true-threads-arrive, not the default.
- **Absorb human-to-human co-editing into addresses.** Rejected: co-editing one
  region is genuinely multi-writer and has no single owner. It sits beside this
  primitive as a shared region; it is not an addressed reply.
- **Make presence the routing truth.** Rejected (inherited from ADR-0025):
  presence is ephemeral, the binding set is durable. Presence decorates, it does
  not route.

## Open decision: how deletion cascades to replies

Unresolved, recorded so it is not forgotten. Replies live in a sibling container
keyed by `entryId`, not nested under the entry, so deleting an entry does not
garbage-collect its replies: they survive as live content addressing a tombstone.
Two ways out, and they trade against each other:

- **Explicit cascade.** Deleting or superseding an entry must also delete every
  `replies.get(p).get(entryId)`. Keeps single-writer fully structural, but
  deletion becomes a protocol operation that must not be forgotten.
- **Nest replies under the entry.** Then entry-delete subtree-GCs the replies for
  free, but the entry's container is now written by several participants (per-key
  ownership), which is the soft invariant the structural split was built to escape.

You can have fully structural single-writer or automatic delete-cascade, not both
cleanly. Pick when deletion (beyond supersede-collapse) becomes real.

## Open decision: durable partial vs bounded floor when streaming

Resolved by ADR-0036
in favor of option A below: stream into the durable `Y.Text`. The body is a native
`MessagePart[]` (a `Y.Array` of typed parts whose text parts are `Y.Text`), so the
partial survives a refresh. The floor cost feared below is negligible for a
single-writer region: Yjs merges the contiguous same-client inserts both while live
and after deletion, so the unbounded fragmentation is a multi-writer phenomenon,
not a property of one agent streaming one answer.

Streaming an answer token by token
into a `Y.Text` is the worst case for the size floor (many tiny inserts that
fragment and never fully reclaim). Two models trade against each other:

- **Stream into the durable `Y.Text` (current).** A device can refresh mid-stream
  and still see the half-written answer; the partial survives disconnect. Cost:
  the per-token insert floor, bounded only later by archival re-encode.
- **Stream over awareness, commit once on finish.** Tokens ride ephemeral presence
  (zero doc floor, auto-cleared on disconnect); the finished text is one write.
  Floor bounds to `O(active answers)`. Cost: a refresh mid-stream loses the
  partial, and a worker that dies mid-stream commits nothing (arguably correct:
  interrupted means no artifact).

`YKeyValueLww` does not resolve this: modeling the stream as overwrite-KV would
bound the floor but resends the whole growing text each flush (`O(n^2)` writes)
and, being last-write-wins, forecloses any future co-edit of that region. This is
a product values question (is a durable mid-stream partial worth a growing floor),
not a mechanics question. Pick when streaming size pressure becomes real.
