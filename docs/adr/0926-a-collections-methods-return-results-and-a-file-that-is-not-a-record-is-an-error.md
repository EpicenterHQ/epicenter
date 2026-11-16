# 0926. An action returns one Result from its collections to its callers

- **Status:** Accepted (2026-11-15), amended 2026-11-16
- **Date:** 2026-11-15
- **Amends:** [ADR-0914](0914-action-errors-share-one-contract-and-the-envelope-records-execution.md) on returned failures and the wire answer, and [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) on CLI rendering and exit codes.
- **Relates:** [ADR-0918](0918-a-collection-selects-a-record-by-its-keys-and-a-file-that-is-not-there-reads-as-absent.md) on collection methods and verbs, [ADR-0923](0923-a-read-gives-only-what-the-file-holds-and-no-field-has-a-default.md) on reading fields, and [ADR-0917](0917-a-pages-calls-are-serve-owned-runs-and-observing-is-not-cancelling.md) on observing a run.
- **Releases:** 0.2.0 introduced action Results. 0.2.1 reads both host formats. 0.3.0 writes the flat host Result. The [transport acceptance test](../../packages/cli/src/acceptance.result.test.ts) compares a saved draft with a call refused before its first write.

## Context

Reading a record is parsing a file, and a parse has three outcomes: there is
no file, the file is a record, or the file is there and is not one. `get`
gave the third as a record with some fields absent and a `problems` list
beside them. Code reads fields, so it read the absent ones.

Twelve apps were moved to the package, and their code makes 21 single reads:

- 13 handle the file being absent, and 7 throw `Missing` by hand.
- Most never look at `problems`. The first pass added `?? []` and `?? false`
  where a type complained, which treats a malformed list as an empty one.
  One app reads a send attempt with a malformed file as no attempt, which
  can hide a send that was never confirmed.
- A second pass replaced the guards with a check of `problems` at each read,
  and five apps then wrote the same refusal by hand. `need(keys)` was added
  to do it for them. It covers the 7 reads that require the record.

The apps also refuse ordinary requests with `throw new Error(...)`, about
200 times. A caller receives each as `Threw`, the same name a crash gets.

A test against the current runner made an action return
`ActionError.Changed({ path: 'notes/a.md', why: 'quote' })`. Its fields survived
JSON. The [runner](../../packages/cli/src/run.ts) put the Err in
`{ returned: ... }`, the [browser client](../../packages/app/src/run-client.ts)
produced `Ok(Err(Changed))`, the CLI exited 0, and MCP reported success.

## Decision

### One Result per action call

Every action's `run` returns a Wellcrafted `Result<T, E>`, directly or through
a promise. A generator yields progress values and returns one final Result.
An action that succeeds with no value returns `Ok(undefined)`. This contract
covers handwritten actions, generated verbs and calls from one action to
another. The action declaration checks the return type. At runtime a direct
call and the runner both check the final Result shape. JSON encoding happens
only when an answer crosses a transport. Plain helpers keep the return type
their work requires.

A Flights action can pass a collection read straight through. A second action
that needs departure airports adds the one refusal that belongs to it:

```ts
const lookup = defineAction({
  description: 'Look up a watch',
  input: { name: field.text() },
  run: ({ name }) => watches.get({ name }),
});

const departures = defineAction({
  description: 'List the departure airports for a watch',
  input: { name: field.text() },
  async run({ name }) {
    const read = await lookup({ name });
    if (read.error !== null) return read;
    if (read.data === undefined)
      return ActionError.Missing({ path: watches.pathOf({ name }) });
    return Ok(read.data.from);
  },
});
```

A malformed watch reaches both callers as the original `Err(Misfit)`. Direct
calls share the enclosing run's folder, lock and cancellation signal. Only
the outer call creates a host answer. A caller that depends on a write must
check or forward its Result before continuing. An ignored `await set(...)`
can now continue after a refusal that previously threw. An async generator
can likewise `return read` on failure after yielding progress. Earlier yields
and writes stand.

### Collections

| Operation | Outcome |
| --- | --- |
| `get(keys)` | `Ok(record)` with every field of its declared type, `Ok(undefined)` for an absent keyed file, or `Err(Misfit)` for a file that cannot be read as a record. |
| `list()` | One Result per file in path order. `partitionResults` separates records from files to repair. |
| `add(record)` | `Ok(record)` after creation. `Refused` if the file exists or the supplied record does not fit. |
| `set(keys, change)` | `Ok(record)` after the change. A missing keyed file gives `Missing`. |
| `update(keys, fn)` | `Ok(record)` after updating or creating. An absent keyed file passes `undefined` to the function. |
| `delete(keys)` | A boolean indicating whether a file existed. Its action wraps the boolean in `Ok`. |

A computed write can see only a fitting record or permitted absence. A
malformed file gives `Misfit` before the callback runs. Both `set` and
`update` require a synchronous Result from the callback. `Ok(patch)` applies
the patch. A tagged Err passes straight to the caller and leaves the file
untouched. For a direct patch, pass the object itself to `set`. Both writers return `Refused` for invalid supplied values and
`Changed` for a failed concurrency guard. A plain patch can repair a file
with readable front matter. Validate the resulting record before replacing
the file. If other fields still need repair, return a `Misfit` describing the
stored file so the caller can submit the complete patch. Unreadable front matter requires a file
edit. This removes `need`, `FittingRecordOf`, `problems` on valid records,
and per-field tracking for computed writes.

A keyless collection represents one record, even before its file exists.
Its fields must permit an empty file. `get()` then returns `Ok(record)`,
`set` can create its file, and it has no `add`. A sign-in refresh that
depends on the old token must compare it at the write, including when the
file has since been deleted.

