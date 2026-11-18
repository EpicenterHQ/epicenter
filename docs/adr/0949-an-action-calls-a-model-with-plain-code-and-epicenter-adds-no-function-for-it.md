# 0949. An action calls a model with plain code, and Epicenter adds no function for it

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0943](0943-epicenters-core-invariants.md) (rule 6: Epicenter does only what needs an app's declaration or the running serve), [ADR-0950](0950-api-epicenter-so-is-a-model-api-and-every-client-reaches-it-with-an-api-key.md) (Epicenter's hosted model API and its `ep_` keys), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (an app's own secrets), [ADR-0945](0945-an-app-may-answer-web-requests-at-its-address-with-fetch.md) (requests that arrive at an app).

## Context

An action is TypeScript that Bun runs. A model on this computer answers at an
address that is the same on every computer, and Epicenter's hosted API has one
public address (ADR-0950). The one fact an app's committed code cannot hold is
a key, and Bun already loads a `.env` from the folder a process starts in.

Earlier drafts of this record, and of a companion numbered 0948, gave apps an
`env()` reader and then a `model(name)` function over connections listed in
the Epicenter's `.env`. The last was built and reviewed (#2702). Each put a
lookup between an action and three values it could have written down.

## Decision

**An action calls a model with the code anyone would write. Epicenter exports
nothing for it and reads no file for it.**

```ts
import OpenAI from 'openai';

const local = new OpenAI({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' });

const hosted = new OpenAI({
	baseURL: 'https://api.epicenter.so/v1',
	apiKey: process.env.EPICENTER_API_KEY,
});
```

```txt
# .env at the top of the Epicenter, which .gitignore keeps out of Git
EPICENTER_API_KEY=ep_...
```

A reply reaches the page through `update`, as any action's progress does.

## Consequences

- Reading an action shows where its prompts go.
- Serve has the key because Bun loaded `.env` when serve started there. Every
  program serve or an app starts has it too, and an edit counts after a
  restart.
- An Epicenter has no `env = false` in a `bunfig.toml`.
- Moving an app between a local model and a hosted one is an edit to that
  app.
- A helper can come when two apps repeat the same lines and one gets them
  wrong.

## Considered alternatives

- **`model(name)` over connections in `.env`, read by serve as each run
  begins and kept out of `process.env`.** Built and withdrawn (#2702): a
  function, a field on the run's context, a naming rule, and an action whose
  address was no longer in its code.
- **A table of provider addresses, built in or in `EPICENTER.md`.** An
  Epicenter has one owner and two addresses.
- **A `models` app, or LiteLLM beside serve.** Something else to run, between
  an action and a request it can make itself.
