# 0033. A conversation is a synced doc answered only by in-process peers; the cloud is a metered inference stream, not a doc writer

- **Status:** Accepted (amended 2026-06-20 by ADR-0041, corrected same day by ADR-0043)
- **Date:** 2026-06-18
- **Amendment:** The doc-as-transport doctrine stands: a conversation is a synced doc only an in-process peer writes, and the relay/anchor stays blind. ADR-0041 revises *which* in-process peer answers a managed conversation — an Epicenter-hosted worker (a separate app-aware spoke), not the open browser tab. The browser never answers; blindness becomes per-agent. The "cloud is never a doc writer" clause narrows to "the relay/anchor is never a doc writer."
- **Correction (2026-06-20) by ADR-0043:** ADR-0041's "the browser never answers" is reversed. The **client tab answers the capability-free agent** in-process over the metered stream, and there is no Epicenter-hosted answerer. What this ADR got right is unchanged and in fact reinforced: a conversation is a synced doc only an in-process peer writes, the relay/anchor is never a doc writer, the cloud is a metered inference stream, and blindness is per-agent.
- **Relates:** [ADR-0031](0031-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) (the addressed regions a reply is written into), ADR-0036 (the parts body streamed into Y.Text), [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (actions are the tools), [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md) (the anchor never thinks; workers are peer spokes), [ADR-0030](0030-agents-are-immutable-capability-bundles.md) (agents), ADR-0034 (the withdrawn server-side cloud generation this supersedes)

> **Vocabulary:** a **transport** is how an answer reaches the people watching a
> conversation; here it is always the synced child doc. An **answerer** is an
> **in-process peer** that observes the doc and writes a reply into it: a
> **browser tab** (interactive, the user is watching) or a **daemon** (ambient,
> always-on). A **ChatStream** is the pluggable inference backend an answerer
> calls for tokens. The **Epicenter provider** is a client-side `ChatStream` that
> posts to the metered `/api/ai/chat` SSE endpoint, so an answerer gets house-key
> cloud inference without a raw provider key.

## Context

There were three ways an answer was produced, forking the system along two seams
at once. The SSE route (`/api/ai/chat`) streamed tokens back over an open HTTP
connection while the browser held the conversation in TanStack `createChat`
in-memory state. The cloud doc one-shot (`runDocGeneration`, behind
`/api/ai/chat/doc`) had the **server** stream into a synced Y.Doc as a sync peer
of the room (hydrate a replica, forward updates over `room.sync` RPC). The daemon
observer (`attachChatWorker`) did the same doc streaming with no HTTP at all.
ADR-0036 made the body one shape (parts streamed into Y.Text), removing the last
structural reason for a separate SSE-rendered state owner.

A first collapse (the now-withdrawn ADR-0034) tried to keep the server as a doc
writer but move it off a held-open request onto a Cloudflare Queue, to buy a
durable mailbox cheaply. Grilling that against the rest of the system showed it
solved a problem the product does not have: it added a queue, a consumer, a
cross-invocation billing dance, and a server-side Yjs peer, all to make a
**cloud** answer survive the client disconnecting. But the durable, always-on,
background answerer is the **daemon** (ADR-0035's worker spoke), which gets that
property for free; the **cloud** answer is the interactive case where the user is
watching. The decisive observation: opensidian already answers cloud
conversations *in the browser* using the Epicenter provider
(`attachChatBrowserAnswerer({ startStream: createEpicenterProviderChatStream(...) })`),
with no kickoff and no server doc writer. zhongwen was the only app still poking a
server-side generator.

## Decision

A conversation is **one transport (the synced doc), written only by an in-process
peer**, and **billing rides the inference backend (the Epicenter provider), not a
trigger**. Every answerer, in every runtime, observes the doc and streams parts
(ADR-0031's reply regions, ADR-0036's parts body) into it; the client always
renders the doc. The server is **never** a doc writer for chat. It offers two
clean, separate things, neither of which reads or writes a conversation doc:

```txt
EPICENTER CLOUD = two primitives, neither chat-aware:
  1. relay + anchor + store   the blind network (moves bytes for ALL docs; ADR-0035)
  2. /api/ai/chat (SSE)        a stateless, metered inference stream (sees a prompt, returns tokens)

WHO WRITES THE DOC = always an in-process peer (a worker; ADR-0035):
  browser tab   -> attachChatBrowserAnswerer   interactive, the user is watching
  daemon        -> attachChatWorker          ambient, always-on, durable for free

INFERENCE (a per-agent ChatStream, orthogonal to who writes):
  Epicenter provider -> posts to /api/ai/chat; house-key, metered via Autumn (the synchronous 402 boundary)
  BYOK               -> the user's own provider key; free of Epicenter
  local              -> a model on the user's machine; free, nothing leaves
```

- **The answerer is always an in-process peer; there is no kickoff.** The browser
  answers a conversation it is watching exactly as a daemon answers one it
  observes: the same `attachChatWorker` loop, the same existence-is-the-claim
  guard (`findUnansweredTurn`), so a browser and a daemon on the same conversation
  never double-answer one turn. The cloud-vs-daemon fork is **not** a trigger
  fork; it is a designation fork (ADR-0025): a conversation bound to a resident
  daemon agent is answered by the daemon and the browser stays out; otherwise the
  open browser is the answerer. The old `runDocGeneration` server kickoff is
  deleted, not re-homed.

- **The cloud is a metered inference stream, never a doc writer.** A browser
  answering a cloud conversation calls the Epicenter provider, which posts the
  prompt to `/api/ai/chat`, receives tokens, and the browser writes them into its
  local doc (which syncs to every device). The server sees a prompt and returns
  tokens; it never sees the room, the doc, or the conversation. This keeps the
  relay strictly blind (ADR-0035) and makes the inference endpoint a general API
  any client can call.

- **Billing rides the Epicenter provider's SSE request: reserve, then confirm.**
  `/api/ai/chat` is already gated by `chargeAiCreditsWithAutumn`, which reserves
  credits before streaming (a synchronous **402** if the owner is broke), then
  confirms on success or releases on a pre-stream failure, all inside the one
  request. Tokens consumed when a stream dies mid-way are billed, not refunded
  (kept). The synchronous-402 boundary the withdrawn kickoff existed to provide is
  *already here*, on the endpoint the answerer calls. No reservation crosses a
  process boundary; no queue; no `finalize` dance. Idempotency falls out of the
  existence-is-the-claim mechanism: a retried answer finds the reply already
  claimed in the doc and does not re-stream.

- **Inference is a per-agent choice of three backends; managed "log in, no keys"
  survives at every runtime.** Local model, BYOK provider, or the Epicenter
  provider (the user's credits; metered). The answerer's `ChatStream` seam is the
  plug, so a daemon, a browser tab, and a future worker host all get cloud
  credits without a raw key, and BYOK is one option, never a requirement.

- **Self-host stays free by configuration, not construction.** A self-host daemon
  on a local model or BYOK key is free; the hosted-only billing policy is injected
  via `mountAiApp` and self-host passes none. Self-host mounts `/api/ai/chat`
  (SSE) and nothing chat-doc-specific; the `personal()` / `shared({ admit })` seam
  is untouched.

The doctrine is one sentence: *a conversation is a synced doc that only an
in-process peer (a browser tab or a daemon) writes into; Epicenter cloud is a
blind sync network plus a stateless metered inference stream, and it never writes
a conversation doc.*

## Consequences

- **The deletion prize is the entire server-side doc-generation vertical.** Gone:
  `runDocGeneration` (the server-as-Yjs-peer), the `/api/ai/chat/doc` route, the
  withdrawn queue + consumer, the cross-invocation billing reservation, and the
  browser's "fire a kickoff" path. Kept and now universal: `attachChatWorker` /
  `attachChatBrowserAnswerer` (the in-process answerer), the `/api/ai/chat` SSE
  endpoint (the metered inference stream, billed by the existing Autumn policy),
  and the Epicenter provider `ChatStream` (promoted from opensidian to a shared
  package so zhongwen and opensidian share one implementation).

- **Time-to-first-token improves for cloud answers, not regresses.** The
  answering device streams tokens *directly* from `/api/ai/chat` (no relay
  round-trip, no DO trigger) and writes them into its local doc with an instant
  echo, recovering the latency the server-writes-the-doc model gave up. Other
  devices watch the answer appear through normal doc sync; passive observers
  paying a sync round-trip is correct.

- **Durability maps onto the daemon, where it is free.** Close the tab mid cloud
  answer and that answer stops (interactive, as intended). Want an answer that
  completes in the background and across devices? Bind the conversation to a
  daemon agent. The product never pays queue infrastructure (or ~$4/user-month of
  idle residency) for a durability the interactive case did not want.

- **The relay stays strictly blind and the cloud stays maximally reusable.** No
  conversation semantics live in any request handler in `packages/server`; the
  room DO never gains chat code (ADR-0035 strengthened). `/api/ai/chat` is a
  general inference API — browser, mobile, CLI, or a daemon's Epicenter provider
  can all call it.

- **Privacy is a transparent, user-controlled backend choice.** A data-reading
  agent's tool results enter the prompt, so the *inference backend* decides where
  data goes: local keeps it on the machine, BYOK sends it to that provider, the
  Epicenter provider sends the prompt to us and the provider. Default local; any
  cloud choice explicit; no silent cloud binding.

- **Foreclosed: house-key server-side generation that outlives the client without
  a daemon (a "managed background agent").** That is the deliberate trade. If a
  product genuinely needs it later, it reopens one explicitly-justified
  server-side worker (the Model-2 sandbox lane, ADR-0030), not a general
  server-writes-every-doc path.

## Considered alternatives

- **Keep the server as a doc writer, move it off a held-open request onto a queue
  (ADR-0034).** Withdrawn. It solved durable server-side cloud generation, a need
  reassigned to the daemon; for the interactive cloud case it added a queue, a
  consumer, and a cross-invocation billing dance for nothing. See ADR-0034.
- **Keep the cloud kickoff as the billing/402 boundary.** Rejected: the
  Epicenter-provider SSE request is already that boundary (reserve → 402 → confirm
  in one request), so a separate server answerer is redundant.
- **Keep SSE as a co-equal *rendered* transport (the browser holds the thread in
  `createChat`).** Rejected: that was two state owners and the text-vs-tools
  split. The SSE *wire format* survives as the inference stream; what dies is a
  client rendering a conversation from it as in-memory state.
- **Generate inside the room DO (ambient cloud).** Rejected by ADR-0035: the
  coordination box never thinks; workers are peer spokes, not the box.
- **Stream over awareness instead of the durable doc.** Rejected in ADR-0036.

## Open questions

- **Multi-browser claim bias.** When two of a user's own tabs have the same cloud
  conversation open, the existence-claim means one wins; bias the *active* tab so
  the watched device answers. Minor, post-tracer.
- **Prompt-pruning of old tool-results** (the AI SDK `before-last-N` policy),
  deferred by ADR-0036; orthogonal, needed only once results accumulate.
