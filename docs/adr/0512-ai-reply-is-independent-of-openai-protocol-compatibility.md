# 0512. AI reply is independent of OpenAI protocol compatibility

- **Status:** Proposed
- **Date:** 2026-10-08
- **Unbuilt:** Zhongwen adoption and an authenticated browser-to-host bridge.

## Context

An application such as Zhongwen needs to supply instructions and its saved
conversation, display a reply as it arrives, and save the completed answer.
Today Zhongwen uses Ollama through an OpenAI-compatible endpoint. Codex App
Server is another possible source: it exposes threads, turns, authentication,
approvals, and notifications through RPC. Making both available should not
require the application to adopt Codex's conversation storage or require every
backend to emulate the OpenAI HTTP protocol.

Epicenter already separates resource acquisition from application workflows.
[`@epicenter/app/ai`](../../packages/ai/src/ai.ts) exports
`openEndpointInference`, `openEpicenterInference`, and `openRuntimeTranscriber`.
Endpoint and hosted handles expose an OpenAI `client`, a lifetime `signal`,
and `close()`. The runtime transcriber has its own capability contract.
There is no aggregate App handle; applications open the resources they need.
See the [current inference surface](../../packages/app/README.md#inference).

The attraction of Codex is access through a person's existing Codex sign-in,
including eligible ChatGPT plans, rather than configuring an API key. That
access mechanism is separate from the API an application calls. This decision
does not promise free or unlimited inference or turn subscription credentials
into a general hosted API entitlement.

## Decision

**OpenAI protocol compatibility and Epicenter's reply capability remain separate surfaces.**

Existing inference handles retain their OpenAI client for callers that need
provider-specific operations. A narrow `Ai` capability exposes `ai.reply` for
applications that need a text answer. An OpenAI adapter calls a supported
endpoint operation; a Codex adapter speaks App Server RPC. Neither requires
the other surface to exist. An HTTP facade over Codex is optional integration
work, not a prerequisite for sharing the reply contract.

**A reply takes a complete application-owned snapshot and returns one canonical answer.**

The initial contract is text-only: instructions, user/assistant messages,
cancellation, optional provisional previews, and a terminal success or error.
Previews replace the current displayed preview; they are not durable transcript
entries. Only successful completion supplies text the application may validate
and save. EOF, cancellation, truncated output, and a failed Codex turn do not
count as success. An empty message list supports an opening reply. A one-message
request supports completion-style tasks such as feedback or rewriting.

**Reply delivery uses an async stream with a terminal Result.**

Zhongwen's practice workflow already yields application events. Keeping reply
delivery iterable lets it forward previews without a callback-to-stream bridge.
Feedback consumes the same stream without displaying previews. This is a
composition choice, not a stronger completion guarantee than a Promise.

The implemented contract in `@epicenter/app/ai`:

```ts
type ReplyRequest = {
  instructions: string;
  messages: readonly { role: 'user' | 'assistant'; content: string }[];
  signal: AbortSignal;
};

type ReplyEvent =
  | { type: 'preview'; text: string }
  | { type: 'result'; result: Result<string, ReplyError> };

type Ai = {
  reply(request: ReplyRequest): AsyncIterable<ReplyEvent>;
};
```

`Result` follows the repository's existing Wellcrafted convention. A fully
consumed attempt delivers one terminal Result and no subsequent events.
Expected provider failures, cancellation, and owner retirement produce an error
Result. Early iterator closure cancels the attempt and need not deliver a
Result. EOF without an outcome cannot authorize saving. Unexpected programming
errors may throw and likewise cannot authorize saving.

Each preview is the current replacement text; it may shrink, may differ from
the canonical answer, or may never arrive. Callers do not accumulate previews
to construct saved text. Nonempty answers, length limits, and grounded feedback
validation remain application policy. The contract excludes model catalogs,
tools, approvals, durable conversations, and general agent execution.

**Resource owners open connections; reply factories borrow them.**

Use explicit provider factories such as `createEndpointAi` and `createCodexAi`,
each returning the same `Ai` contract. Resources are the first argument;
model options are the second.
`Endpoint` names the connection category, including Ollama and hosted inference,
rather than implying an OpenAI vendor account. The factories implement the
reply method directly; no separate callable-to-object wrapper is needed.

Neither `createAi({ reply })` nor a generic source dispatcher owns useful
behavior at this stage. Provider selection stays with application settings.
Constructing an adapter neither starts a process nor logs a person in.
Closing the resource fences admission and initiates cancellation and cleanup.
An adapter never terminates a borrowed daemon or closes its resource when one
reply ends.

Ollama caller:

```ts
const inference = await openEndpointInference({
  baseURL: 'http://127.0.0.1:11434/v1',
});
const ai = createEndpointAi(inference, { model: 'qwen3.5:9b' });
```

The same adapter can borrow the result of the existing
`openEpicenterInference({ account })`. Authentication and destination remain
owned by that handle; prompts cannot choose where its credentials go.

Codex caller; process acquisition requires a Node/Bun host:

```ts
import { createCodexAi } from '@epicenter/app/ai';
import { openCodexConnection } from '@epicenter/app/ai/codex';

const connection = await openCodexConnection({ executable: '/path/to/codex' });
const ai = createCodexAi(connection, { model: selectedModel });
```

Here the opener owns a dedicated process and RPC connection. A browser cannot
spawn that process; it needs a host connection or an authenticated bridge.
Connection acquisition owns authentication readiness. The reply adapter owns
request translation and turn cancellation. Transport, pairing, and hosted
billing remain independent decisions. Keep these capabilities alongside
inference in `@epicenter/app/ai`; do not introduce a new package or aggregate
application handle merely to group them.

The application uses either adapter the same way. It retains the outcome,
consumes the stream, and checks cancellation before its conditional save:

```ts
let outcome: Result<string, ReplyError> | undefined;
for await (const event of ai.reply({ instructions, messages, signal })) {
  if (event.type === 'preview') showPreview(event.text);
  else outcome = event.result;
}
if (signal.aborted) showStopped();
else if (outcome === undefined) showIncomplete();
else if (outcome.error !== null) showError(outcome.error);
else await validateAndSaveAssistant(outcome.data);
```

Thrown errors follow the application's failure path. Keep the resource open
across replies; close `inference` or `connection` in the application's session
cleanup. The adapter combines the request signal with the owner's lifetime
signal. Aborting either promptly settles pending iterator work and suppresses
further previews and success. Calling iterator `return()` initiates cancellation
immediately, including when an earlier `next()` is pending.

Existing endpoint `close()` drains transport work, not arbitrary adapter
processing. The adapter must independently settle on owner cancellation and
refuse new work after retirement. The Codex connection owner must
track active attempts through interruption, notification cleanup, and thread
cleanup; draining RPC response promises alone is insufficient. The implemented
owner tracks these attempts and retires its process when interruption or thread
cleanup fails.

**Codex reply attempts use disposable threads while reusing the connection.**

Each attempt supplies the current snapshot to a fresh ephemeral thread.
Conversation files remain authoritative across edits, failed saves, retries,
and device synchronization. A reused hidden thread must not accumulate an
assistant answer that the application failed to save. Changing instructions
also takes effect on the next attempt.

Codex verification covers exact role/history mapping, opening replies without
learner input, ephemeral thread behavior, cancellation before turn acknowledgment,
and final-answer selection. Restrict
tools, inherited instructions, and workspace access before execution;
discarding tool events afterward does not prevent their effects. Read-only
filesystem access still permits reading files. Unknown message phases require
conservative preview handling and a verified canonical final answer.

## Implementation and verification

`@epicenter/app/ai` exports `createEndpointAi`, `createCodexAi`, and the shared
reply contract. `@epicenter/app/ai/codex` exports the host-only
`openCodexConnection`. The endpoint adapter calls streaming Chat Completions.
The Codex owner opens a dedicated stdio process, checks authentication readiness,
and admits no server-request capability. The adapters capture model selection
at construction and transcript content when `reply` is called.

The experimental Codex opener accepts exactly **0.160.1**. It uses an isolated
temporary working directory, disables tool and connector capabilities, and
starts each reply in an ephemeral thread. The
[real-process probe](../../packages/app/evidence/ai-reply/codex-probe.ts) runs that
version with the built-in OpenAI provider against a local HTTPS Responses
fixture. It checks outgoing tool and instruction content, exact transcript
roles, empty opening input, canonical completion, cancellation, and owner close.
The fixture disables response WebSockets and request compression to inspect HTTP
requests; those inference transport paths are not verified by this probe.
No account inference or model credits are consumed. Tests cover failure outcomes,
owner retirement, pending iterator cancellation, and cancellation before turn
acknowledgment.

Other Codex versions, live model behavior, and other provider configurations need
renewed verification. Zhongwen integration, browser bridging, device pairing,
and cloud routing remain unbuilt. This package creates no HTTP endpoint over
Codex and does not modify a person's Codex sign-in.

## Consequences

Zhongwen can change reply providers without changing prompt construction,
conversation storage, feedback validation, or save policy. Its current display
stream must change from appending deltas to replacing previews. Callers lose
provider-specific finish checks and final-text accumulation, but retain a
check that a terminal outcome arrived. Applications that need the OpenAI SDK
can continue to use it directly. This is a shared text
capability, not a promise of identical provider features.

Codex's richer protocol requires a real adapter and host lifecycle. The
connection can live across many replies, but each disposable thread pays for
transmitting the application snapshot. Preview replacement allows the adapter
to distinguish provisional commentary from a final answer. Whole-text previews
copy more data than deltas; adapters may coalesce them. Feedback length limits
must also be checked on the final answer when previews are absent.

The existing [agent engine](../../packages/agent-protocol/src/index.ts) remains
a separate contract: it performs one model invocation and delegates tools to
Epicenter's agent loop. A Codex turn can contain its own agent execution and
must not be substituted for that engine as if it were one model invocation.

## Considered alternatives

- Return `Promise<Result<string, ReplyError>>` with a replacement-preview
  callback: gives final completion a direct return channel and suits silent
  feedback. Zhongwen's practice generator needs a latest-preview cell and wakeup
  coordination to bridge callbacks into its stream. This is valid, but adds
  coordination at the current caller; the iterable wins by composition.
- Return a bare reply function: removes one method property, but does not remove
  protocol adaptation. A one-method object follows Epicenter's resource-first
  factory pattern without requiring an extra construction layer.
- Add text-resource openers owning another `signal` and `close()`: duplicates
  the existing resource lifetime or hides an SDK client callers can still use.
- Add `createAi({ reply })` or a source dispatcher: adds a forwarding layer or
  central backend configuration without removing either provider adapter.
- Require every backend to implement OpenAI HTTP endpoints: useful for existing
  clients, but forces Codex turns into an append-only completion stream and
  makes HTTP emulation mandatory for local library use.
- Make persistent conversations the shared primitive: gives the provider
  competing ownership of history and requires reconciliation after edits or
  failed application saves.
- Route Ollama and hosted endpoints through Codex: adds a process and agent
  protocol to callers already served by a direct endpoint.
- Treat App Server as mandatory for ChatGPT-plan access: confuses credential
  access with the application's capability contract. Eligible direct inference
  mechanisms can also back an adapter when their terms and capabilities fit.

## External grounding

The [App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes its RPC protocol and turn lifecycle. The
[Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source)
describes eligible token-sharing use; it does not establish blanket API access
for a remotely hosted service. Provider eligibility and supported transport
must be checked at implementation time.
