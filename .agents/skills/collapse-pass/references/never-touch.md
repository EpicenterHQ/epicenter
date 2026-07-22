# Never-Touch and Pause List

Codebase-specific facts that the collapse pass must respect. These strings, shapes, and packages outlive any individual session; changing them silently breaks on-disk data, sync, or downstream consumers.

## Durable strings: never change without explicit product decision

These appear in on-disk paths, sync wire format, or schemas other apps validate against. They are part of the durable vocabulary of Epicenter.

### Universal record addresses

The tuple `{ namespace, collection, recordKey }` is durable protocol identity.
Lens namespaces and collection keys persist beyond one release, and record keys
are runtime-minted structural identity. Do not rename or reinterpret any member
without an explicit data migration and protocol decision.

### Durable Object name format and URL shape

```
"principals/{principalId}/rooms/{roomId}"
```

Used by the sync hub to address rooms (`packages/server/src/principal.ts`, `doName()`). Same shape on the wire: `/api/principals/:principalId/rooms/:roomId`. Changing the format breaks the routing contract between client and hub.

In the per-user topology `principalId` is the signed-in user's id; in the instance topology it is the literal `INSTANCE_PRINCIPAL_ID` (`'instance'`). The path is uniform across topologies.

### Public arktype schemas

Other apps validate inputs against these by name and shape. Renaming a field or changing a brand silently invalidates their parsers.

- `PersistedAuth` (`packages/auth/src/auth-types.ts`)
- `ApiSessionResponse` (`packages/auth/src/auth-types.ts`)
- `PrincipalId`, `INSTANCE_PRINCIPAL_ID` (`packages/identity/src/identity.ts`)

Per-user vs instance partitioning is intentionally NOT in this list: there is no
`OwnershipRule` engine or discriminated union (the old `perUser` / `instance`
constants and `packages/server/src/ownership.ts` are gone). The partition path
is one unconditional `principals/<principalId>/` shape in
`packages/server/src/principal.ts`; which principal a request resolves to is
decided at the bearer resolver, carries no arktype validator, and never crosses
the wire as config.

### Identity strings inside documents

- Universal record addresses that own each document
- Authority lifetime identifiers and document publication digests

## Pause and ask before

The collapse pass should stop and surface to the user (not silently proceed) when about to:

- Change any string from the list above
- Delete a public exported name that has zero in-repo callers but plausible external CLI or SDK consumers (the `@epicenter/cli` binary and the `@epicenter/data` published API are the load-bearing examples)
- Collapse two files where one's JSDoc documents a non-obvious invariant (the JSDoc is the documentation of a contract; losing it loses the contract)
- Merge packages or move exports across package boundaries
- Change a function signature that crosses a published package boundary
- Collapse a `defineErrors` factory call to an inline `{ name, message, ...fields }` object, even for a single-variant log-only error. The factory call is the idiomatic shape; see `define-errors`, `error-handling`, and `logging` skills. Single-variant `defineErrors` is fine: the variant tag carries idiom consistency, forward-compat, self-documenting call sites, and a centralized message template that prevents drift across multiple log sites.

## Scope tiers

Default collapse-pass targets, narrowest to widest:

1. `packages/auth`
2. `packages/data`
3. `packages/svelte-utils`
4. `packages/cli`
5. `apps/api`

Out of scope without an explicit pass declaration:

- First-party apps: `apps/whispering`, `apps/tab-manager`, `apps/fuji`, `apps/honeycrisp`, `apps/opensidian`, `apps/vocab`. These are owned by separate waves and have their own architecture tests.
- `specs/`, `docs/articles/`, migration history (`*-legacy-*.md`, archived decision docs)
