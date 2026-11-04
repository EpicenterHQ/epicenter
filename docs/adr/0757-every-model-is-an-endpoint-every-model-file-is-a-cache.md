# 0757. Every model is an endpoint; every model file is a cache

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) at its AI worked example: `openAi({ account, local })` with `ai.hosted()`, `ai.local()` and `ai.custom()` becomes `openAi([...endpoints])`, the default order is the array's order rather than local, hosted, custom, and a management handle exists only for a source with a local lifecycle.
- **Relates:** [ADR-0730](0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md) (a cache is one of the five stored kinds), [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (provider keys live in the app's credentials file, and the shell sends keyed requests), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (programs meet in a shared place; the moments local servers are probed), [ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md) (local inference behind the OpenAI-compatible seam), [ADR-0424](0424-runtime-transcription-calls-the-host-directly.md) (runtime transcription calls the host directly), [ADR-0758](0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md) (Epicenter adapts to what you already have).
- **Unbuilt:** all of it: `openAi([...])`, the endpoint interface, per-model capabilities, `openAiCompatible`, `hosted`, `custom` and `localServers` in `@epicenter/ai`; one desktop relay in place of `apps/whispering/src-tauri/src/http.rs` and `packages/tauri-epicenter-account/src/relay.rs`; the accessor through which `@epicenter/account` hands over the person's provider keys; `@epicenter/transcription` exporting `localSpeech()` in place of `@epicenter/transcription-native`, with remove, load and unload beside download.

## Context

`@epicenter/ai` (`packages/ai`) reaches a model through constructors an app
calls one by one. `openEpicenterInference({ account })` in
`packages/ai/src/ai.ts` opens hosted inference at the account's `/v1`;
`openEndpointInference({ baseURL, getAuthHeaders })` opens any
OpenAI-compatible server; `createAiConnections` in
`packages/ai/src/ai-connections.ts` keeps the person's own connections, each
a `baseUrl`, an optional `apiKey`, and a list of `models`. Ollama and LM
Studio are presets in `packages/ai/src/openai/connection-presets.ts`
(`http://localhost:11434/v1` and `http://localhost:1234/v1`): form defaults
a person fills in by hand.

Epicenter's hosted inference already speaks the same vocabulary: the server
serves `<origin>/v1/chat/completions` and `<origin>/v1/audio/transcriptions`
(`ai` in `packages/server/src/api-routes.ts`), so any OpenAI-compatible
client pointed at `<origin>/v1` works unchanged.

On the desktop, keyed requests leave through two relays: Whispering's
`apps/whispering/src-tauri/src/http.rs` (257 lines) and the account crate's
`packages/tauri-epicenter-account/src/relay.rs`. Whispering routes each
provider itself in `apps/whispering/src/lib/platform/browser.ts` and
`apps/whispering/src/lib/platform/services.tauri.ts`, about 620 lines
between them.

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
app's array is the default order. `ai.subscribe(fn)` fires when any
endpoint's models change, and `ai.complete(request)` sends the request
through the chosen model's endpoint.

**Requests use one vocabulary, the OpenAI-compatible one: chat completions,
audio transcriptions, and embeddings.** Each model says which of these it
can do (`chat`, `transcribe`, `embed`); an endpoint implements a subset.

| Endpoint | Implements |
| --- | --- |
| Epicenter's hosted inference | chat, transcription |
| Ollama | chat, embeddings |
| a Speaches server | transcription |
| transcribe.cpp (`localSpeech()`) | transcription |

**An endpoint is an interface, not a URL, and there are two
implementations.**

```ts
type Endpoint = {
  id: string;
  models(): Model[];          // each with what it can do: chat, transcribe, embed
  complete(request): Reply;   // a chat, transcription, or embeddings request
  subscribe(fn): () => void;
};
```

| Implementation | Transport | Configurations |
| --- | --- | --- |
| `openAiCompatible({ url, credential })` | HTTP, through `@epicenter/ai/openai` | `hosted(account)`: the account's `<origin>/v1` with its bearer; `custom(key)`: a provider's URL with the person's key; `localServers()`: `localhost:11434` (Ollama) and `localhost:1234` (LM Studio), with none |
| `localSpeech()` | in-process Tauri commands | transcribe.cpp over the transcription catalog's models |

`hosted`, `custom` and `localServers` are configurations of
`openAiCompatible`, not implementations. One HTTP client serves all three.
On the desktop its requests go through the shell's one fetch, which adds
the key, so keys stay out of the page
([ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md));
Whispering's `http.rs` and the account crate's `relay.rs` become that one
relay.

**`localSpeech()` is separate for two reasons only.**

- Its transport: it runs inside the app, so it has no URL and no port, and
  only the app's own window can call it, through Tauri's permissions.
  Ollama, by contrast, listens on `localhost:11434` for any program on the
  computer.
- Its local lifecycle: download, remove, load, and unload a model, which
  the OpenAI vocabulary cannot express.

**A management handle exists only for a source with a local lifecycle.**
`localSpeech()` carries download, remove, load, and unload; an app that
offers them keeps the endpoint in a `const` and passes the same value into
the array. `hosted(account)` and `custom(key)` carry none: a key is added or
removed through the keys `@epicenter/account` holds, and the plan and usage
are read from the account.

**`localServers()` probes this computer only.** It probes both ports
asynchronously at the sync moments of
[ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md)
and when the model picker opens. A server's models appear when a probe finds
it and leave when a probe no longer does, and each change fires
`ai.subscribe`. A server on another machine is a `custom(key)` endpoint
with its URL.

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
one shared speech server runs an existing one, such as Speaches or
whisper.cpp's server, and adds it as a `custom(key)` endpoint.

## Consequences

- An Ollama or LM Studio model appears in every app's picker without a form,
  at the first sync moment or picker opening after the server starts.
- Adding a source is one more array entry. An app that does no
  transcription leaves out `localSpeech()` and ships no transcribe.cpp.
- A probe is two requests to localhost at each moment. A computer with
  neither server running pays two refused connections.
- A picker filters by what a model can do: Whispering's transcription
  picker lists `transcribe` models from every endpoint, and a chat picker
  lists `chat` models.
- Whispering's per-provider routing in `browser.ts` and `services.tauri.ts`
  collapses into its `openAi([...])` array.
- Remove deletes a model file from a cache other Hugging Face tools share,
  where the transcription plugin today never deletes; another tool that
  used the file downloads it again.
- Two apps that run local speech at once each load the model into their own
  memory.
- The hosted source is present and empty when signed out, where ADR-0754
  made it `null`. A settings screen explains an empty hosted list from
  `account.current()`.
- `docs/guides/self-hosted-transcription-speaches.md` still names
  `@epicenter/client`, which merged into `@epicenter/ai`; it is rewritten
  with the endpoint work, where a Speaches server is a `custom(key)`
  endpoint.

## Considered alternatives

- **A handle per source (ADR-0754's `hosted()`, `local()`, `custom()`).** A
  local server is a fourth kind with no handle, and each new kind adds a
  method to `ai`.
- **An implementation per provider.** Hosted inference, a provider key, and
  Ollama already speak one vocabulary; three clients would differ only in a
  URL and a credential.
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
