# Query Layer

This directory is Whispering's Svelte/TanStack observation layer. It adds
query identity, mutation lifecycle state, and cache invalidation around the
UI-free `WhisperingApp` and platform services.

Each recording view creates a query client and namespace bound to its concrete
store. Descendants capture that namespace during initialization. Local and Personal
rows with the same ID cannot share mutation/cache identity. The shell owns a separate
client for app controls. There is no module-global client.

```text
Svelte component
  -> WhisperingQueries
  -> WhisperingApp / operations / services
```

## Ownership

- `client.ts` creates the session-owned QueryClient and Wellcrafted factories.
- `download.ts` adapts the shared download mutation.
- `transcription.ts` adapts shared transcription mutation identity.
- `index.ts` composes those adapters for one ready app and concrete store.

App workflows stay in `$lib/operations` or on
`WhisperingApp`. Query modules do not become a second product API.
Browser and Bun scripts use the app directly and do not depend on
TanStack or Svelte.

Components obtain the namespace during initialization:

```ts
const queries = getWhisperingQueries();
```

Shared definitions expose `.options` for `createQuery` and `createMutation`.
One-component Result operations should use `resultQueryOptions` or
`resultMutationOptions` locally instead of growing this directory.

The name is deliberately `queries`, not `rpc`: this code does not cross a
process boundary. Epicenter's published actions own genuine cross-process
automation.

AudioBlobPlayer owns its disposable source, loading, errors and explicit reopening.
An availability preflight cannot establish that a later media read will succeed.
