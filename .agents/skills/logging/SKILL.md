---
name: logging
description: Decide whether a failure is logged, who logs it, and what the line holds, using wellcrafted/logger. Use when adding or reviewing a log call, handling a failure nobody is waiting for, replacing console.* in library code, or choosing where a program's logs go.
metadata:
  author: epicenter
  version: '3.0'
---

# Logging

Code that does the work returns its error. It does not log and does not show
a message. The code that owns the interaction sees the result and does what
follows from an error. The [error-handling](../error-handling/SKILL.md) skill
owns that path; this skill owns the record.

## Who logs

Almost nobody. Before adding a log call, check that the code is one of these:

- **The top of a program.** The action runner writes one line when each run
  ends ([run.ts](../../../packages/app/src/command/run.ts)), so an action
  never logs its own outcome. An app's top-level error handler shows the
  person a message and records a line they can send to the maintainer.
- **Code with nobody to answer.** A listener that throws while others are
  being notified, a subscription whose re-read fails, or a server that cannot
  write its reply. There is no caller to return the error to, so the record
  is all that is left of it.
- **A boundary that hides the cause.** When a reply leaves out an internal
  cause on purpose, log the cause it leaves out. `serve` answers `Threw` and
  logs what was thrown
  ([serve.ts](../../../packages/app/src/command/serve.ts)).

Everything else returns the error to its caller.

## What a line holds

A name someone can search for, a message, and where it came from. Never an
action's input or result, a transcript, or a key. The runner's line is the
model: app, action, outcome, and duration.

## How to write one

```ts
const log = createLogger('epicenter/serve', stderrJsonLines);

log.error(ServeError.Unanswered({ cause }));
```

- Log a `defineErrors` variant that the module owns, not `new Error('...')`.
  A variant has a stable name; a sentence is worded differently each time.
  `warn` and `error` take the variant and nothing else, and its message
  becomes the line's message.
- A variant that is only logged stays private to its module. Exporting it
  publishes a name nobody imports.
- `warn` means the code carried on. `error` means it gave up. `info` takes a
  message and data, for an event that is not a failure, such as a run ending.
- The first argument is the source, stamped on every line:
  `'<package>/<module>'`, lowercase.
- Library code never calls `console.*`.

## Where lines go

A logger is a source and a sink. A sink is a function that receives one
event, and Wellcrafted has no global logger to configure, so the only way a
line reaches anywhere is the sink its logger was made with.

That is what lets the program decide and not the library. A module that can
be created more than once takes `log?: Logger` and defaults to its own; a
module that exists once per process creates its logger at module scope. The
default sink is the console. `serve` passes `stderrJsonLines`, and whatever
keeps `serve` running stores the lines. A desktop app passes a sink that
appends to a file in its own folder.

A message shown to a person is not a sink. Showing is a separate call by the
code that owns the interaction: it needs a title only that code knows, and
not every recorded failure should be shown.

The API itself (levels, the event shape, combining sinks, a sink for tests)
is documented with the library:
[Wellcrafted's logger](https://github.com/wellcrafted-dev/wellcrafted/blob/main/docs/core/logger.mdx).
Check a claim about it against the installed version's types.
