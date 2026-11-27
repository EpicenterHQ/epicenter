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
  The program's top-level handler receives it, and the work carries on. A
  program installs that handler where it starts; without one, Bun exits
  after the report. A test stands in for the program by replacing
  `globalThis.reportError`.

The program creates its logger once, where it starts, and writes:

- one `info` line for each thing it ran. The action runner's line is the
  model: app, action, duration, and the error's name and message or `null`
  ([run.ts](../../../packages/app/src/command/run.ts)). It is complete by
  itself, so nothing else has to log the same call.
- one `warn` or `error` line for each failure that reached it. `warn` means
  the program carried on with that work; `error` means that work was lost.

## What a line holds

A `defineErrors` variant, passed whole. The call gives the variant what
went wrong as `cause`, and the variant writes the message from it:

```ts
serveLog.error(ServeError.Unanswered({ cause }));
```

A line holds names and messages. `Unanswered` reads its cause's message and
stores neither the cause nor its fields
([serve.ts](../../../packages/app/src/command/serve.ts)), so an input, a
result, a transcript, or a key reaches a line only if someone wrote it into
an error's message. Write messages that are safe to log.

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

Showing a person a message is a separate call, made beside the log call by
the code that owns the interaction. The sink sees every line, including the
ones nobody asked about, so it cannot tell which to show.

The logger's own API is documented with the library:
[Wellcrafted's logger](https://github.com/wellcrafted-dev/wellcrafted/blob/main/docs/core/logger.mdx).
