# 0949. An action reaches a model through `model()`, and the home names its default in `EPICENTER.md`

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0948](0948-a-credential-the-owner-pastes-goes-in-the-homes-env-which-only-env-reads.md) (keys through `env()`), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (a connection is a base URL and an optional bearer key), [ADR-0764](0764-reaching-a-model-is-epicenter-ais-alone-in-the-openai-vocabulary.md) (the earlier product's endpoints and `openAiCompatible`), [ADR-0945](0945-an-app-may-answer-http-and-websocket-requests-under-its-address.md) (requests that arrive at an app), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (`EPICENTER.md`), [ADR-0924](0924-front-matter-is-key-json-lines-each-read-on-its-own-and-no-yaml-is-read.md) (front matter is `key: <JSON>`).
- **Unbuilt:** all of it. The first thing to exist is `model` exported from `@epicenter/app`, and `markerProblems` in `packages/cli/src/root.ts` accepting a `model` field; Zhongwen's `tutorSays` is its first caller.

## Context

Zhongwen's tutor is an action that posts to `{endpoint}/chat/completions` and
streams each piece of the reply to its page through `update`. The endpoint and
model come from Zhongwen's own `settings.md`, defaulting to Ollama on
`127.0.0.1:11434`. The page never sees a model's address or a key.

The owner wants local models and cloud providers, wants only their own apps to
call them, and wants an app copied into the home to find the home's model with
no setup. They want no fallback from one provider to another, no spending
limits, and no setup from a phone.

Ollama, LM Studio, OpenAI, and Anthropic each accept OpenAI chat requests at a
base URL with an optional `Authorization: Bearer` key (ADR-0060). They differ
past that: Anthropic's compatibility layer ignores some parameters, and
Zhongwen sends `reasoning_effort: 'none'` for a local reasoning model.

A `models` app answering OpenAI requests for the others would make every app
that calls a model depend on another app being present. An app copied into a
home without it would break.

## Decision

**Serve gives each run `model(name?)`, exported from `@epicenter/app`. It
turns a model's name into plain data: the provider's base URL, the model's id
there, and the provider's key from `env()`, if it has one.**

```ts
import { model } from '@epicenter/app';

const chosen = model(settings?.model); // undefined uses the home's default
if (chosen.error) return chosen;
const { id, baseURL, apiKey } = chosen.data;
const response = await fetch(`${baseURL}/chat/completions`, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		...(apiKey && { authorization: `Bearer ${apiKey}` }),
	},
	body: JSON.stringify({ model: id, messages, stream: true }),
	signal,
});
```

- A model's name is `<provider>/<id>`, split at the first `/`:
  `ollama/qwen3`, `openai/gpt-5.5`, `ollama/hf.co/org/name`.
- The home's default is the `model` field of `EPICENTER.md`, beside `port`:
  `model: "ollama/qwen3"`. It is read when `model()` is called, so an edit
  takes effect on the next call. With no field and no name, `model()` returns
  an error naming the field to add.
- An app may name its own model in its own settings and pass it to `model()`.
- `model()` knows a fixed table of providers:

  | Provider | Base URL | Key, through `env()` |
  | --- | --- | --- |
  | `ollama` | `http://127.0.0.1:11434/v1` | none |
  | `lmstudio` | `http://127.0.0.1:1234/v1` | none |
  | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
  | `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |

- `model()` returns an error, and sends nothing, for an unknown provider or a
  key `env()` cannot give.
- `apiKey` came through `env()`, so ADR-0948's rule covers it: an action
  never returns, throws, or yields it.
- `apiKey` is absent for a keyless provider. The action sends the request
  itself, with the global `fetch` or a client library. Bun's `fetch` drops
  `Authorization` when a redirect leaves the origin (checked on Bun 1.4.3).
- A provider that is not answering fails that call. Nothing tries another
  provider.
- No route is added to serve. A model request leaves the home from inside an
  action; nothing needs to arrive.
- Tests give a run a fake `model`, as they give it a `folder`.

## Consequences

- An app copied into any home calls that home's default with no setup. It
  promises a chat model, not that every model supports every app's request:
  an app that needs tools, images, or a provider-specific parameter names its
  own model or reports what the default lacks.
- Changing the default in `EPICENTER.md` changes every app that names none,
  including whether a prompt stays on this computer or goes to a cloud
  provider.
- An agent that can change an app's settings over MCP can move that app from
  `ollama/...` to `openai/...`. It can only choose among the table's
  providers, where today a free-form `endpoint` lets it choose any address.
- The `openai` package fits: `new OpenAI({ baseURL, apiKey: apiKey ?? 'none' })`.
  The action always passes `apiKey`, because the package otherwise reads
  `OPENAI_API_KEY` from `process.env` and would send a key exported in
  serve's shell to a keyless local server. Zhongwen may then drop its 60
  lines of stream parsing once its failure and saving behavior is kept.
- Nothing stops an action from sending a key to the wrong server. Any action
  can read a key through `env()` anyway, so a guard inside `model()` would
  only catch mistakes, and the action's own code is where those are made
  and read.
- A new provider, or a second Ollama on another computer, needs a new
  release of `@epicenter/app`. Nobody needs one yet. A keyless provider at
  another address exposes no key, so it can be added when someone does.
- Epicenter's hosted models are not in the table. They join when the hosted
  service issues an API key the owner can create and revoke; it has none
  today, and the CLI signs in by device grant as `so.epicenter.cli`.
- Outside tools (Cursor, a phone chat app) cannot reach the home's models. If
  one needs to, a thin route through ADR-0945 can call `model()`.

## Considered alternatives

- **A `models` app answering OpenAI requests under `/models/.http/v1`.** Its
  routing would be editable home code, and outside tools could use it. Every
  app that calls a model would depend on it at run time, a copied app would
  break in a home without it, and each reply would cross serve twice.
- **LiteLLM beside serve.** It already routes by name, and it is one more
  program to install, keep running, and give its own keys and port.
- **Each app keeps its own endpoint and key** (Zhongwen today). Nothing is
  shared, and a copied app needs setup.
- **Return a guarded `fetch`** that sends only to the provider's base URL,
  refuses redirects, and sets `Authorization` itself, as `openAiCompatible`
  in `packages/ai` does. It catches a library sending a key to the wrong
  server, and it is a second fetch contract to learn for a guard that is
  not a boundary.
- **A higher-level `text({ messages, onDelta })`.** It would hide streaming
  from every app, and would have to grow tools, images, and embeddings. The
  base URL and key already serve all of them.
- **`{ connection, model }` pairs instead of a prefix.** Equivalent, and two
  values where one string fits a settings field.
- **A `providers` field in `EPICENTER.md`** naming a base URL and a key
  variable. Nobody needs one yet. A committed file pairing a key with any
  address is also a quiet way to send a key somewhere new.
- **`epicenter login` with a device grant for the hosted provider.** The
  hosted side has it, and every home would store and refresh a token and
  handle sign-out races. An API key through `env()` needs none of that.
