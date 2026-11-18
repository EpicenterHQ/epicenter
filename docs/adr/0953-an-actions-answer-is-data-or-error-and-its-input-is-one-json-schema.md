# 0953. An action's answer is `{ data, error }`, and its input is one JSON Schema

- **Status:** Accepted
- **Date:** 2026-11-17
- **Amends:** [ADR-0914](0914-action-errors-share-one-contract-and-the-envelope-records-execution.md) at "Keep the existing `returned` / `threw` / `error` wire envelope": the envelope goes, and an error's name says whether the action ran. [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) at its host answer table: the `kind` and `reason` rows go. [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) at "with the ADR-0926 answer": the final `{"answer": ...}` frame carries the plain answer, and a refusal before the action runs is `NotStarted`.
- **Relates:** [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve runs every action), [ADR-0938](0938-an-action-says-whether-agents-are-offered-it.md) (`mcp: false`).

Two decisions about the same boundary, where an action meets its callers: what comes back (D1) and what goes in (D2). Two removals ship with them in 0.7.0: serve stops stating its version (C5), and a dead schema check goes (C8).

## Context

### D1: the answer

Serve wrapped every failure in an envelope whose `kind` said what happened to the call:

```json
{"data":null,"error":{"kind":"returned","reason":{"name":"Missing","message":"There is no data/books/No Such Book.md","path":"data/books/No Such Book.md","namespace":"epicenter/action-error"}}}
{"data":null,"error":{"kind":"fault","message":"Unexpected end of input"}}
{"data":null,"error":{"kind":"refused","reason":{"name":"Usage","message":"\"idd\" is not a key this action takes; it takes id","next":"epicenter reading get --help"}}}
```

`packages/cli/src/output.ts` built it (`RunFailure`, `refused()`), and `outcome()` read `kind` for the exit code: 2 for `refused`, 1 otherwise. `packages/app/src/client.ts` unwrapped it for a page: `returned` gave the reason, `fault` became `ActionError.Threw`, and `refused` became `ActionError.Refused`. An app's own actions also return `ActionError.Refused`, for example when a task has no title. A page could not tell "serve never started my call" from "the action looked and said no."

The `kind` repeated what a name can carry. Each `kind` maps to one fact about the call, and each fact has one error name that can carry it.

### D2: the input

An author writes an action's input as a record of fields:

```ts
input: { word: field.text(), meaning: field.text({ optional: true }) },
```

`defineAction` stored that record as `action.input`. Which keys are required lives in TypeBox's `~optional` marker on each field, a non-enumerable property. `JSON.stringify` drops it, so the record's JSON says nothing about what is required:

```json
{"word":{"type":"string"},"meaning":{"type":"string"}}
```

Rebuilt from that JSON, `meaning` is required. `packages/cli/src/input.ts` wraps the live record in `Type.Object` for each check, and `jsonSchema()` and `requiredKeys()` rebuild `required` for MCP, `--help` and `list --json`. Each reader rebuilds the schema its own way.

## Decision

### D1: one answer shape

**Every surface answers exactly `{ data, error }`, where `error` is `null` or the error object itself.** No `kind`, no `reason`. The answer is the same on each surface:

| Surface | Where the answer is |
| --- | --- |
| HTTP, `POST /<app>/<action>` | the final `{"answer": ...}` line; a call refused before it starts is the body of a 400 |
| `epicenter <app> <action> --json` | the one JSON value on stdout |
| MCP `tools/call` | `structuredContent` |
| `packages/cli/src/serve-call.ts` | what `sendToServe` returns to the CLI |

```json
{"data":{"id":"dune"},"error":null}
{"data":null,"error":{"name":"Missing","message":"There is no data/books/No Such Book.md","path":"data/books/No Such Book.md","namespace":"epicenter/action-error"}}
{"data":null,"error":{"name":"NotStarted","message":"\"idd\" is not a key this action takes; it takes id","cause":"usage","next":"epicenter reading get --help","namespace":"epicenter/action-error"}}
{"data":null,"error":{"name":"Threw","message":"Unexpected end of input","namespace":"epicenter/action-error"}}
```

**Three error names belong to the platform's handling of a call, and each says whether the action ran.** All three are `ActionError` variants in `packages/app/src/errors.ts` and carry `namespace: 'epicenter/action-error'`.

| Error | Who answers it | Did the action run? |
| --- | --- | --- |
| `NotStarted` | serve, or the CLI before it sends | no |
| an app's error, such as `Missing` or `Refused` | the action | yes |
| `Threw` | serve | yes, partly |
| `Unreachable` | the page client or the CLI | unknown |

