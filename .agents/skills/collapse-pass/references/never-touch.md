# Never-Touch and Pause List

Codebase-specific facts that the collapse pass must respect. These strings, shapes, and packages outlive any individual session; changing them silently breaks on-disk data, sync, or downstream consumers.

## Durable strings: never change without explicit product decision

These appear in on-disk paths, sync wire format, or schemas other apps validate against. They are part of the durable vocabulary of Epicenter.

### IndexedDB database name

```
"epicenter/{namespace}/private"
"epicenter/{namespace}/workspace/{principalId}"
```

The durable address of one browser document (`packages/app/src/data/store/browser.ts`), holding the three relations that have to survive a reload: `updates`, `outbox`, and `cursor`. It reads as ownership (ADR-0233): the application, then the private document or the account whose replica this is. Changing the shape detaches every existing store from its consumer, and what is lost is not the work (the authority still owes it to the device) but the guarantee that a reload sees it.

Three identities meet here and none may stand in for another: the namespace (which application), the principal id (whose replica), and the authority document id (which current Yjs document, kept inside the store because rebuild changes it).

`epicenter-store-{namespace}` and `epicenter-store-{namespace}#{private,workspace}` are the superseded shapes. They are deletion targets at every open, never read.

### Durable Object name format and URL shape

```
"principals/{principalId}/stores/{namespace}"
```

One store authority per principal and application (ADR-0225), named in `packages/server/src/store-sync/route.ts`. Changing the format detaches every authority from its data.

The wire shape is not parallel to it, and that is deliberate: the connect URL is one path, `/api/store/v1/sync?namespace=...&cursor=...` (`packages/sync/src/store-route.ts`). Whose data it is never appears in the query, because it comes from the resolved bearer server-side, so no value a client puts there can reach another partition (ADR-0092). Do not "fix" the asymmetry by moving the principal into the URL.

In the per-user topology `principalId` is the signed-in user's id; in the instance topology it is the literal `INSTANCE_PRINCIPAL_ID` (`'instance'`). The path is uniform across topologies.

### Public arktype schemas

Other apps validate inputs against these by name and shape. Renaming a field or changing a brand silently invalidates their parsers.

- `PersistedAuth` (`packages/auth/src/auth-types.ts`)
- `ApiSessionResponse` (`packages/auth/src/auth-types.ts`)
- `PrincipalId`, `INSTANCE_PRINCIPAL_ID` (`packages/principal/src/principal.ts`)

Per-user vs instance partitioning is intentionally NOT in this list: there is no
`OwnershipRule` engine or discriminated union (the old `perUser` / `instance`
constants and `packages/server/src/ownership.ts` are gone). The partition path
is one unconditional `principals/<principalId>/` shape in
`packages/server/src/principal.ts`; which principal a request resolves to is
decided at the bearer resolver, carries no arktype validator, and never crosses
the wire as config.

### Root names inside a document

An application is one `Y.Doc` whose roots are `tables:{name}` and `kv` (`packages/app/src/data/store/document.ts`). `Doc.get` is `setIfUndefined`, so it mints on miss, and a root can never be removed: renaming one strands every row under the old name permanently.

## Pause and ask before

The collapse pass should stop and surface to the user (not silently proceed) when about to:

- Change any string from the list above
- Delete a public exported name that has zero in-repo callers but plausible external consumers. Nothing here is published today (every package is `private: true`) and the MIT tier was dissolved, so the old dist-emitting examples are gone; the judgement still applies to any name a downstream tool could reach
- Collapse two files where one's JSDoc documents a non-obvious invariant (the JSDoc is the documentation of a contract; losing it loses the contract)
- Merge packages or move exports across package boundaries
- Change a function signature that crosses a published package boundary
- Collapse a `defineErrors` factory call to an inline `{ name, message, ...fields }` object, even for a single-variant log-only error. The factory call is the idiomatic shape; see `define-errors`, `error-handling`, and `logging` skills. Single-variant `defineErrors` is fine: the variant tag carries idiom consistency, forward-compat, self-documenting call sites, and a centralized message template that prevents drift across multiple log sites.

## Scope tiers

Default collapse-pass targets, narrowest to widest:

1. `packages/auth`
2. `packages/app`
3. `packages/svelte`
4. `apps/api`

Out of scope without an explicit pass declaration:

- First-party apps: `apps/honeycrisp`, `apps/whispering`, `apps/vocab`, `apps/local-mail`. These are owned by separate waves and have their own architecture tests.
- `specs/`, `docs/articles/`, migration history (`*-legacy-*.md`, archived decision docs)
