# Agent loop

`@epicenter/ai/agent` is the UI-free agent loop. It takes values: a contract's messages collection, the chat it is, `ai`, the model, the system prompt, and the tools as an array.

```ts
import { createConversation, messagesCollection } from '@epicenter/ai/agent';

// The app's contract: `messages: messagesCollection`, one note per finished
// message at `messages/{chat}/{id}.md`.
const conversation = createConversation({
	messages: client.messages,
	chat: chatId,
	ai,
	model: () => choices.get('chat'),
	system: (transcript) => (transcript.length === 0 ? OPENING : PROMPT),
	tools: [{ name: 'lookup', description: 'Look a word up', input, run }],
	approve: (call, tool) => askThePerson(call, tool),
	prepare: (messages) => messages, // change what each step sends, such as an opening turn
});
```

The conversation has the shape every capability has: `snapshot()` reads, `send`, `stop`, `retry` and `save` answer promises, and `subscribe` hears a change. Svelte reads it through `reactive` from `@epicenter/svelte/reactive`, where `conversation.snapshot()` tracks.

## Tools

A tool is `{ name, description, input, mutates?, run }`. The tools offered are the array: leaving a tool out is how it is denied, and a call naming one not offered runs nothing. A tool that `mutates` runs only once `approve` answers yes; with no `approve`, it is refused. A tool's `run` that rejects ends the turn, as a failed stream does.

## Saving messages

Each finished message is its own note, created under its id. A note already there holding the same message counts as saved; another message at that id is refused. `Ok` from the collection is the promise that the message is saved. The loop asks once per message and never retries on its own, because a failed or thrown write may still have landed.

- `send(text)` saves the learner message first and resolves with that outcome. The model runs only after `Ok`. A `stop()` or disposal during the write lets the write finish and starts no turn.
- A turn that finishes cleanly saves its messages in order. A stopped or failed stream saves nothing.
- A message the collection did not confirm stays in `snapshot().unsaved` under its id, with the reason in `saveError`. It also appears once in `messages`, even when the collection lists the message before confirming it.
- `save()` writes `unsaved` again. It runs no model and no tool, and skips messages already confirmed.
- `send` and `retry` do nothing while a write is in flight or a message is unsaved. `send` reports that as `NotAdmitted`.
- Disposal stops following the collection; writes already in flight still land.

`error` in the snapshot is the model turn's failure; `saveError` is the collection's. They are retried separately: `retry()` runs the model, `save()` writes to the collection. A note of the chat that does not read is listed in `unreadable` and never sent to the model.
