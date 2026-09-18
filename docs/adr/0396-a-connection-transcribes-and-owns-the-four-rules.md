# 0396. A connection transcribes and owns the four rules

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) at model fallback: a saved model the destination cannot serve is sent as saved and refused by the server; nothing substitutes that backend's default.
- **Relates:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) (the two scopes a connection lives under), [ADR-0363](0363-an-inference-selection-identifies-the-connection-and-model.md) (the `{ connectionId, model }` pair a caller holds), [ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md) (the catalog and its retirement on change), [ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md) (the 402 this names), [ADR-0398](0398-every-transcription-destination-speaks-the-openai-wire.md) (the one wire this speaks)
- **Unbuilt:** All of it. A connection entry today is `{ id, client }` from `app.ai.connections.get(id)` in `packages/app/src/ai.ts`, with `account` and `runtime` as separate members; no connection has a `transcribe` method; `matchInferenceTarget` in `packages/app-shell/src/inference-selections.ts` returns a bare client.

## Context

`matchInferenceTarget` matches a saved `{ connectionId, model }` against
`app.ai.account`, `app.ai.runtime`, and `app.ai.connections`, and returns a
client or null. Four rules then get typed out again per workflow.
`apps/whispering/src/lib/operations/transcribe.ts` and
`apps/whispering/src/lib/operations/completion.ts` each match the exact
destination with no fallback, capture the client before reading the audio
blob, read HTTP 402 as out of credits, and drop a late result after the App
retires. Vocab's dictation calls `client.audio.transcriptions.create` on the
account client directly and gets none of the four. A second application that
transcribes gets them wrong by omission.

`packages/app/src/ai.ts` already binds every client to the App's lifetime:
its `fetch` wrapper asserts the App is usable, checks a per-client `retired`
signal that `invalidate()` aborts when the catalog entry is removed or its
URL, key, or access version changes, and joins those with the caller's
signal before any bytes leave. A held connection object therefore fails
closed on its own. The platform has the material for the four rules; it has
no verb that applies them.

## Decision

**A connection is an object with a client and one verb, `transcribe`, and the
verb owns the four rules.**

```ts
type Connection = {
	id: string;
	label: string;                      // the custom name, the server host, or "This device"
	client: OpenAI;                     // chat and everything else go through the SDK directly
	models: readonly string[];
	transcribe(
		model: string,
		request: { audio: Blob; language?: string; prompt?: string },
	): Promise<Result<string, TranscriptionError>>;
};

app.device.connections.get(id): Connection | null       // native runtime and custom endpoints
app.device.connections.getAll(): Connection[]
app.account?.connection: Connection                     // the server's gateway

connectionFor(app, selection: { connectionId: string; model: string }): Connection | null
```

`connectionFor` is a free function exported by `@epicenter/app` beside the
selection type. It reads the scope from the id's encoding (ADR-0363) so no
caller parses a prefix, and it returns null for a signed-out account, an
absent runtime, or a removed custom entry. It never returns another
connection.

- **Exact destination.** A method on a connection can go nowhere else. There
  is no lookup inside the call, so a selection edit during the call cannot
  retarget it, and the model is sent as the caller named it.
- **Capture before I/O.** The caller looks the connection up once and holds
  one frozen object across its audio read. The object compares nothing at call
  time; a removed or changed entry has already had its client retired, and the
  call fails as `Unavailable` before sending.
- **Account 402 is credits.** `app.account.connection` maps HTTP 402 to
  `InsufficientCredits`, because only a metering deployment answers 402
  (ADR-0100). A self-hosted instance answers 503 until an operator sets a
  house key (ADR-0075); that stays `Rejected` with the server's own detail so
  the operator reads "not configured". A custom endpoint's 402 stays
  `Rejected`; a stranger's status code is not Epicenter's wallet.
- **Post-closure suppression.** Every client is bound to `app.signal`. If the
  App retires during the call, the result is `Closed` and no transcript is
  published. The native runtime completes its Rust work before reporting
  `Closed`, by its own transport's rule; the method's post-call check sits
  beside the client that produced the wait.

