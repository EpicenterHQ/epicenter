# 0757. Every model is an endpoint; every model file is a cache

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) at its AI worked example: `openAi({ account, local })` with `ai.hosted()`, `ai.local()` and `ai.custom()` becomes `openAi([...endpoints])`, the default order is the array's order rather than local, hosted, custom, and a management handle exists only for a source with a local lifecycle.
- **Relates:** [ADR-0730](0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md) (a cache is one of the five stored kinds), [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (provider keys live in the app's credentials file, and the shell sends keyed requests), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (programs meet in a shared place; the sync moments), [ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md) (local inference behind the OpenAI-compatible seam), [ADR-0424](0424-runtime-transcription-calls-the-host-directly.md) (runtime transcription calls the host directly), [ADR-0758](0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md) (Epicenter adapts to what you already have), [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (Epicenter is made of standards and places).
- **Unbuilt:** all of it: `openAi([...])`, the endpoint shape `{ id, fetch, models() }`, per-model capabilities, `hosted`, `custom` and `localServers` in `@epicenter/ai`; one desktop relay in place of `apps/whispering/src-tauri/src/http.rs` and `packages/tauri-epicenter-account/src/relay.rs`; the accessor through which `@epicenter/account` hands over the person's provider keys; `@epicenter/transcription` exporting `localSpeech()`, with its in-process fetch and its remove, load and unload beside download, in place of `@epicenter/transcription-native`.

## Context

`@epicenter/ai` (`packages/ai`) reaches a model through constructors an app
calls one by one. `openEpicenterInference({ account })` in
`packages/ai/src/ai.ts` opens hosted inference at the account's `/v1` with
`account.fetch`; `openEndpointInference({ baseURL, getAuthHeaders })` opens
any OpenAI-compatible server; `createAiConnections` in
`packages/ai/src/ai-connections.ts` keeps the person's own connections, each
a `baseUrl`, an optional `apiKey`, and a list of `models`. Ollama and LM
Studio are presets in `packages/ai/src/openai/connection-presets.ts`
(`http://localhost:11434/v1` and `http://localhost:1234/v1`): form defaults
a person fills in by hand.

Each source already reaches its server through a Fetch API function.
`Account.fetch` attaches the account's bearer (`packages/account/README.md`).
On the desktop, `connectionFetch(id)` from `@epicenter/account/tauri` is the
`fetch` of one connected endpoint: the shell adds the key and sends only to
that endpoint, so the page never holds it. Epicenter's hosted inference
speaks the OpenAI-compatible vocabulary: the server serves
`<origin>/v1/chat/completions` and `<origin>/v1/audio/transcriptions` (`ai`
in `packages/server/src/api-routes.ts`).

On the desktop, keyed requests leave through two relays: Whispering's
`apps/whispering/src-tauri/src/http.rs` (257 lines) and the account crate's
`packages/tauri-epicenter-account/src/relay.rs`. Whispering routes each
provider itself in `apps/whispering/src/lib/platform/browser.ts` and
`apps/whispering/src/lib/platform/services.tauri.ts`, 624 lines between
them.

Local transcription is a separate package with a separate shape.
`@epicenter/transcription-native`
(`packages/tauri-plugin-epicenter-transcription`) runs transcribe.cpp inside
the app's process through Tauri commands, with no HTTP. Its fixed catalog
(`src/transcription/catalog.rs`) pins three GGUF models by Hugging Face
commit and content hash, downloads them into the shared Hugging Face cache
(`~/.cache/huggingface/hub`, or `HF_HOME`), reuses a file another tool
already fetched, and never deletes from that cache.

[ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md)
gave AI one composed value, `openAi({ account, local })`, with a handle per
source: `ai.hosted()`, `ai.local()` and `ai.custom()`, in the default order
local, hosted, custom. A local server such as Ollama fits none of the three.

## Decision

**Every source of models is an endpoint, and `openAi` merges the endpoints
an app passes as an array.**

```ts
import { custom, hosted, localServers, openAi } from '@epicenter/ai';
import { localSpeech } from '@epicenter/transcription';

export const ai = openAi([
  hosted(account),     // Epicenter's models; lists none until signed in
  ...keys.map(custom), // one endpoint per provider key the person added
  localServers(),      // Ollama and LM Studio on this computer, when running
  localSpeech(),       // transcribe.cpp in this app's process; null on the web
]);
```

`openAi` skips a `null` entry, so the web build passes the same array.
`ai.models()` lists every endpoint's models in the array's order, so the
app's array is the default order. `ai.complete(request)` sends the request
through the chosen model's endpoint, and `ai.subscribe(fn)` fires when the
merged list changes.

**An endpoint is `{ id, fetch, models() }`, where `fetch` is a Fetch API
function.**

```ts
type Endpoint = {
  id: string;
  fetch: typeof globalThis.fetch;   // answers the OpenAI-compatible paths
  models(): Promise<Model[]>;       // each with what it can do: chat, transcribe, embed
};
```

**Requests use one vocabulary, the OpenAI-compatible one: chat completions,
audio transcriptions, and embeddings.** `@epicenter/ai` has one client,
which posts OpenAI-shaped requests through `endpoint.fetch`. Endpoints
differ only in which fetch they carry:

| Endpoint | Its `fetch` | Implements |
| --- | --- | --- |
| `hosted(account)` | `account.fetch`, pointed at the account's `<origin>/v1` | chat, transcription |
| `custom(key)` | on the desktop, the shell's fetch, which adds the key so the page never holds it ([ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md)) | what the provider serves |
| `localServers()` | plain `fetch` to `localhost:11434` (Ollama) and `localhost:1234` (LM Studio) | Ollama: chat and embeddings |
| `localSpeech()` | an in-process fetch that answers `/audio/transcriptions` by calling transcribe.cpp directly: no HTTP, no port | transcription |

A Speaches server or whisper.cpp's server is a `custom(key)` endpoint that
implements transcription. Each model says what it can do (`chat`,
`transcribe`, `embed`), and an endpoint implements a subset of the
vocabulary. Whispering's `http.rs` and the account crate's `relay.rs`
become the one shell fetch behind `custom(key)`.

**`openAi` reads each endpoint's `models()` at the sync moments of
[ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md),
when the model picker opens, and after a `localSpeech()` lifecycle action.**
For `localServers()`, that read is the probe of this computer: a server's
models appear when it answers and leave when it no longer does. A server on
another machine is a `custom(key)` endpoint with its URL.

**`localSpeech()` differs from the others in two ways only.** Its fetch
runs inside the app, so it has no URL and no port, and only the app's own
window can reach it, through Tauri's permissions; Ollama, by contrast,
listens on `localhost:11434` for any program on the computer. And it has a
local lifecycle, download, remove, load and unload a model, which the
OpenAI vocabulary cannot express.

**A management handle exists only for a source with a local lifecycle.**
`localSpeech()` carries download, remove, load and unload; an app that
offers them keeps the endpoint in a `const` and passes the same value into
the array. `hosted(account)` and `custom(key)` carry none: a key is added or
removed through the keys `@epicenter/account` holds, and the plan and usage
are read from the account.

**Model files stay in the shared Hugging Face cache, which is a cache in
[ADR-0730](0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md)'s
sense.** A file any app or Hugging Face tool fetched counts as present for
every app, and a deleted file is downloaded again. Epicenter keeps no model
directory of its own.

**Each app that needs local speech runs its own transcribe.cpp; programs
share model files, not a server.** Programs meet in a shared place, the
cache, and never call each other, as
[ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md)
has them meet in a folder. Whispering embeds transcribe.cpp; the Epicenter
app and Vocab do not. Epicenter builds no model server: a person who wants
one shared speech server runs an existing one and adds it as a
`custom(key)` endpoint.

## Consequences

- An Ollama or LM Studio model appears in every app's picker without a form,
  at the first sync moment or picker opening after the server starts.
- Adding a source is one more array entry. An app that does no
  transcription leaves out `localSpeech()` and ships no transcribe.cpp.
- A test gives an endpoint a stub `fetch`; no mock client or interface is
  needed.
- A probe is two requests to localhost at each moment. A computer with
  neither server running pays two refused connections.
- A picker filters by what a model can do: Whispering's transcription
  picker lists `transcribe` models from every endpoint, and a chat picker
  lists `chat` models.
- Whispering's per-provider routing in `browser.ts` and `services.tauri.ts`
  collapses into its `openAi([...])` array.
- `localSpeech()`'s fetch must parse a multipart transcription request and
  answer in the OpenAI response shape, so transcribe.cpp's options are
  limited to what that shape carries.
- Remove deletes a model file from a cache other Hugging Face tools share,
  where the transcription plugin today never deletes; another tool that
  used the file downloads it again.
- Two apps that run local speech at once each load the model into their own
  memory.
- The hosted source is present and empty when signed out, where ADR-0754
  made it `null`. A settings screen explains an empty hosted list from
  `account.current()`.
<!-- doc-path-check: ignore-next-line (the guide was deleted; the endpoint work writes its replacement) -->
- `docs/guides/self-hosted-transcription-speaches.md` still names
  `@epicenter/client`, which merged into `@epicenter/ai`; it is rewritten
  with the endpoint work, where a Speaches server is a `custom(key)`
  endpoint.

## Considered alternatives

- **A handle per source (ADR-0754's `hosted()`, `local()`, `custom()`).** A
  local server is a fourth kind with no handle, and each new kind adds a
  method to `ai`.
- **A custom endpoint interface with its own `complete(request)`.** Every
  endpoint reimplements the request, where hosted inference, a provider,
  and Ollama already answer the same OpenAI-shaped request over a fetch.
- **An endpoint as a URL.** In-process transcription would open a local
  HTTP port, which can collide with Ollama, LM Studio, or another app's,
  and which any program on the computer could call.
- **Ollama and LM Studio as presets a person fills in (today).** The person
  types an address the app could have probed.
- **Probe the local network.** Requests to other machines the person did
  not name; a remote server is one `custom` entry.
- **Model files in each app's AppData.** Each app downloads its own copy of
  a model already in the Hugging Face cache, and a reset deletes it.
- **A model server Epicenter serves to every app.** A port to assign and
  advertise and a process other apps depend on, where an existing server
  already does the job for a person who wants one.
