---
name: logging
description: Decide whether a failure is logged, who logs it, and what the line holds, using wellcrafted/logger. Use when adding or reviewing a log call, handling a failure nobody is waiting for, replacing console.* in library code, or choosing where a program's logs go.
metadata:
  author: epicenter
  version: '3.0'
---

# Logging

A program has one place that writes its record. Nothing else logs.

A program is something that gets started and runs: `serve`, or a desktop
app. Code inside it, whether an action, a feature, or a shared package, does
one of two things with a failure:

- **Return it** to whoever asked. The
  [error-handling](../error-handling/SKILL.md) skill owns that path.
- **Hand it to the program** when nobody asked: `reportError(error)`. A
  listener that throws while others are being notified is the usual case.
  The program's top-level handler receives it, and the work carries on.

The program creates its logger once, where it starts, and writes:

- one `info` line for each thing it ran. The action runner's line is the
  model: app, action, duration, and how the run ended
  ([run.ts](../../../packages/app/src/command/run.ts)).
- one `warn` or `error` line for each failure that reached it. `warn` means
  the program carried on with that work; `error` means that work was lost.

## What a line holds

A `defineErrors` variant, passed whole, with what went wrong as its `cause`.
Do not write a sentence at the log call or pick an error apart by hand; the
variant owns its message.

```ts
serveLog.error(ServeError.Unanswered({ cause }));
```

Never an action's input or result, a transcript, or a key. Keeping those out
is the sink's job, so no call site has to remember it: `serve`'s sink writes
a thrown cause as its name and message.

## Where lines go

A sink is a function the program writes. It receives each line as an event
and puts it wherever the program wants, in one place or several:

```ts
const log = createLogger('whispering', (event) => {
	appendLine('whispering.log', event); // the file a person can send
	console.error(event); // the developer console
});
```

`serve` writes JSON lines to stderr
([output.ts](../../../packages/app/src/command/output.ts)), and whatever
keeps `serve` running stores them.

A message shown to a person is not a sink. The sink sees every line,
including ones nobody should be shown, and it does not know the title the
person needs. Showing is a separate call, made beside the log call by the
code that owns the interaction.

The logger's own API is documented with the library:
[Wellcrafted's logger](https://github.com/wellcrafted-dev/wellcrafted/blob/main/docs/core/logger.mdx).
Check a claim about it against the installed version's types.
