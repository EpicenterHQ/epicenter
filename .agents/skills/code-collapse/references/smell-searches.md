# Smell searches

Searches that find candidates for a collapse pass in TypeScript and Rust.
A match is a lead, not a finding. Read the surrounding code, decide whether
it is a real smell, a justified boundary, or a test fake, and group the real
ones by cause before fixing them.

## Work something else already does

These need reading more than matching. Start from where the code hands work
to something it does not own, then read what runs before and around that
call.

```bash
rg -n 'Bun\.spawn|spawnSync|execFile|\$`|fetch\(|\.request\(' <scope> --glob '*.ts'
rg -n -i 'retry|attempt|backoff|resume|dedupe|idempot|pending|outbox' <scope> --glob '*.ts'
rg -n 'Runner|Client\b|\bdeps\b|inject' <scope> --glob '*.ts'
```

**Checks in front of a tool that checks.** Format, size, length, or content
checks just before a program, server, or library that enforces the same
thing. If the code calls the tool anyway, call it unconditionally and turn
its failure into the error the caller sees. An audio module checked the
format and parsed WAV headers to measure loudness before running ffmpeg. Once
ffmpeg converted every clip, trimmed leading silence, and kept the first 120
seconds, an empty output meant silence and the checks went. Keep a check that
is cheaper than the call, or that protects something the tool cannot see.

**Guessing what another program accepts.** Code that predicts a refusal, such
as by matching known formats or mirroring a server's limits, instead of
asking. The copy drifts when the other program changes. Send the request and
read the answer.

**Machinery for a promise nobody needs.** Retries, resumable state,
deduplication, caches, saved in-flight work, and crash recovery each protect
a guarantee. Name the guarantee and ask the user whether they need it. For
short, easily repeated actions, losing work in a crash or making the odd
duplicate is often a better trade than the code that prevents it.

**Seams only tests use.** An injected runner, client, or clock with one real
implementation, there so a test can swap it. Test through the real thing
when it is fast and local, such as ffmpeg on a fixture, and fake only the
slow or remote part at its outer edge, such as an executable that prints
canned output.

## TypeScript

**Duck typing.** Code that guesses what an object contains instead of using
the type that owns it.

```bash
rg -n 'as\s+\{[^}]*\??:\s*unknown|as\s+Record<string,\s*unknown>' <scope> --glob '*.ts' --glob '*.svelte'
rg -n "['\"][^'\"]+['\"]\s+in\s|Object\.hasOwn\(" <scope> --glob '*.ts' --glob '*.svelte'
```

Follow the value to where it is created and find the type that describes it.
Fix the type at its owner, or derive from it. Keep a check that recognizes a
supported capability, or that narrows `unknown` input at an IPC, JSON, or
`catch` boundary where the shape is not known yet. An adapter that accepts
any member with a `subscribe` method is one.

**Hand-rolled error inspection.** Code that pries a message or a kind out of
an unknown thrown value instead of using Wellcrafted.

```bash
rg -n 'instanceof\s+\w*Error' <scope> --glob '*.ts' --glob '*.svelte'
rg -n 'try\s*\{' <scope> --glob '*.ts' --glob '*.svelte'
```

`cause instanceof Error ? cause.message : String(cause)` is
`extractErrorMessage(cause)` from `wellcrafted/error`. A `try`/`catch` that
turns a failure into a value is `trySync` or `tryAsync`, with a
`defineErrors` variant built from the raw `cause`. Branching on an error's
class to decide what happened usually means the failure should be a tagged
variant the caller can switch on by `name`. Keep `try`/`catch` where the
`error-handling` skill says it expresses the contract, such as catching one
known exception and rethrowing the rest.

**Timers standing in for events.** A timer often waits for something that
another part of the code already knows has happened.

```bash
rg -n 'setTimeout|setInterval|debounce|throttle|sleep\(|retry' <scope> --glob '*.ts' --glob '*.svelte'
```

For each, name the event the timer is guessing at. If the owner of that
event can resolve a promise, emit, or return when it is done, wait on that
instead. Keep a timer whose delay is the requirement: a user-facing debounce
on typing, a scheduled job, backoff against a remote service, or a timeout
that bounds work you do not control.

**Hand-rolled async state.** Loading, saving, and error flags kept beside a
request, and manual refetches after a write, recreate TanStack Query.

```bash
rg -n 'let\s+\w*(loading|Loading|pending|Pending|saving|busy|error)\w*\s*=\s*\$state' <scope> --glob '*.svelte' --glob '*.ts'
rg -n '\$effect\(' <scope> --glob '*.svelte' --glob '*.ts'
```

Reads a page observes belong in `resultQueries` and writes in
`resultMutations`. Refresh after a write is one invalidation rule on the
`MutationCache`, and an optimistic update is the mutation's `onMutate` with
rollback in `onError`. See the `query-layer` skill and its mutation
lifecycle reference. An `$effect` that fetches and assigns is usually a
query; one that copies state into other state is usually `$derived`.

**Promise conversions that do nothing.** `.then(() => {})` written only to
satisfy a narrow receiving type.

```bash
rg -n -U '\.then\s*\(\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(\{\s*\}|undefined\b)' <scope> --glob '*.ts'
```

If you own the receiver and it only waits for completion, accept
`Promise<unknown>` and drop the adapter. A library's receiver type is not
yours to change. Keep a callback that does work: `Promise.allSettled(queue).then(() => close())`
closes a connection after the queue settles, so removing it skips cleanup.

**Logging that bypasses the logger.** Direct `console.*` calls, custom
wrappers, and direct sink writes in library code. Move them to
`wellcrafted/logger` (see the `logging` skill) and keep the original cause.
Application and command output is not a diagnostic.

**Switches that miss cases.** A switch or `if/else` chain that handles every
variant of a closed union should give each case a branch and end with
`default: value satisfies never`, so a new variant fails the build instead of
falling into an `else`.

```bash
rg -n '\bswitch\b' <scope> --glob '*.ts'
rg -n "\.error\.name === '" <scope> --glob '*.ts' | rg -v test
```

Keep a fallback when the value can hold input the type does not list, such as
an error from `invoke` that the declared union does not cover. See
`error-handling` for the rule.

**Single-method `Pick`.** `Pick<Thing, 'method'>` keeps an old object boundary
alive after the caller needs one operation.

```bash
rg "Pick<[^>]+,\s*['\"][^'\"|]+['\"]\s*>" packages apps
```

Most hits pick a field, which is a fine data projection. Look only at hits
that pick a method.

Write the caller's one-sentence job and inline the picked method. If the
sentence names only one verb, take a named function instead of the object and
fake that function in tests. `Pick` is fine for data projection and
multi-field views.

## Rust

```bash
rg -n '\.unwrap\(\)' --glob '*.rs' --glob '!**/tests/**'
rg -n -B2 'Result<[^>]*,\s*String>' --glob '*.rs'
```

A bare `.unwrap()` outside tests and startup needs an `expect` with a reason
or a returned error. `expect("reason")` already states the invariant, and
`lock().unwrap()` on a mutex is idiomatic, so leave both. Only a
`Result<_, String>` on a `#[tauri::command]` matters: it hides the error
type from the TypeScript that must handle it, so return a typed error that
serializes to a union (see the `tauri` skill). Internal helpers may keep
`String`.