`ActionError.Misfit` carries the path and the problems reported by
`epicenter check` (the diagnostic text and its kind, with a source line
when known). For a non-local file with readable front matter it includes `record`,
the keys, body and fields that fit, for a repair form. For a `.local` path the collection
omits `record` and constructs all messages and problems without quoting file
values or body text. Write refusals follow the same rule. This applies when the error is created, so forwarding
it to an enclosing action, a saved run or MCP cannot disclose a valid token
beside a malformed field. Unreadable front matter also has no partial record.

The generated `get` verb requests a specific record. It forwards `Misfit`
and turns an absent keyed record into `Missing`. The `list` verb returns
`Ok(rows)`, with one Result per file and bodies omitted from both successful
rows and partial records. The outer Ok means enumeration completed. One bad
file remains visible beside the good rows. `add` and `set` forward their
write Results. The `set` verb keeps its JSON `was` and `edit` guards.
Local-only collections still expose no generated verbs.

### The host answer on the wire

The runner owns the distinction between invoking an action and declining to
invoke it. CLI JSON prints its answer, MCP puts it in `structuredContent`,
and HTTP puts it in the terminal event's `answer` field. Each host answer
has exactly two own fields, `data` and `error`.

| What the runner observed | Host answer | CLI exit | MCP `isError` |
| --- | --- | --- | --- |
| The action returned Ok | `{"data":["LAX"],"error":null}` | 0 | omitted |
| The action returned Err | `{"data":null,"error":{"kind":"returned","reason":{"name":"NoRoute","message":"No route from LAX","airport":"LAX"}}}` | 1 | true |
| The action threw or produced an invalid answer | `{"data":null,"error":{"kind":"fault","message":"Unexpected end of input"}}` | 1 | true |
| The host refused to invoke the action | `{"data":null,"error":{"kind":"refused","reason":{"name":"Usage","message":"title is needed"}}}` | 2 | true |

Only the host assigns the outer `kind`. An action can save a draft and
forward a child's refusal. The runner labels that answer `returned` and
preserves the entire reason, including any application-defined `kind`.
If the caller omits required input, the host can return that same reason
under `refused` before the draft action executes. The reason alone cannot
tell a caller whether a write occurred.

A fault can carry a JSON-safe tagged exception in `thrown`. Returned
errors preserve the public `name`, `message` and JSON fields. The CLI
prints success data on stdout or a diagnostic and available next step
on stderr. Top-level `Ok(undefined)` and `Ok(null)` both encode as
`{"data":null,"error":null}`. An object inside `data` keeps its own shape.
An invalid action Result or an unserializable payload produces a bounded fault.

### HTTP and replay

`POST /.runs/<app>/<action>/<id>` admits or joins a run. A successful
admission streams HTTP 200 NDJSON. For example, the action can decline
after yielding progress:

```json
{"seq":3,"at":"2026-11-16T12:00:00Z","type":"finished","answer":{"data":null,"error":{"kind":"returned","reason":{"name":"NoRoute","message":"No route from LAX","airport":"LAX"}}}}
```

A definitive admission refusal returns the flat Result as the HTTP body,
keeps the HTTP error status and sets `X-Epicenter-Admitted: false`.
A refused observer attachment can carry `X-Epicenter-Admitted: true`:
the run already exists. An observer failing to attach receives a transport
diagnostic. Losing the response after submission leaves the outcome unknown.
Observe the same run ID to learn what happened. Stopping observation can
leave the action running.

`connect()` and `runs.start(...).result()` expose the action's Result.
They unwrap `returned.reason`, map faults to `Threw` and definitive
admission refusals to `Refused`. A malformed answer or lost connection can
give the observer `Unreachable`. Inspect the host answer to distinguish a
returned platform refusal from one issued by this host.

Replay delivers recorded events without invoking the action again. If
the executing host cannot store an answer, it records a bounded
`interrupted` event where possible. Delete uploaded input bytes after a
durable Ok. Retain them after a returned Err, fault or interruption until
expiry.

### Cutover

Deploy dual-format readers before enabling flat writers. Rebuild the app
pages with the new client and update raw CLI consumers, including routines.
Readers accept the 0.2.0 `{result}`, `{fault}` and `{error}` shapes, including
the HTTP admission marker in old response bodies. They also accept the
earlier `{returned: value}` and `{threw: ...}` events with ADR-0914's original
meaning. A historical returned value that resembles a Result remains success
data. Keep stored events as written.

A page already open before the reader release still executes the code it
loaded. The 0.2.0 decoder can display a flat fault as `Refused` and a flat
success as an invalid answer. Reload that page and observe its existing run ID after a wire
upgrade. Check persisted state before repeating work with an uncertain
outcome.

## Consequences

A caller that needs the same answer can return the callee's Result. Branches
belong where a caller recovers, changes the meaning of absence, or presents
a failure. Infallible actions now write `Ok(value)`. Audit nested calls that
discard a Result, including writes in generator actions. Definition errors
still throw at app load. Filesystem adaptation, retry loops, lock release
and generator cleanup keep the exception handling their dependencies require.

## Considered alternatives

- Allowing both plain values and Results would give a valid business object with `data` and `error` keys two meanings.
- Sending refusals through `threw` would require the client to reconstruct the distinction the runner already observed. Wrapping every app error in `Refused` would also hide the error name callers use to recover.
- Keeping a tolerant `get` beside a strict `need` would protect only callers that require a record. Both optional and required reads need to distinguish a missing file from a malformed one.
