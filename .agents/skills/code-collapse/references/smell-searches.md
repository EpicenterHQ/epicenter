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
rg -n "\btypeof\b|['\"][^'\"]+['\"]\s+in\s|Object\.hasOwn\(" <scope> --glob '*.ts' --glob '*.svelte'
```

Follow the value to where it is created and find the type that describes it.
Fix the type at its owner, or derive from it. Keep a check that recognizes a
supported capability or validates input whose shape is not known yet, such
as an adapter that accepts any member with a `subscribe` method.

**Promise conversions that do nothing.** `.then(() => {})` written only to
satisfy a narrow receiving type.

```bash
rg -n -U '\.then\s*\(\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(\{\s*\}|undefined\b)' <scope> --glob '*.ts'
```

If the receiver only waits for completion, accept `Promise<unknown>` and drop
the adapter. Keep a callback that does work: `Promise.allSettled(queue).then(() => close())`
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

**Single-method `Pick` and copied upstream shapes.** `Pick<Thing, 'method'>`,
`*Like` types, `as Record<string, unknown>`, and `Parameters<typeof fn>[n]`
keep an old object boundary alive after the caller needs one operation.

```bash
rg "Pick<[^>]+,\s*['\"][^'\"|]+['\"]\s*>" packages apps
rg "type\s+\w+Like\b|interface\s+\w+Like\b|as\s+\w+Like\b" packages apps
```

Write the caller's one-sentence job and inline the picked method. If the
sentence names only one verb, take a named function instead of the object and
fake that function in tests. `Pick` is fine for data projection and
multi-field views.

## Rust

```bash
rg -n '\.unwrap\(\)|\.expect\(' --glob '*.rs'
rg -n 'println!|eprintln!' --glob '*.rs'
rg -n 'Result<[^>]*,\s*String>' --glob '*.rs'
```

`unwrap` and `expect` outside tests and startup need a reason or a returned
error. `println!` in a plugin or library is a diagnostic that belongs in the
logger the host owns. `Result<_, String>` hides the error type from the
TypeScript side that has to handle it; return a typed error that serializes
to a union (see the `tauri` skill).