- `NotStarted` carries `message`, `cause: 'usage' | 'app-problems' | 'internal' | 'unavailable'`, an optional `next` (the command to run), and, for `app-problems`, `problems`, the app's problems as strings. It replaces the `Usage`, `AppProblems` and `Internal` refusals an action call answered. `unavailable` means the CLI found no serve for this home: the connection was refused before anything was sent, or another program holds the port. The amendment below adds the cause `refused`, gives `app-problems` its `app`, and types each cause's fields.
- `Threw` carries `message` and, when the action threw a tagged value that survives JSON, `thrown`.
- `Unreachable` carries `message`. A caller answers it when the outcome is unknown: the connection dropped after the call was sent, a line was not a valid frame, or the stream ended with no answer.

**An action cannot answer `NotStarted` or `Unreachable`.** When an action returns an error named either, serve answers `Threw` with the message `The action "<key>" returned NotStarted, a name only Epicenter answers`. This holds whether or not the error carries the namespace: `marked()` in `errors.ts` adds an enumerable field, and any action can copy it. Every other error an action returns passes through unchanged, `Threw` and `Refused` included.

**One browser-safe module reads an answer, for a page and for the CLI.** `packages/app/src/answer.ts` exports `readAnswer(response, onUpdate)`, which `connect()` in `client.ts` and `sendToServe` in `serve-call.ts` both call, and `checkAnswer(value)`, which validates one answer. It never trusts HTTP status alone: a 200 whose lines are not frames, or whose stream ends with no answer, is `Unreachable`, and a non-2xx response is read only for a `NotStarted` answer in its body.

**Exit codes follow the name.** For an action call, 0 is success, 2 is exactly `NotStarted`, and every other error is 1. MCP sets `isError: true` for any error.

**Retry safety reads from the name.** `NotStarted` is safe to send again once its cause is fixed. After an app error or `Threw`, the action ran, and the caller rereads the record before deciding. After `Unreachable` the caller rereads the record, because the action may have finished. An action that must not run twice still takes an id in its input (ADR-0930).

The CLI's own commands, `init`, `new`, `export`, `check` and `serve`, are not action calls. As first decided, their failures stayed `CliError`s; the amendment [CLI commands answer the same way](#amendment-2026-11-17-cli-commands-answer-the-same-way) gives them the same answer and exit codes.

### D2: input is one plain JSON Schema

**`defineAction` stores and exposes its input as `Type.Object(fields, { additionalProperties: false })`, with `required` always written.** An author still writes the record of fields. `action.input` becomes the object schema, with `required: []` when no key is required:

```json
{"type":"object","properties":{"word":{"type":"string"},"meaning":{"type":"string"}},"required":["word"],"additionalProperties":false}
```

**That one value drives validation, MCP's `inputSchema`, `--help` and `list --json`.** `input.ts` checks against `action.input` and reads `action.input.required`; it stops rebuilding `required`. A test round-trips every action declaration through `JSON.stringify` and `JSON.parse` and checks that `Value.Check` gives the same verdict on the copy as on the original.

### C5: upgrading is the owner's step

**Epicenter does nothing about upgrades.** Serve is a program the owner keeps running (ADR-0941), and the owner restarts it after upgrading. Serve no longer states its version in an `x-epicenter-version` header, and a command no longer warns when it reaches an older serve. The two library checks stay: `epicenter` refuses to load apps when the home has two copies of `@epicenter/app`, or when `@epicenter/app` and `@epicenter/cli` name different versions. After D1, a mismatched pair would misread answers. This replaces the draft ADR-0952 in PR #2681, which proposed having serve exit when its packages change.

### C8: no upload-marker check

`defineData` no longer refuses a field schema carrying `x-epicenter-file`. Nothing in the library or in any app makes that marker.

## Consequences

- A page can switch on `error.name` alone. `NotStarted` and an app's `Refused` are different names, so "my call never ran" and "the app said no" no longer collide.
- `packages/cli/src/output.ts` loses `RunFailure`, `refused()` and the `kind` branches of `outcome()`. `client.ts` loses its envelope decoder, and `serve-call.ts` stops casting serve's body to an answer without checking it.
- Anything that read `kind` or `reason` breaks: a page or test that faked the envelope, a script that read `.error.kind` from `--json`, and an agent prompt that described it. `Refused` from a call that never started is now `NotStarted`. A page that matched `Refused` to catch both now handles them apart.
- An app that returned `ActionError.Unreachable` for a dependency that did not answer now answers `Threw` instead. It returns its own error name, or `Ok` with a field saying the result was not confirmed.
- An app may not define its own error named `NotStarted` or `Unreachable`; serve turns either into `Threw`.
- A connection that drops after the call was sent was a `fault`, exit 1, and is now `Unreachable`, exit 1. A refused connection was a `Refused` refusal, exit 2, and is now `NotStarted` with cause `unavailable`, exit 2.
- C5: after `bun install`, an owner who forgets to restart serve gets the old code's answers with no warning. The upgrade note says to restart.
- D2: an action's input is one JSON value any reader can copy, store or send without losing which keys are required. The cost is one more level in `action.input`: code that read a field as `action.input.word` reads `action.input.properties.word`.

