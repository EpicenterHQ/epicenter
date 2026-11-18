# 0949. An action calls a model with plain code, and Epicenter adds no function for it

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0948](0948-a-secret-the-owner-pastes-goes-in-the-homes-env-and-serve-starts-with-it-in-its-environment.md) (where a key comes from), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (a connection is a base URL and an optional bearer key), [ADR-0950](0950-api-epicenter-so-is-a-model-api-and-every-client-reaches-it-with-an-api-key.md) (Epicenter's hosted model API and its `ep_` keys), [ADR-0764](0764-reaching-a-model-is-epicenter-ais-alone-in-the-openai-vocabulary.md) (the earlier product's endpoints and `openAiCompatible`), [ADR-0945](0945-an-app-may-answer-http-and-websocket-requests-under-its-address.md) (requests that arrive at an app).
- **Built:** nothing to build. Zhongwen's `tutorSays` already calls a local model this way. The hosted gateway takes `ep_` keys only once ADR-0950 is built.

## Context

Zhongwen's tutor is an action that posts to an OpenAI-compatible
`/chat/completions` and streams each piece of the reply to its page through
`update`. The page never sees a model's address or a key.

The owner wants a local Ollama and Epicenter's hosted models, wants only their
own apps to call them, and wants no fallback from one provider to another and
no spending limits.

A local Ollama's address is the same on every computer that runs one,
`http://127.0.0.1:11434/v1`, and it accepts any key. Epicenter's hosted API
has one address, `https://api.epicenter.so/v1`, and names each model with its
vendor, `openai/gpt-5.5`, so one key reaches several vendors (ADR-0950).
Neither address is a secret. The one fact that cannot be written in an app's
committed code is the hosted key.

Earlier drafts of this record gave apps a `model(name)` function over a list
of connections: first a built-in provider table with fields in `EPICENTER.md`,
then `<NAME>_BASE_URL` and `<NAME>_API_KEY` lines in the home's `.env`. The
last was built and reviewed (#2702). Each draft put a lookup between an action
and three values it could have written down.

## Decision

**An action calls a model with the code anyone would write: an address and a
model's id in the app's own code, and a key, where one is needed, from
`process.env` (ADR-0948). Epicenter exports nothing for it.**

```ts
import OpenAI from 'openai';

// A model on this computer: nothing secret, nothing to set up.
const local = new OpenAI({
	baseURL: 'http://127.0.0.1:11434/v1',
	apiKey: 'ollama',
});

// Epicenter's hosted models: one line in the home's .env.
const apiKey = process.env.EPICENTER_API_KEY;
if (!apiKey) return TutorError.NoAnswer({ message: 'Set EPICENTER_API_KEY ...' });
const hosted = new OpenAI({ baseURL: 'https://api.epicenter.so/v1', apiKey });

const stream = await hosted.chat.completions.create({
	model: 'openai/gpt-5.5',
	messages,
	stream: true,
});
for await (const chunk of stream) update(chunk.choices[0]?.delta?.content ?? '');
```

- The app's code says where its prompts go. Reading the action is how the
  owner, or an agent, learns it.
- An app that lets its owner choose keeps the address or the model's id in
  its own settings, as Zhongwen does.
- A model that is not answering fails that call, and the app reports it in
  its own words: a local server that is not running refuses the connection
  at once. Nothing tries another provider.
- An action that uses the `openai` package always passes `baseURL` and
  `apiKey`. The package otherwise reads `OPENAI_BASE_URL` and
  `OPENAI_API_KEY` from `process.env`.
- No route is added to serve. A model request leaves the home from inside an
  action, and its reply reaches the page through `update`; nothing needs to
  arrive.

## Consequences

- An app copied into another home calls a local model with no setup, and a
  hosted one once that home's `.env` has the key. Its error names the
  variable.
- Moving an app from a local model to a hosted one is an edit to that app's
  code or settings. No one line moves every app, and Git's history shows each
  move.
- Each app that calls a model repeats a few lines. A shared helper can come
  when two apps repeat the same lines and one of them gets them wrong.
- Whispering, outside the home, holds its own Epicenter key and calls the
  hosted API directly; the home holds another. Revoking one leaves the other.
- Outside tools (Cursor, a phone chat app) cannot reach a model through the
  home. They take their own key to the hosted API.

## Considered alternatives

- **`model(name)` over connections listed in the home's `.env`,** with a
  `MODEL` default. Built, reviewed, and withdrawn (#2702). It let one line
  move every app between local and hosted, and gave a missing line a named
  error. It cost a function, a field on the run's context, a naming rule,
  and an action whose address was no longer in its code.
- **A built-in table of provider addresses,** as LiteLLM and aider keep for a
  hundred vendors. A home has one owner and two addresses.
- **Connections in `EPICENTER.md`.** Committed, so history shows where
  prompts go, and it carries one computer's addresses to every other.
- **A `models` app answering OpenAI requests under `/models/.http/v1`.** Every
  app that calls a model would depend on it at run time, and each reply would
  cross serve twice.
- **LiteLLM beside serve.** One more program to install, keep running, and
  give its own keys and port.
- **Run the model inside serve.** A local model's weights would sit in the
  process that runs every app, behind a native build.
- **`epicenter login` with a device grant for the hosted provider.** ADR-0950
  removes the device grant, and a home would store and refresh a token. A
  revocable API key needs neither.
