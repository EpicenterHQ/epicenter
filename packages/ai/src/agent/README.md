# Agent loop

`@epicenter/ai/agent` is the UI-free agent loop. It takes values: a contract's messages collection, the chat it is, `ai`, the model, the system prompt, and the tools as an array.

The collection is the app's folder's (`folder.messages`). The loop reads the chat's transcript from what the folder shows (`items()`, `invalid()`, `loading()`), saves with `set`, and listens with `subscribe`, which starts the folder's listing (`ConversationMessages`). It keeps no copy of the saved transcript: the folder lists the collection once per change and shows a saved message before its `set` answers.

```ts
import { createConversation, messagesCollection } from '@epicenter/ai/agent';

// The app's contract: `messages: messagesCollection`, one note per finished
// message at `messages/{chat}/{id}.md`. `folder` is the app's folder
// (`openFolder` from `@epicenter/folder`).
const conversation = createConversation({
	messages: folder.messages,
	chat: chatId,
	ai,
	model: () => choices.get('chat'),
	system: (transcript) => (transcript.length === 0 ? OPENING : PROMPT),
	tools: [{ name: 'lookup', description: 'Look a word up', input, run }],
	approve: (call, tool) => askThePerson(call, tool),
	prepare: (messages) => messages, // change what each step sends, such as an opening turn
});
```

The conversation has the shape every capability has: `snapshot()` reads, `send`, `stop` and `retry` answer promises, and `subscribe` hears a change. Svelte reads it through `reactive` from `@epicenter/svelte/reactive`, where `conversation.snapshot()` tracks.

## Listing

`ready` settles once the folder's first listing of the collection lands, or once the conversation is disposed. A listing that cannot reach the store does not settle it: the folder tries again, and `ready` waits. `snapshot().listed` turns true at the same moment and stays true.

Until the chat is listed, the transcript may be missing saved messages, so the model is not asked. A turn started by `send` or `retry` waits for the listing, then runs over the saved transcript; the person does not send again. A `stop()` or disposal during that wait ends the turn without asking the model, with the snapshot `error` code `Unlisted`.

## Tools

A tool is `{ name, description, input, mutates?, run }`. The tools offered are the array: leaving a tool out is how it is denied, and a call naming one not offered runs nothing. A tool that `mutates` runs only once `approve` answers yes; with no `approve`, it is refused. A tool's `run` that rejects ends the turn, as a failed stream does.

## Saving messages

Each finished message is its own note, saved with `set` under its id. `set` never fails: while the store cannot be reached, the folder keeps the write, with every later one, in the order they were made, and tries again (ADR-0775). Whether the store can be reached, and why not, is the folder's to say (`folder.unavailable()`, `folder.saving()`), so the conversation has no save error and no save action of its own. It asks the folder once per message.

- `send(text)` hands the learner message to the folder and answers `Ok` at once. The message shows in `snapshot().messages` from then: first as handed over, then as the folder lists it, never twice. The turn starts in the background and waits for the listing (see Listing), not for the message to land.
- A turn that finishes cleanly hands its messages to the folder in order, after the learner message, and frees the conversation at once. They show from then, like the learner message. A stopped or failed stream saves nothing.
- The next `send` does not wait for the answer to land: the turn reads the messages handed over, and the folder lands the new message after them.
- `send` and `retry` do nothing while a turn runs. `send` reports that as `NotAdmitted` with the reason `busy`; an empty message is `empty`, and one after disposal is `disposed`.
- `stop()` aborts the model and answers once the turn has ended. An answer already fully received is not discarded; it lands when the folder can write it.
- Disposal stops following the collection; writes already handed to the folder still land.

`error` in the snapshot is the model turn's failure; `retry()` runs the turn again. A note of the chat that does not read is listed in `unreadable` and never sent to the model.
