# Unnecessary promise conversions

Read when auditing empty promise callbacks, value-discarding adapters,
or promises used only to signal completion.

Hunt for conversions that exist only to satisfy an unnecessarily narrow
receiving type, or remain after that type has changed.

## Search the audited scope

Start with the package or directory under review:

```bash
audit_scope=packages/server/src
```

Find fulfillment callbacks that discard their input without doing work:

```bash
rg -n -U '\.then\s*\(\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(\{\s*\}|undefined\b)' \
  "$audit_scope" --glob '*.ts' --glob '*.svelte'
```

Search more broadly for callbacks and receiving declarations:

```bash
rg -n '\.then\b|Promise<void>|Promise<unknown>' \
  "$audit_scope" --glob '*.ts' --glob '*.svelte'
```

These are search leads. Comments, test fixtures, and useful callbacks
will appear. Named callbacks and other spellings can escape the first
pattern. Follow the relevant assignments, calls, and declarations.

No matches is a valid result. `rg` exits with status 1 when it finds none.

## Follow the promise and its consumers

For each candidate:

- Identify what the original promise resolves to.
- Read the callback body and any rejection handler.
- Find the receiving declaration and how consumers use the result.
- Establish whether the callback performs work, transforms a result,
  or exists only to discard a value.

When a consumer only waits for completion and ignores the result,
consider accepting `Promise<unknown>` at that boundary. If it already
does, the adapter may be a leftover.

Keep deliberate `Promise<void>` contracts when the operation should
expose no result. Accepting `Promise<unknown>` alone does not prove
that consumers ignore the value; inspect their uses.

An empty fulfillment callback creates a new promise that resolves to
undefined. Removing it can change the observed value, promise identity,
and scheduling. Check relevant callers before treating removal as safe.

Check rejection handling separately. An empty fulfillment callback and
an empty rejection handler do different jobs.

## Historical example: an IndexedDB readiness promise

Commit `db302ffec4`, dated May 4, 2026, removed this adapter from
`packages/workspace/src/document/attach-indexed-db.ts`:

```diff
- whenLoaded: idb.whenSynced.then(() => {}),
+ whenLoaded: idb.whenSynced,
```

The receiving declaration already accepted:

```ts
whenLoaded: Promise<unknown>;
```

The callback performed no work. It discarded the resolved value, while
the declared readiness contract already allowed the original promise.

Inspect the historical change with:

```bash
git show db302ffec4 -- \
  packages/workspace/src/document/attach-indexed-db.ts
```

This is a historical example from the retired workspace package.
It illustrates a conversion that outlived its type-level purpose.
It does not establish that every empty callback can be removed.

For a new candidate, verify that consumers need completion rather than
the undefined result or another observable property of the adapter.

## Current example: closing after queued work

[Cloud request middleware](../../../../packages/server/src/create-cloud-context-middleware.ts)
contains:

```ts
opts.afterResponse(
  c,
  Promise.allSettled(queue).then(() => close()),
);
```

The receiving hook accepts `Promise<unknown>`, and the callback discards
the settlement results. But it also closes the database connection.

The sequence matters:

1. Every queued promise settles.
2. `close()` runs.
3. The promise handed to `afterResponse` includes completion of `close()`.

Keep this callback. Replacing the chain with `Promise.allSettled(queue)`
would omit cleanup.

The existing
[middleware tests](../../../../packages/server/src/create-cloud-context-middleware.test.ts)
check that the connection stays open until queued work settles,
including failed work and handler failures.

The audit verdict is to preserve the cleanup sequence. The broad search
found useful behavior, not an unnecessary conversion.

## Report the consequence

For a proposed removal, explain why the conversion exists, why the
receiving contract does not require it, and what consumer behavior
must remain.

For a consequential decision to keep a callback, identify the work,
result contract, or ordering it preserves.

A `.then(...)` match alone is not a finding.
