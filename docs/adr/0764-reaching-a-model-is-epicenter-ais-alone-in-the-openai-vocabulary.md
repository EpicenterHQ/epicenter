# 0764. Reaching a model is `@epicenter/ai`'s alone, in the OpenAI vocabulary

<!-- doc-path-check: ignore-file (cites code that moved since) -->

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) at the endpoint shape `{ id, fetch, models() }` with `models(): Promise<Model[]>`, at `ai.complete(request)`, at `openAi` reading `models()` at fixed moments, and at keys "the keys `@epicenter/account` holds" and its accessor: the endpoint is `{ id, name, source, fetch, models(), subscribe?, refresh? }` with a synchronous `models()`, `openAi` has `chat`, `transcribe` and `embed`, and the keys are `@epicenter/ai`'s; [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) at who holds the provider keys in an app's credentials place: `@epicenter/ai` writes and reads them through the shell, and on the web they sit in the browser's storage; [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) at the `account` row's "and the person's provider keys": `account` is this app's Epicenter sign-in; [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) at "Open, not decided": the agent loop speaks the OpenAI vocabulary.
- **Relates:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (explicit read methods and one `subscribe`), [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the agent loop), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (the sync moments).
- **Unbuilt:** what branch `claude/whispering-endpoints` is building: the agent loop's request as `ChatMessage[]` and `ChatTool[]`; Whispering's transcription and chat through `openAi([...])` in place of its per-provider routing; the transcription package renamed from `@epicenter/transcription-native` to `@epicenter/transcription`; `localSpeech()`'s remove, load and unload beside `download`.

## Context

[ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)
gave an endpoint the shape `{ id, fetch, models() }` with
`models(): Promise<Model[]>`, gave `openAi` one `ai.complete(request)`, and
had `openAi` read each endpoint's `models()` at the sync moments, when a
picker opens, and after a `localSpeech()` lifecycle action. It had a person
add and remove provider keys "through the keys `@epicenter/account` holds",
and listed as unbuilt an accessor through which the account hands them over.
[ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)
gave `account` the sentence "this app's credentials: its Epicenter sign-in
and the person's provider keys".
[ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) left open
whether the agent loop speaks the OpenAI vocabulary instead of its own
message types, pending a measurement of the translation.

The code merged in `08a16019ed` built a different shape. `Endpoint` in
`packages/ai/src/endpoint.ts` carries a `name` and a `source`, a `fetch`
that takes a path relative to the endpoint, and a `models()` that returns at
once. `openAi` in `packages/ai/src/open-ai.ts` has `chat`, `transcribe` and
`embed` instead of `complete`. Vocab merges its endpoints inside a
`$derived` (`apps/vocab/src/lib/ai.svelte.ts`), so every key the learner
adds builds a new `openAi` value. Under an asynchronous `models()`, each of
those merges lists nothing until every endpoint's promise settles, and a
picker waits on the slowest: a stopped local server answers only at the
2-second probe timeout in `packages/ai/src/local-servers.ts`.

A custom endpoint answers whether or not the person is signed in to
Epicenter, so its key cannot come from the account.

The agent loop sends an engine `ModelMessage`, `ModelToolCall` and
`AgentEngineToolDefinition` values (`packages/ai/src/agent/engine.ts`), and
`createChatEngine` (`packages/ai/src/agent/chat-engine.ts`) maps them to
`ChatMessage` and `ChatTool` from `packages/ai/src/client.ts`. Measured on
2026-11-04: about 100 lines are pure translation between the two, field for
field, and about 55 of them can be deleted.

## Decision

**An endpoint is `{ id, name, source, fetch, models(), subscribe?, refresh? }`,
and `models()` never waits.**

```ts
type Endpoint = {
  id: string;                     // unique among the merged endpoints; a model choice names it
  name: string;                   // what a person calls it: "Epicenter", "Ollama"
  source: 'local' | 'hosted' | 'custom';
  fetch(path: string, init?: RequestInit): Promise<Response>; // path relative to the endpoint: "chat/completions"
  models(): readonly EndpointModel[];             // what it last found
  subscribe?(listener: () => void): () => void;   // absent when models() never changes
  refresh?(): void;                               // look again in the background
};
```

An endpoint that probes (each of the two `localServers()` endpoints, and
`localSpeech()`) probes in the background, when its first subscriber
arrives and on `refresh()`, and calls its subscribers when its list
changes. `hosted(account)` calls them once, when sign-out retires the
account. A `custom(...)` endpoint lists the models it was given and has
neither method.

**`openAi([...])` exposes `models()`, `subscribe`, `refresh`, and one
method per kind of request.**

