# 0879. An action may yield values while it runs, and only its return is the answer

- **Status:** Accepted (2026-11-11)
- **Date:** 2026-11-11
- **Built:** 2026-11-11: `run` as an `async function*` and `runYielding`
  (`packages/app/src/action.ts`), `onYield` on the view client
  (`packages/app/src/client.ts`), yields from the child over IPC
  (`packages/cli/src/child.ts`, `cli.ts`, `run.ts`), progress notifications
  for a marked call (`mcp.ts`), and its event stream and stop (`http.ts`).
- **Unbuilt:** Vocab's chat, the first action that yields.
- **Relates:** [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a view calls only actions), [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md) (an action runs where what it uses is), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (a call commits what it wrote), [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP and the view client).

## Context

Vocab's chat sends a message to a model on the Studio's Ollama and shows the
reply. A local 9B model takes a few seconds to answer, and a reply that types
itself out reads as a conversation, where one that appears whole after a pause
reads as a form. The view cannot call Ollama itself without `serve` proxying a
model to every signed-in device, or Ollama listening on the tailnet with no
sign-in, and either way the prompt, the choice of words, and the saving move
into the browser, where Claude cannot reach them (ADR-0860, ADR-0861).

Today an action returns one value. `serve` runs it in a child,
`epicenter <app> <words> --input <json> --json`, reads the one JSON answer,
and sends it as the MCP tool result in one JSON body
(`packages/cli/src/mcp.ts`).

A spike on 2026-11-11 ran the whole path with MCP SDK 1.29.0, the transport
`serve` uses:

```txt
async function* in a child → one JSON line per yield on stdout
  → the tool handler → an MCP progress notification per yield
  → server-sent events on the one POST → a fetch client
```

Tokens chosen to break framing (Chinese, Japanese, an emoji, `\n\n`, `\r\n`,
quotes, backslashes, an empty token, a line reading `data: …`) arrived 15 of
15, as produced, and the text rebuilt from them equalled the returned reply
byte for byte. Against `qwen3.5:9b` on Ollama, 19 and then 44 streamed tokens
rebuilt the returned reply exactly, and a structured value per yield, carried
in the notification's `_meta`, arrived intact.

## Decision

**An action's `run` may be an `async function*`. What it yields goes only to
the view that called it, as it runs; what it returns is the answer, as now; and
only its writes are saved, committed once when it returns (ADR-0850).** Yields
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
  Tokens, `{ step, of }`, a partial list: the action and its view are written
  together, and the view's client is typed by the app (ADR-0857), so the
  yield's type reaches `onYield` as the return's type reaches the result.
  `epicenter` gives a yield no meaning.
- **A yield is never the answer.** It is not saved, not committed, and not
  part of the result. A caller that ignores yields loses nothing: the CLI
  prints the answer, `--json` prints one answer as now, and Claude or ChatGPT
  get the tool result. An action whose meaning lives only in its yields is
  wrong; its return must carry what the call produced.
- **Only the view client asks for yields.** `connect` marks a call with
  `_meta: { "epicenter/yields": true }` and a `progressToken` when it passes
  `onYield`. `serve` streams only then: each yield is a progress notification
  with `progress` counting yields and the value in `_meta["epicenter/yield"]`.
  Every other request, a connector's included even when it sends its own
  `progressToken`, gets the one JSON body as now, so no connector ever shows
  a yield.
- **Called anywhere else, an action is a promise of its return.** The function
  `defineAction` returns drains the generator and resolves with what `run`
  returned, so a test, another action, and the CLI call it as they call any
  action. Only `runYielding`, which the child runs every call through, reads
  the generator step by step.
- **Yields go to the caller and nowhere else.** No page watches a call another
  device or a connector made; a conversation another caller continued shows
  when its turn is saved and the page reads it again.
- **Between `serve` and its child,** `serve` opens Bun's IPC channel only for
  a call that wants yields, and the child sends each yield over it as a JSON
  message when it has a channel, and nothing when it has none, so no flag
  says so. The answer still comes back in the report file (`child.ts`).
  Bun delivers every message before the child's exit is seen, so the last
  yield always arrives before the answer is read. The child's stdout is
  already its stderr, and an extra descriptor failed under `Bun.spawn`, so
  the spike's lines on stdout gave way to the channel.
- **The view client** sends the marker and a `progressToken` when the call
  passes `onYield`, reads the event stream, calls `onYield` with each value in
  order, and resolves with the same `Result` a call without it would. Its
  type offers `onYield` only on an action that yields.
- **A call abandoned is a call that never returned.** When the page stops
  reading the stream, `serve` closes the call's MCP server, which aborts the
  call, and the child gets `SIGTERM`; a generator that saves before it
  returns has then saved nothing, and nothing is committed. A conversation
  turn the person closed mid-reply leaves no half a turn behind. A call that
  did not ask for yields runs to its end, as every call did before.

## Consequences

- Vocab's chat streams from a model on the Studio with no route but MCP, no
  model reachable from the phone, and its prompt, word choice, and history in
  an action Claude can also call.
- The protocol between `serve` and its child gains an IPC channel, opened only
  for a call that wants yields; `serve` answers that one call with an event
  stream instead of one JSON body; and `connect` reads an event stream. Every
  app gets it at once; any slow action can report progress the same way.
- Yields are not validated by a schema, as inputs are. They reach only a view
  the same app wrote, so a wrong shape is that app's bug, caught by its types.
- A `readOnlyHint` action that yields still commits nothing. A writing action
  takes its lock at its first write (ADR-0850), so a stream of yields before
  the first write keeps no other call waiting.
- A connector never receives a yield, so how claude.ai or ChatGPT would show
  one never needs an answer.

## Considered alternatives

- **The view streams from Ollama itself and calls an action to save the turn.**
  No platform change, but Ollama has to be reachable from the phone, through a
  `serve` route that proxies a model or a tailnet port with no sign-in, and
  the prompt and word choice move into the browser, out of Claude's reach.
- **A streaming endpoint for views beside MCP.** Its own framing and no
  stretched use of progress notifications, but the view already calls every
  action over MCP, and a second protocol would carry the same call, its
  errors, and its sign-in twice.
- **A callback in `run`'s input, `run(input, { emit })`.** It nests into
  helpers without `yield*`, but `return` and `yield` already say "the answer"
  and "while it runs", and a generator stops when its caller goes away.
- **Broadcasting yields to every open page of the app.** A second device could
  watch a reply being written, at the cost of a channel, its subscribers, and
  what each may see. A saved turn reaches every page when it reads again.
- **Yields as text in the progress `message`.** Works today, but a connector
  that shows `message` would flicker single tokens as status, and a value
  other than text would be flattened into a string.
- **Writing the reply to its file as it streams.** Every reader, a connector,
  another device, `serve`'s snapshot, would see half a sentence, and a call
  commits once at its end anyway, so the writes would buy nothing.