The error set is closed:

| Variant | Fields | Means |
| --- | --- | --- |
| `Unavailable` | `provider` | the connection was retired before the call sent |
| `Rejected` | `provider`, `status`, `detail` | the server answered with an error |
| `Unreachable` | `provider`, `cause` | the transport failed |
| `Malformed` | `provider` | the response carried no text |
| `InsufficientCredits` | none | the account gateway answered 402 |
| `Closed` | none | the App retired during the call |

`provider` is `connection.label`. Nothing in the set names an HTTP verb, a
wire, or a vendor, so a second wire can be added later without renaming an
error an application already branches on.

**Chat stays on the SDK.** `transcribe` earns a method because it owns rules.
Chat and one-shot completion call `connection.client.chat.completions.create`
directly and carry no platform rule beyond what the bound client already
enforces. No `connection.chat` is added.

## Consequences

The application resolves the selected row's ordinary blob reference in its
library (ADR-0393) to available audio. A local BlobId uses the app-local store;
an audio URL resolves through the current hosting domain only when it names
explicitly stored remote hosting. The connection proceeds when that reference
resolves to bytes and fails only when it remains unresolved. Resolution creates
no library delivery obligation.
A connection takes audio bytes, not a row ID or attachment handle; it owns
inference rather than storage.
The application retains the output row and refuses late publication after row
deletion or lifetime retirement. Moving these dependencies does not prescribe
which libraries an application's interface exposes.

- `apps/whispering/src/lib/operations/transcribe.ts` becomes a read of
  `app.device.kv`, one `connectionFor`, one explicit blob read using the row
  reference, and one call. The four rules leave the application and are tested
  once, in `packages/app`.
- Vocab dictation becomes `app.account?.connection.transcribe(model, { audio })`
  with no lookup, and gains the four rules it lacks today.
- `matchInferenceTarget` and the storage half of
  `packages/app-shell/src/inference-selections.ts` are deleted; the picker
  keeps its presentation and assembles its list from
  `app.device.connections.getAll()` and `app.account?.connection`.
- `Connection.client` puts the `OpenAI` SDK type on the App's surface, and
  that is accepted: replacing the SDK later is a breaking change to this type.
- An application that wants a fallback destination has to write it itself out
  of parts the platform refuses to supply, which is the intended cost of
  ADR-0363's no-fallback rule.

## Considered alternatives

- **`app.ai.resolve(selection)` returning a `ResolvedTarget` with `source`,
  `label`, `client`, and `model`, then `app.ai.transcribe(target, request)`.**
  Rejected: `ResolvedTarget` is a second representation of a connection
  invented so the verb could take something already looked up, `source` is a
  field for what the path already says, and `app.ai` is the root peer
  ADR-0392 refuses.
- **`app.ai.transcribe(selection, request)` with the lookup inside.**
  Rejected: it is the connection method with an indirection that re-looks-up
  the id, so the exact-destination rule is enforced rather than structural.
- **A `Transcriber` closure the caller receives, carrying its own
  `transcribe`.** Rejected: a closure hides which rules ran and cannot be
  compared, logged, or shown in a picker the way a connection can.
- **A `scope` field on the selection.** Rejected: the id encodes it already
  (ADR-0363), and a second field can disagree with the first.
- **`app.connection(id)` as a root member.** Rejected: it reintroduces a root
  peer for a lookup only selection-driven applications need; a free function
  serves them and costs Honeycrisp nothing.
- **`connection.chat(...)` beside `transcribe`.** Rejected: it starts wrapping
  the SDK for a verb with no platform rule of its own.
- **A `metered` flag on the connection.** Rejected: a 402 can only come from
  a metering deployment, so the account scope is the fact and a flag would be
  a second copy of it.
- **A universal inference registry that resolves a model id across every
  source.** Rejected for ADR-0363's reason: discovery routing can silently
  redirect data and billing when an inventory changes.