```txt
ai.models()                         every endpoint's models in the array's order, each with endpoint and source
ai.subscribe(fn)                    fires when any endpoint's models may have changed; returns the unsubscribe
ai.refresh()                        asks every endpoint that probes to look again
ai.chat({ endpoint, ...req })       streams; yields Result<ChatChunk, AiError>
ai.transcribe({ endpoint, ...req }) Promise<Result<Transcription, AiError>>
ai.embed({ endpoint, ...req })      Promise<Result<Embeddings, AiError>>
```

Each request is the OpenAI-shaped `ChatRequest`, `TranscriptionRequest` or
`EmbeddingsRequest` plus `endpoint`, the id from the chosen model's
`ModelChoice` (`{ endpoint, model }`). It goes through that endpoint alone;
nothing falls back to another. The moments at which ADR-0757 read
`models()`, the sync moments of ADR-0750 and opening a picker, are calls to
`ai.refresh()`. `fromAi(ai)` in `@epicenter/ai/svelte` turns `models()` into
a getter that subscribes while read, as ADR-0754 has every Svelte adapter
do.

**Every failure is a typed `Result`.** A request's failures reach the
caller as `AiError` values, never as exceptions: `NoEndpoint`,
`Unreachable`, `Refused` (any non-2xx answer, with the provider's message
and code), `Failed` (an error the provider sent mid-stream), `Malformed`,
and `Cancelled`. A chat stream ends after its first error.

**The person's provider keys belong to `@epicenter/ai`.** It adds, lists and
removes the endpoints a person connects (`createAiConnections` in
`@epicenter/ai/connections`), and `custom(...)` turns each into an endpoint.
Where a key is kept is ADR-0740's, unchanged:

| Where the app runs | Where the key is kept | Who sends it |
| --- | --- | --- |
| Desktop | the app's credentials file in its AppData, written through the shell | the shell's fetch adds it, so the page never holds it |
| Web | the browser's storage for the app's origin | the page, with plain `fetch` |

**`@epicenter/account` is this app's Epicenter sign-in.** ADR-0755's row
for it reads `account` | capability | this app's Epicenter sign-in. The
account hands AI nothing but itself to `hosted(account)`, and no accessor
for provider keys is built.

**The agent loop speaks the OpenAI vocabulary.** The request the loop sends
an engine is `{ messages: ChatMessage[], tools: ChatTool[] }`.
`ModelMessage`, `ModelToolCall` and `AgentEngineToolDefinition` leave
`engine.ts`, and `toChatMessage` and `toChatTool` leave `chat-engine.ts`.
`AgentMessage` in `packages/ai/src/agent/message.ts` is the transcript the
loop stores, not a request; the loop builds `ChatMessage[]` from it, where
`toModelMessages` builds `ModelMessage[]` today.

**The loop keeps one type of its own, the stream `EngineChunk`.** Its three
events are `text-delta`, `tool-call` with parsed input, and `run-error`.
`createChatEngine` reduces fragmented or index-less tool-call deltas into
one `tool-call` and reads provider finish reasons, so neither reaches the
loop.

## Consequences

- A picker shows each endpoint's last list at once. A re-merge, such as
  Vocab's after a key is added, keeps every list instead of emptying it.
- Each kind of request has its own input and output type: a transcription
  takes a `file` or a `path` and returns `{ text }`, and a chat yields
  chunks. A new kind, such as speech, is one more method on `openAi` and on
  the client.
- `subscribe` and `refresh` are optional, so code that holds a bare
  endpoint checks for them; `openAi` does.
- A person signed out of Epicenter still reaches their own providers and
  local servers; only `hosted(account)` lists nothing.
- The desktop credentials file holds entries two capabilities own: the
  account's refresh token and AI's keys. Each reaches only its own through
  the shell.
- About 55 lines leave `packages/ai/src/agent/`. An engine for a provider
  that does not speak OpenAI translates from the OpenAI vocabulary, not from
  one of Epicenter's.

## Considered alternatives

- **`models(): Promise<Model[]>` (ADR-0757).** Every re-merge lists nothing
  until each endpoint settles, and a picker waits up to the probe timeout of
  a stopped local server.
- **One `ai.complete(request)` (ADR-0757).** Its input is a union over
  request kinds and its output a union the caller narrows, with a stream and
  a single answer behind one return type.
- **Keys handed over by `@epicenter/account`.** A person who is not signed
  in to Epicenter could not use their own provider.
- **Keep the loop's message types.** About 100 lines map them to
  `ChatMessage` and `ChatTool` field for field.
- **Drop `EngineChunk` too.** The loop would reduce partial tool-call
  arguments and read `finish_reason`, which some providers send as `stop`
  in the middle of a tool call.
