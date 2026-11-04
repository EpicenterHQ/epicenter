# Agent loop

`@epicenter/ai/agent` is the UI-free agent loop. It streams an injected inference engine, persists finished messages through an injected by-id store, and discovers and runs capabilities through injected tool catalogs, leaving storage, transport, and presentation ownership to its host.

## Saving messages

The store's one write, `set(id, message)`, returns `Promise<Result<void, AgentMessageStoreError>>`. `Ok` is the store's own promise that the message is saved: a memory store answers at once, and a durable store answers after its storage confirms. The loop asks a store once per message and never retries on its own, because a failed or thrown write may still have landed.

- `send(text)` saves the learner message first and resolves with that outcome. The model runs only after `Ok`. A `stop()` or disposal during the write lets the write finish and starts no turn.
- A turn that finishes cleanly saves its messages in order. A stopped or failed stream saves nothing.
- A message the store did not confirm stays in `snapshot().unsaved` under its id, with the reason in `saveError`. It also appears once in `messages`, even when the store shows the message to readers before confirming it.
- `save()` writes `unsaved` again. It runs no model and no tool, and skips messages the store already confirmed.
- `send` and `retry` do nothing while a write is in flight or a message is unsaved. `send` reports that as `NotAdmitted`.
- Disposal waits for writes already in flight before it disposes the store.

`error` in the snapshot is the model turn's failure; `saveError` is the store's. They are retried separately: `retry()` runs the model, `save()` writes to the store.
