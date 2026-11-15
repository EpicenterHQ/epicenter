# 0879. An action may yield values while it runs, and only its return is the answer

- **Status:** Accepted (2026-11-11)
- **Amended by:** [ADR-0917](0917-a-pages-calls-are-serve-owned-runs-and-observing-is-not-cancelling.md)
- **Date:** 2026-11-11
- **Amended:** 2026-11-11: a UI calls an action at `POST /<app>/<action>`,
  whose response is JSON lines, instead of over MCP with progress
  notifications, and `serve` runs the call itself instead of in a child
  (ADR-0880). The MCP route was built and replaced the same day; see
  Considered alternatives.
- **Built:** 2026-11-11: `run` as an `async function*` and `runYielding`
  (`packages/app/src/action.ts`), `onYield` on the UI client
  (`packages/app/src/client.ts`), and the call's route, its JSON lines, and
  its stop (`packages/cli/src/http.ts`, `run.ts`).
- **Unbuilt:** Vocab's chat, the first action that yields.
- **Relates:** [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a UI calls only actions), [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md) (an action runs where what it uses is), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (a call commits what it wrote), [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP for agents), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (`serve` runs each call itself).

## Context

Vocab's chat sends a message to a model on the Studio's Ollama and shows the
reply. A local 9B model takes a few seconds to answer, and a reply that types
itself out reads as a conversation, where one that appears whole after a pause
reads as a form. The UI cannot call Ollama itself without `serve` proxying a
model to every signed-in device, or Ollama listening on the tailnet with no
sign-in, and either way the prompt, the choice of words, and the saving move
into the browser, where Claude cannot reach them (ADR-0860, ADR-0861).

A spike on 2026-11-11 streamed tokens chosen to break framing (Chinese,
Japanese, an emoji, `\n\n`, `\r\n`, quotes, backslashes, an empty token, a
line reading `data: …`) 15 of 15, as produced, and the text rebuilt from them
equalled the returned reply byte for byte. Against `qwen3.5:9b` on Ollama, 19
and then 44 streamed tokens rebuilt the returned reply exactly.

## Decision

**An action's `run` may be an `async function*`. What it yields goes only to
observers of the page run, as it runs; what it returns is the answer, as now; and
only its writes become app data.** Yields are available to observers of a page
run. CLI and MCP callers receive the returned answer.

```ts
// vocab/epicenter.ts
say: defineAction({
  description: 'Say something in a conversation that uses my words',
  input: { conversation: field.text({ optional: true }), message: field.text() },
  async *run({ conversation, message }) {
    const words = await pickWords();
    let reply = '';
    for await (const token of ollamaChat(prompt(words, conversation, message))) {
      reply += token;
      yield token;
    }
    await saveTurn(conversation, message, reply, words);
    return { reply, wordsUsed: words.filter((word) => reply.includes(word)) };
  },
}),
```

```ts
// vocab/ui
const said = await vocab.chat.say({ message }, { onYield: (token) => (draft += token) });
```

- **A yield is any value that survives JSON, and its shape is the app's.**
  Tokens, `{ step, of }`, a partial list: the action and its UI are written
  together, and the UI's client is typed by the app (ADR-0857), so the
  yield's type reaches `onYield` as the return's type reaches the result.
  `epicenter` gives a yield no meaning.
- **A yield is never the answer.** It is retained in the run event log but is not part of the
  returned result or app data. A caller that ignores yields loses nothing: the CLI
  prints the answer, `--json` prints one answer as now, and Claude or ChatGPT
  get the tool result. An action whose meaning lives only in its yields is
  wrong; its return must carry what the call produced.
- **A UI calls an action through a run.** `POST /.runs/<app>/<action>/<id>`
  carries the JSON input and streams sequenced event frames, ending with the
  answer. The action's words are joined by `.`.
- **MCP is for agents and carries no yields.** A connector's `tools/call`
  gets the one tool result, as before; nothing a connector does can ask for a
  yield.
- **Called anywhere else, an action is a promise of its return.** The function
  `defineAction` returns drains the generator and resolves with what `run`
  returned, so a test, another action, and the CLI call it as they call any
  action. Only `runYielding`, which every call runs through, reads the
  generator step by step.
- **Page runs retain yields for observers.** Another observer with the run id
  can replay them while the host retains the run.
- **The UI client** reads frames with the stream's reader, calls `onYield`
  in order, and resolves to the action's result. A callback may return a
  promise or throw. Stopping observation does not cancel the run.
- **Cancellation is explicit.** `run.cancel()` asks serve to abort the action's
  cooperative signal. An action passes `callSignal()` to a wait when it can
  stop that wait. Its `finally` blocks run when it cooperates.

## Consequences

- Vocab's chat streams from a model on the Studio with no model reachable
  from the phone, and its prompt, word choice, and history in an action
  Claude can also call.
- `serve` has two ways in for an action: MCP at `POST /` for agents, and
  `POST /.runs/<app>/<action>/<id>` for an app's own pages. Both reach the same call
  (`run.ts`), so the input check, the answer, and the commit are one. An
  action's address is on the private listener only; a connector at the
  public address goes through MCP (ADR-0881).
- Yields are not validated by a schema, as inputs are. They reach only a UI
  the same app wrote, so a wrong shape is that app's bug, caught by its types.
- A `readOnlyHint` action that yields still commits nothing. A writing action
  takes its lock at its first write (ADR-0850), so a stream of yields before
  the first write keeps no other call waiting.
- A connector never receives a yield, so how claude.ai or ChatGPT would show
  one never needs an answer.

## Considered alternatives

- **The UI streams from Ollama itself and calls an action to save the turn.**
  No platform change, but Ollama has to be reachable from the phone, through a
  `serve` route that proxies a model or a tailnet port with no sign-in, and
  the prompt and word choice move into the browser, out of Claude's reach.
- **Yields as MCP progress notifications on the UI's MCP call (built
  2026-11-11, replaced the same day).** The UI called every action over MCP,
  so a yielding call marked itself with `_meta` and got an event stream of
  progress notifications, each carrying a yield in its `_meta`. `serve` had
  to peek at each body for the marker, switch each response between JSON and
  an event stream, close the call's MCP server to stop it, and relay yields
  from a child over IPC; the client parsed JSON-RPC inside server-sent
  events. A UI's call never needed MCP: `epicenter` supplies the client, so
  the client and `serve` cannot drift, and an address per action removed all
  of it.
- **A callback in `run`'s input, `run(input, { emit })`.** It nests into
  helpers without `yield*`, but `return` and `yield` already say "the answer"
  and "while it runs", and a generator stops when its caller goes away.
- **Broadcasting yields to every open page of the app.** A second device could
  watch a reply being written, at the cost of a channel, its subscribers, and
  what each may see. A saved turn reaches every page when it reads again.
- **Server-sent events instead of JSON lines.** `EventSource` cannot send a
  body, so a UI would read either one with `fetch` anyway, and each message
  would carry a `data:` prefix and a blank line for nothing.
- **Writing the reply to its file as it streams.** Every reader, a connector,
  another device, `serve`'s snapshot, would see half a sentence, and a call
  commits once at its end anyway, so the writes would buy nothing.
