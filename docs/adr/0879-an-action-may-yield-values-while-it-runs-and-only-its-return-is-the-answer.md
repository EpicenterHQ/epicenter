# 0879. An action may yield values while it runs, and only its return is the answer

- **Status:** Accepted (2026-11-11)
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
the UI that called it, as it runs; what it returns is the answer, as now; and
only its writes are saved, committed once when it ends (ADR-0850).** Yields
are for a person watching a page. Claude, ChatGPT, the terminal, a test, and
another action never see them, and lose nothing.

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
- **A yield is never the answer.** It is not saved, not committed, and not
  part of the result. A caller that ignores yields loses nothing: the CLI
  prints the answer, `--json` prints one answer as now, and Claude or ChatGPT
  get the tool result. An action whose meaning lives only in its yields is
  wrong; its return must carry what the call produced.
- **A UI calls an action at its own address.** `POST /<app>/<action>`, the
  action's words joined by `.` (`/vocab/chat.say`), with the whole input as
  the JSON body. The response is JSON lines, one JSON value and a newline
  each: `{"yielded": <value>}` per yield, as it is yielded, then
  `{"answer": <answer>}`, the answer `--json` prints. An action that only
  returns answers one line. The words, not a tool name, make the address, so
  `GET` gets a page and `POST` runs an action under the same `/<app>/`.
- **MCP is for agents and carries no yields.** A connector's `tools/call`
  gets the one tool result, as before; nothing a connector does can ask for a
  yield.
- **Called anywhere else, an action is a promise of its return.** The function
  `defineAction` returns drains the generator and resolves with what `run`
  returned, so a test, another action, and the CLI call it as they call any
  action. Only `runYielding`, which every call runs through, reads the
  generator step by step.
- **Yields go to the caller and nowhere else.** No page watches a call another
  device or a connector made; a conversation another caller continued shows
  when its turn is saved and the page reads it again.
- **The UI client** posts to the action's address, reads the lines with the
  stream's reader (Safari cannot iterate a stream with `for await`), calls
  `onYield` with each value in order, and resolves with the same `Result` a
  call without it would. Its type offers `onYield` only on an action that
  yields. A response that ends without an answer is `Unreachable`. The same
  call takes a `signal`; aborting it stops reading, so the action stops as
  below, and the call resolves as `Stopped` (added 2026-11-12, for a Stop
  button on a tutor's reply).
- **A call abandoned is a call stopped at its next yield.** When the page
  stops reading, `serve` makes the action's next yield throw where it
  stands: its `finally` blocks run, and what it wrote is committed as
  `<call> (stopped)`. A generator that saves only before it returns has then
  saved nothing. An action that waits between yields reads the call's signal
  with `callSignal()` and passes it to the wait, such as a model's `fetch`,
  so a stop ends the wait at once instead of at the next yield; an action
  that never reads it is stopped at its next yield all the same. An action
  that does not yield runs to its end. (Amended 2026-11-12: `callSignal()`
  and the `(stopped)` commit, for Vocab's Stop.)

## Consequences

- Vocab's chat streams from a model on the Studio with no model reachable
  from the phone, and its prompt, word choice, and history in an action
  Claude can also call.
- `serve` has two ways in for an action: MCP at `POST /` for agents, and
  `POST /<app>/<action>` for an app's own pages. Both reach the same call
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
