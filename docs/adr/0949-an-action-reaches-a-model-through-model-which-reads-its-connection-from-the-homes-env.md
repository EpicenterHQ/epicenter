# 0949. An action reaches a model through `model()`, which reads its connection from the home's `.env`

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0948](0948-a-value-several-apps-share-goes-in-the-homes-env-which-only-env-reads.md) (shared values through `env()`), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (a connection is a base URL and an optional bearer key), [ADR-0764](0764-reaching-a-model-is-epicenter-ais-alone-in-the-openai-vocabulary.md) (the earlier product's endpoints and `openAiCompatible`), [ADR-0945](0945-an-app-may-answer-http-and-websocket-requests-under-its-address.md) (requests that arrive at an app).
- **Unbuilt:** all of it. The first thing to exist is `model` exported from `@epicenter/app`, over `env()`; Zhongwen's `tutorSays` is its first caller, through the Ollama line alone.

## Context

Zhongwen's tutor is an action that posts to `{endpoint}/chat/completions` and
streams each piece of the reply to its page through `update`. The endpoint and
model come from Zhongwen's own `settings.md`. The page never sees a model's
address or a key.

The owner wants a local Ollama, Epicenter's hosted models, and OpenAI directly
usable at once; wants only their own apps to call them; and wants an app copied
into the home to find the home's model with no setup. They want no fallback
from one provider to another and no spending limits.

Ollama, OpenAI, and Epicenter's hosted API each accept OpenAI chat requests at
a base URL with an optional `Authorization: Bearer` key (ADR-0060), and each
lists its models at `GET /v1/models` (checked against the live home's Ollama).
Epicenter's hosted API is proposed to take an API key the owner makes on its
dashboard and to name each model with its vendor, `openai/gpt-5.5`, so one
connection reaches several vendors.

## Decision

**A connection is two lines in the home's `.env`: `<NAME>_BASE_URL` and, when
the provider needs one, `<NAME>_API_KEY`. A model's name is
`<connection>/<id>`. `MODEL` names the home's default. `model(name?)` turns a
name into plain data: the base URL, the id, and the key.**

```txt
# <home>/.env
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
EPICENTER_BASE_URL=https://api.epicenter.so/v1
EPICENTER_API_KEY=ep_...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
MODEL=epicenter/openai/gpt-5.5
```

```ts
import { model } from '@epicenter/app';

const chosen = model(); // MODEL; or model('ollama/qwen3.5:9b')
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

- A name splits at the first `/`: `ollama/qwen3.5:9b`,
  `epicenter/openai/gpt-5.5`, `ollama/hf.co/org/name`. The connection's
  `.env` names are its part upper-cased, so a connection's name is lowercase
  letters and digits.
- `model()` reads the lines through `env()` when called, so an edit takes
  effect on the next call. It returns an error, and sends nothing, when
  `MODEL` or the connection's `_BASE_URL` is missing; the error names the line
  to add. A missing `_API_KEY` sends no key, and the provider's refusal is the
  error.
- Nothing is built in. Every address a prompt can go to is a line in `.env`.
  `epicenter init` writes the Ollama line, commented out, and connecting the
  home to Epicenter's hosted API writes its two lines.
- An app that wants another model passes its name, from a constant or its own
  settings. An app that must reach an address the home has no connection for
  keeps that address and key in its own `local/`.
- `apiKey` came through `env()`. The action sends the request itself, with
  the global `fetch` or a client library. Bun's `fetch` drops `Authorization`
  when a redirect leaves the origin (checked on Bun 1.4.3).
- A provider that is not answering fails that call. Nothing tries another.
- No route is added to serve. A model request leaves the home from inside an
  action, and its reply reaches the page through `update`; nothing needs to
  arrive.

## Consequences

- An app copied into any home calls that home's default with no setup. It
  promises a chat model, not that every model supports every request: an app
  that needs tools, images, or a provider-specific parameter names its own
  model or reports what the default lacks.
- Changing `MODEL` changes every app that names none, including whether a
  prompt stays on this computer. The change is in an ignored file, so Git's
  history does not show it.
- Zhongwen loses its `endpoint` and `model` settings, so an agent that can
  change an app's settings over MCP can no longer send its prompts to an
  address the owner did not write.
- The `openai` package fits:
  `new OpenAI({ baseURL, apiKey: apiKey ?? 'none' })`. The action always
  passes `apiKey`, because the package otherwise reads `OPENAI_API_KEY` from
  `process.env`.
- Whispering, outside the home, holds its own Epicenter key and calls the
  hosted API directly; the home holds another. Revoking one leaves the other.
- Outside tools (Cursor, a phone chat app) cannot reach the home's models. If
  one needs to, a thin route through ADR-0945 can call `model()`.
- A list of the home's models for a picker can come later, from each
  connection's `GET /v1/models`, when a page needs one.

## Considered alternatives

- **Built-in addresses for `ollama`, `openai`, and `epicenter`,** overridable
  by `_BASE_URL`, as LiteLLM and aider do for a hundred vendors. A key alone
  would send prompts to an address the file does not show, and the table
  grows. A home has one owner and a few connections; `init` and connecting
  write the lines instead.
- **Connections in `EPICENTER.md`,** committed, so history shows where
  prompts go. `EPICENTER.md` accepts only `port` today and is read once, an
  older CLI refuses a home that adds a field, and a one-line JSON object is
  hard to edit by hand. An address like `127.0.0.1:11434` is a fact about
  this computer, like the key beside it.
- **One connection only** (`MODEL_BASE_URL`, `MODEL_API_KEY`). Smallest, and
  the owner wants Ollama and Epicenter's models at once.
- **A `models` app answering OpenAI requests under `/models/.http/v1`.** Every
  app that calls a model would depend on it at run time, and each reply would
  cross serve twice.
- **LiteLLM beside serve.** One more program to install, keep running, and
  give its own keys and port.
- **Each app keeps its own endpoint and key** (Zhongwen today). A copied app
  needs setup.
- **Return a guarded `fetch`** that sends only to the base URL. Any action can
  read a key through `env()`, so the guard catches mistakes, not misuse, and
  is a second fetch contract to learn.
- **`epicenter login` with a device grant for the hosted provider.** The
  hosted side is dropping its device grant, and a home would store and
  refresh a token. A revocable API key in `.env` needs neither.
