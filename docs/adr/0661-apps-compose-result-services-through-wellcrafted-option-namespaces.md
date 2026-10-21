# 0661. Apps compose Result services through Wellcrafted option namespaces

- **Status:** Proposed
- **Date:** 2026-10-21
- **Unbuilt:** Adoption of Wellcrafted's proposed `createQueries` and `createMutations` exports, including migration of the dashboard's read definitions and shared mutation invalidation.
- **Relates:** [Wellcrafted](https://github.com/wellcrafted-dev/wellcrafted), `docs/adr/0001-result-namespaces-produce-native-tanstack-options.md`, for the library-owned conversion contract.

## Context

The dashboard's `apps/api/ui/src/lib/billing/queries.ts` repeats billing method
names in `billingKeys` and in `createBillingQueries`, then forwards arguments
through `defineQuery` and `defineMutation`. Account queries use the same
pattern. Components consume `.options`; billing and account components also
decide when to invalidate their cached reads.

The libraries and the app have different responsibilities. Wellcrafted can
derive keys and convert Results into native TanStack options. The application
knows whether an operation belongs in its query cache, which observations a
mutation affects, and when a successful request represents a completed change.

Billing demonstrates why those decisions cannot come from HTTP methods or
Result types. `usage` and `events` are reads sent as POST. `portal` uses GET to
open a billing interaction. `previewPlanChange` reads information but uses
mutation state. Checkout can return a payment URL before a purchase completes.

`createDashboardRuntime(account)` also owns a boundary that the mapping must
preserve: one captured Account, its transport clients, and a fresh QueryClient
per dashboard attachment. Its tests cover late results after both different-
principal and same-principal replacement.

## Decision

**An app composes regular Result-returning service functions into separate
query and mutation namespaces using Wellcrafted's options factories.** The
application owns selection and cache policy; Wellcrafted owns mechanical key
generation and Result adaptation. The proposed helper exports are not present
in Epicenter's installed Wellcrafted 0.44 API.

Folder's `createFolderQueries` and file-representation readers keep their
explicit options: their keys describe paths and representations, and their
functions use query context or resource objects. Whispering's `track` and
`action` adapters also stay explicit because they own scope-keyed work and
closing fences. The shared library upgrade changes their execution adapters,
not their product responsibilities.

Compose the two namespaces directly where their service instance is available:

```ts
const usersKey = ['users'] as const;

const userQueries = createQueries(usersKey, {
  getUser: userService.getUser,
  listUsers: userService.listUsers,
});

const userMutations = createMutations(usersKey, {
  updateUser: {
    mutationFn: userService.updateUser,
    onSuccess: async (_saved, input, _rollback, { client }) => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: userQueries.getUser(input.id).queryKey,
          exact: true,
        }),
        client.invalidateQueries({ queryKey: userQueries.listUsers.key }),
      ]);
    },
  },
});
```

**Services keep their Result-returning API without TanStack annotations.**
Membership in `createQueries` or `createMutations` states the app's observation
choice. A selected function may keep a real wrapper that fixes transport
arguments, binds its receiver, or transforms several service arguments into
one mutation input. For example, account queries still fix
`disableCookieCache: true` and select the nested passkey read.

No `createUserQueries` or `createUserMutations` wrapper is required. Separate
namespaces can share one module. Extract a domain factory only when it owns
construction or reuse that the app actually needs.

**Mutation definitions own shared cache policy; components own interaction
effects.** A definition can invalidate query prefixes, update exact entries, or
coordinate a coherent optimistic update through native TanStack callbacks.
Cross-domain invalidation names the other domain's generated keys. Queries
need no dependency on mutation definitions. If a read needs an ID returned by
a mutation, the component or application operation passes that ID to the read.

```ts
const user = createQuery(() => userQueries.getUser(userId));
const updateUser = createMutation(() => userMutations.updateUser());

updateUser.mutate(
  { id: userId, name },
  { onSuccess: () => closeDialog() },
);
```

The shared `onSuccess` runs for mutations executed from those options; the
component callback adds local behavior. Per-call callbacks can be skipped after
observer removal, so they do not own invalidation required by other observers.
Return the invalidation promise when pending state needs to include the refresh.
Do not replace the shared `onSuccess` with a spread override at a component.

Billing's checkout callbacks invalidate billing reads only when the outcome
indicates completion, represented by the absence of `checkoutUrl` in its
existing contract. Starting an external checkout is not purchase completion.
Preview and portal operations do not acquire blanket invalidation merely
because the app observes them as mutations. Redirects, dialog closure, and
toasts remain component behavior with their existing departure guards.

**The app runtime retains ownership of service and cache lifetimes.** For the
dashboard, construct account-bound option factories inside
`createDashboardRuntime(account)`, using its captured transport clients. Hooks
execute with that attachment's provider client; mutation callbacks use their
executing `context.client`. Disposal retains the existing lifetime signal and
cache clearing. Neither principal identity alone nor a module singleton
replaces attachment identity.

Returned values are ordinary TanStack options: `.queryKey` identifies a read,
`.mutationKey` identifies a mutation operation, and `.key` on a generated
factory is its group prefix. Generated query keys end with one argument tuple,
including `[]` for zero-argument reads. Exact filters and cache reads use the
full `.queryKey`; method prefixes can also match nested namespaces and carry
no type claim about one cached value. Components own their individual query or
mutation observers. Workflows that need Results execute the same options through
Wellcrafted's `runQuery` or `runMutation` after the compatible library upgrade.
Direct service calls remain available and bypass adapter cache policy.

## Consequences

- Regular reads lose duplicated key maps, argument annotations, and forwarding
  functions. Mutation definitions retain the cache relationships that cannot
  be inferred, with shared policy declared once for all consumers.
- The application retains selection maps and explicit exceptions. Stable,
  serializable read arguments and method names determine generated identity.
  Custom keys or normalization can use Wellcrafted's explicit options adapters.
- Library implementation and a compatible dependency upgrade precede adoption.
  Wellcrafted's checked-out 0.45 source has options adapters and Result runners,
  but neither proposed namespace helper. No dashboard migration happens merely
  by recording the decision.
- Align the framework adapter and direct query-core dependencies during that
  upgrade. Wellcrafted's runners require query-core 5.102 or later; Epicenter's
  pinned 5.96.2 and installed Svelte adapter cannot supply `client.query`.
- Migration preserves mutation pending/error state, conditional checkout
  behavior, and the dashboard's late-result isolation tests. The proposal does
  not replace Folder's edit lifecycle with service mutations.

## Considered alternatives

- **Keep every definition handwritten.** This retains independent control of
  each key and forwarding function. Use that form for custom behavior; regular
  service namespaces can derive both from their selected methods.
- **Annotate transport services with query and invalidation policy.** This
  makes a reusable capability depend on one app's observations and cache layout.
- **Configure invalidation at each component.** This duplicates shared policy
  and ties it to observers whose per-call callbacks may disappear on departure.
- **Add domain factories around both declarations.** Declaration order already
  lets mutation definitions reference query identities; another wrapper does
  not establish a missing lifecycle.
- **Install an app-wide invalidation dispatcher.** Native mutation callbacks
  already express conditional and cross-domain policy with typed outcomes.
