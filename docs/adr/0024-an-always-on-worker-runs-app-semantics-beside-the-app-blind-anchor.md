# 0024. An always-on worker runs app semantics beside the app-blind anchor

- **Status:** Superseded
- **Superseded by:** [ADR-0043](0043-an-agent-answers-where-its-capability-lives.md) (Epicenter runs no hosted answerer; the app-blind anchor and app-aware worker separation that survives is recorded independently by ADR-0035)
- **Date:** 2026-06-16
- **Note (2026-06-20):** ADR-0041 resolved the latent tension between this ADR and [ADR-0033](0033-a-conversation-has-one-transport-and-two-triggers.md) by realizing the "hosted worker" quadrant as an on-demand Epicenter-hosted answerer. **Superseded same day by [ADR-0043](0043-an-agent-answers-where-its-capability-lives.md):** that quadrant is *not* built (it served a phantom cell), so Epicenter hosts no answerer. What stands from this ADR: the worker is a separate app-aware spoke beside the app-blind anchor, never fused into the anchor/room DO. What changes: an agent answers where its capability lives, so the answerer is the client tab (capability-free agent) or the user's own daemon (local-data agent), never a worker Epicenter runs for you.

## Context

Epicenter currently syncs a workspace through a hosted Cloudflare room. That room
does two jobs at once: it carries Yjs update bytes between peers, and it stores
the durable room state a sleeping device later catches up from. In the Iroh
direction those jobs split. A blind relay helps peers reach each other and
forwards encrypted packets; an anchor is the durable app-blind replica that stores
Y.Doc state. [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md) still
applies to any durable anchor that can materialize plaintext: privacy is a
property of who runs that anchor, not of the CRDT bytes being unreadable.

Apps also need always-on semantic work: stream an assistant turn into a
conversation, run the app's actions, query a local read model. Today that work
runs as an HTTP route on the hosted Worker, which fuses it with the cloud
deployment and ties it to hosted infrastructure. The recurring confusion is
calling the always-on device an "anchor" when it is being asked to store docs,
move bytes, and think.

## Decision

Transport, custody, and semantic work are three roles with three names:

```txt
relay:
  moves packets between peers
  should be blind to application plaintext
  is not durable workspace storage

anchor:
  stores and serves durable Y.Doc state
  stays app-blind: no schema, layout, actions, prompts, or tools
  may be hosted by Epicenter or self-hosted by the user

worker:
  holds a live workspace replica
  observes docs, runs app actions and inference, and writes results back
  may run in Epicenter Cloud or on a user device
```

A worker runs beside an anchor, never inside the anchor role. One machine may host
both, but the contracts stay separate: the anchor keeps docs alive; the worker
thinks and writes. Epicenter Cloud can therefore be a blind relay, a hosted
anchor, and a managed worker deployment, but those are three composable roles, not
one product shape. A user-owned box can be an anchor, a worker host, or both.

### Agent and worker are not one word for one thing

The triad above is about runtimes. Binding is about identity, and the two use
different words on purpose:

- An **worker** is a running process: the role above that holds a live replica,
  observes, and writes.
- An **agent** is the durable, configuration-authored *address* a conversation
  binds to (`AgentId`, [ADR-0025](0025-agent-conversations-are-durable-child-docs-driven-by-an-observing-worker.md)),
  and that one or more workers answer *as*.

A laptop daemon is one worker that answers as the agent a user named it;
Epicenter's managed deployment is a worker that answers as `epicenter-cloud`.
Presence resolves a live agent to whatever node currently runs its worker, so the
per-install `NodeId` (transport identity) and the Yjs `clientID` (CRDT identity)
churn underneath while the `AgentId` stays put. Anchor and relay carry no agent
identity at all: they never answer, only store and forward. "Which agent answers"
is a row field; "where the worker runs" is the right-hand column of the grid
below; they move independently.

### Observing a conversation is one trigger, not the worker's definition

The worker's job is to run app semantics beside the anchor: observe app state, run
inference and the app's actions, write typed results back. A conversation
transcript is one observable layout it can drive (a child-doc change triggers it,
streamed `Y.Text` is the result), not the shape of the role. The same observe loop
hosts any observable child-doc layout, and the broader worker may react to a row or
cell change, a schedule, or an external event, and write a typed cell, new rows,
or a durable approval record instead of a `Y.Text`. Three axes stay independent:
what *triggers* the worker, what *work* it runs, where the *result* lands.
Collapsing them so all model work must be serialized as chat turns would re-narrow
the general role into a chatbot substrate. So a worker must never synthesize a
human-addressed turn to reach the runtime: autonomous work observes its own
target, it does not impersonate a user message. Conversations are one durable
interface to a worker, not its only one.

```txt
                         WORKER
                    hosted    |    self-hosted
ANCHOR          --------------+----------------
hosted          cloud default | hosted custody,
                shape         | local tools
self-hosted     self custody, | full self custody
                hosted model  | and local tools
```

Relay is a third, independent axis, left off the grid because it is blind either
way: you can self-host the anchor and still use Epicenter's relay for NAT
traversal, or run a fully local relay. Moving the anchor or the worker never forces
the relay to move with it.

## Consequences

- "Anchor" stays app-blind, so one Rust/Iroh sidecar can multiplex many rooms and
  the custody claim of ADR-0004 stays honest. The anchor may hold readable
  plaintext CRDT state; the relay should not.
- The product can make Epicenter Cloud easy without making it mandatory:
  Epicenter-hosted anchor is the default, self-hosted anchor is a custody swap,
  and workers can move independently of either choice.
- The hosted AI route is revealed as a co-located managed worker, not part of the
  relay. When an app's worker runs on the user's own device, the hosted route is
  unnecessary, and private facts never leave the machine.
- A worker is the existing daemon body plus an observe loop, not a new process
  kind. The mount runtime gains a child-doc observe loop
  <!-- doc-path-check: ignore-next-line (historical source deleted by ADR-0166) -->
  (`packages/workspace/src/document/child-doc-worker.ts`) over a node-only body
  connector injected through `nodeMountRuntime().connectChildDoc`
  <!-- doc-path-check: ignore-next-line (historical source deleted by ADR-0166) -->
  (`packages/workspace/src/daemon/mount-runtime.ts`); both are additive.
- Hosting is schema-driven, symmetric with the browser child-doc opener. A
  browser `connect()` reads the table's `docDecls` and hands the UI
  `tables.<t>.docs.<field>.open(rowId)`; a daemon `mount({ workers })` reads the
  same `docDecls` and runs an observe loop per registered field. The app
  registers behavior only (a per-body factory keyed by table and field); the
  table, the guid deriver, and the layout all come from the schema, never
  re-passed at the call site. Re-passing them would let a worker read a body
  with a layout that disagrees with the schema, the one corruption the
  single-owner derivation forecloses. Only an observable layout (one exposing
  `observe`) can carry a worker.
- Forecloses a single "anchor runtime" that hosts app workers as one fused thing.
  Fusing the contracts would make the durable app-blind role app-aware again and
  break both multiplexing and custody clarity.

## Considered alternatives

- **One "anchor" that does custody and semantics.** Rejected: it contradicts the
  app-blind premise the cloudless transport depends on.
- **One "relay" that means both network forwarding and durable storage.**
  Rejected: Cloudflare rooms currently bundle those jobs, but Iroh splits them.
  Keeping one word hides the privacy and deployment choice users actually make.
- **Workers only in the cloud (the status quo HTTP route).** Rejected: it ties
  semantic work to the cloud and forecloses local inference and the cloudless
  topology.
