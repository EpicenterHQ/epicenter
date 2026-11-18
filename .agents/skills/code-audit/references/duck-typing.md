# Duck typing

Read when auditing runtime shape checks, casts to locally invented object
shapes, or property access through `Record<string, unknown>`.

Hunt for code that guesses what an object contains. Look for opportunities
to replace those guesses with the contract that owns the value.

## Search the audited scope

Start with the package or directory under review:

```bash
audit_scope=apps/api/ui/src/lib
```

Find casts that let code inspect properties its existing type does not declare:

```bash
rg -n 'as\s+\{[^}]*\??:\s*unknown|as\s+Record<string,\s*unknown>' \
  "$audit_scope" --glob '*.ts' --glob '*.svelte'
```

Find shape checks that may appear without a cast:

```bash
rg -n "\btypeof\b|['\"][^'\"]+['\"]\s+in\s|Object\.hasOwn\(|\.hasOwnProperty\(" \
  "$audit_scope" --glob '*.ts' --glob '*.svelte'
```

These are search leads. Results include ordinary value validation,
type-level `typeof`, and test fixtures. Multiline casts and indirect
helpers can escape the patterns. Follow relevant calls and declarations.

Once a property or guard looks relevant, search for its producers and uses:

```bash
rg -n '\bsubscribes\b|subscribe\(listener' \
  apps/api/ui/src packages/ai/src
```

Substitute the names involved in the candidate being investigated.

## Follow the agreement

For each candidate:

- Trace where the value is created and which contract describes it.
- Identify what the consumer needs to know.
- Compare what the check establishes with what the following code assumes.
- Look for missing declarations, copied shapes, repeated checks, and
  fallbacks that hide a broken agreement.

When the contract is missing or inconsistent, repair it at its owner and
carry the change through consumers. Import or derive an existing type when
it already expresses the agreement. A cast alone does not validate input.

Keep runtime checks that recognize a supported capability or validate
input whose shape is not yet known. Establish why the check is sufficient
for its callers. A comment can explain that reasoning, but cannot replace it.

## Worked example: recognizing a capability

A capability says it changed through one `subscribe(listener)` that
returns the unsubscribe
([ADR-0769](../../../../docs/adr/0769-svelte-reads-every-capability-through-one-reactive-copy.md)).
The dashboard's Svelte adapter,
[reactive.ts](../../../../apps/api/ui/src/lib/reactive.ts), adapts any
member that holds its own `subscribe` as a capability of its own and passes
other values through.

The search finds this check inside `subscribes`:

```ts
typeof (value as { subscribe?: unknown }).subscribe === 'function'
```

Follow the producers.
[openAi](../../../../packages/ai/src/open-ai.ts) declares
`subscribe(listener: () => void): () => void` on the object it returns,
as every capability factory does.

Then follow the consumer. `adapt` runs the check on each member and on
each value a read answers:

```ts
if (isObject(value) && subscribes(value)) return own(value);
```

Keep this guard. The adapter accepts capabilities it has never seen, so no
single type can describe them; the convention owns the contract.

The check establishes that `subscribe` is callable. The listener and
unsubscribe contract comes from the convention. Do not treat this guard as
validation of an arbitrary external object.

If another consumer independently guesses the same shape, investigate
whether it should use the existing contract and guard.

## Report the consequence

For a repair, identify the assumption, what it could break, and how the
proposed contract removes that uncertainty.

For a consequential decision to keep a check, explain the runtime
distinction it serves and the evidence supporting it.

A search match alone is not a finding. Do not manufacture a cleanup when
the existing contract and check already serve their callers.