## Considered alternatives

- **Keep `kind` and rename the refused error.** Renaming `Refused` to `NotStarted` inside the envelope fixes the collision but keeps two fields saying one fact, and every reader still unwraps `reason`.
- **Reserve `NotStarted` only in the platform namespace.** An app could then define its own `NotStarted`, and a caller would have to check the namespace before trusting the name. The namespace is copyable, so the check would prove nothing.
- **Make serve's refusals a framed `{"answer": ...}` line too.** One decoder path for every status, but it changes ADR-0930's route for a call that never started. `readAnswer` reads both, so the gain is small.
- **Keep the field record and add `required` beside it on the action.** Two values a reader must combine, and the record's JSON still reads as if every key were required.

## Amendment, 2026-11-17: CLI commands answer the same way

D1 left the CLI's own commands outside the answer. They printed `{"error": ...}` from a separate `CliError` family, so a script read one shape from an action call and another from `epicenter --json`, and two refusals were both named `Refused`: the CLI's, and an app's. Now every command ends in one `{ data, error }` answer, and one function, `presentAnswer` in `packages/cli/src/output.ts`, prints it and sets the exit code from `outcome()`.

**Every command's `--json` is `{ data, error }`.** That holds for `init`, `new`, `export`, `check`, the home listing, one app's listing, action help, `--version` and `--help`. Without `--json` a command prints what it printed before. Exit codes are D1's: 0 for no error, 2 for exactly `NotStarted`, 1 for any other error. `serve` prints no answer while it serves; its refusals before serving are answers, and `serve --json` is refused as `usage`.

**`CliError` is gone.** The CLI's error module is deleted, and each variant became a cause of `NotStarted` or, for a failure after a command began, `Threw`:

| `CliError` | Now |
| --- | --- |
| `Usage` | `NotStarted`, cause `usage` |
| `AppProblems` | `NotStarted`, cause `app-problems`, with `app` and `problems` |
| `Refused` | `NotStarted`, cause `refused` (new) |
| `Internal` | `NotStarted`, cause `internal` |
| `GitFailed` | `NotStarted`, cause `internal`, when `new` failed before it kept anything; `Threw` when it failed partway |

`refused` means the command was understood and doing it would lose or guess: `export` into a folder it does not own, or a port another serve holds. A command that ran in part answers the error that says so with exit 1: an `init` whose install failed and an `export` that omitted apps answer `Refused`.

**`NotStarted` is one name whose fields depend on `cause`.** `ActionError.NotStarted` takes a union body, so narrowing on `cause` types the fields: `app` and `problems` for `app-problems`, an optional `next` for `usage`, `refused` and `unavailable`. `checkAnswer` checks each cause's fields. One name with a cause beats one variant per cause:

- A per-cause name such as `Refused` would collide again with an app's own `Refused`, the collision D1 removed.
- "Did it run?" stays one comparison, `name === 'NotStarted'`. Per-cause names would make every reader keep a list of the names that mean "never began".
- A new cause leaves old readers right. A new name would leave their lists stale, and they would read a refusal as an action's error.

**A throw is for a broken program, and a Result is for what a caller can act on.** A throw becomes `Threw` in one place, `runAction` for an action and `runCli` for a command. `context.ts` throws when an app reads its data outside an action's run: that is a bug in the app, and no caller can fix it by trying again. `disk.ts` returns `undefined` for a missing file and rethrows any other error: a disk that answers `EACCES` or `EIO` there is a broken machine. Neither becomes a Result. A command never throws a tagged error to steer its own control flow; `export` returns its refusals as Results.

**A page's call error is exact.** `ActionCall` resolves to `Result<ActionOutput<A>, ReturnedError<A> | NotStarted | Threw | Unreachable>`, and `@epicenter/app/client` exports those three types. A `switch` on `error.name` is exhaustive, and a comparison with a name the action cannot return is a compile error.
