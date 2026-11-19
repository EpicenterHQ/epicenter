# Smell searches

Searches that find candidates for a collapse pass in TypeScript and Rust.
A match is a lead, not a finding. Read the surrounding code, decide whether
it is a real smell, a justified boundary, or a test fake, and group the real
ones by cause before fixing them.

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
