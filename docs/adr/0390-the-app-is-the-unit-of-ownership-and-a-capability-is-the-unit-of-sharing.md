# 0390. The App is the unit of ownership, and a capability is the unit of sharing

- **Status:** Accepted
- **Date:** 2026-09-12
- **Amended by:** [ADR-0392](0392-product-boundaries-provide-required-resource-handles.md) moves required inputs to product boundaries. [ADR-0423](0423-app-resources-open-as-independent-handles.md) moves ownership into independent handles; consumers borrow explicit resources. [ADR-0396](0396-transcription-operations-preserve-destinations-and-results.md) assigns destination capture and outcome propagation to application operations.

## Context

Shared code in `packages/app-shell` takes `Pick<App<DataDefinition>, 'ai' |
'account'>`. It picks `account` for one reason: to build a stable inference
identity from the account's authority and principal, then look the client up
on `app.ai.account`. The AI capability was bound to that account at open and
then forgot which one, so the consumer reaches back into the handle for the
fact.

A Pick of the handle in shared code constrains the handle's shape. It is the
reason a local App could not simply lack `account`: every arm of a union must
carry every key a Pick names.

## Decision

**The page that opened an App holds the App; everything it hands to shared
code is a capability, and shared code never takes a subset of the handle.**

A `Pick<App, …>` in shared code means a capability is missing a fact it
should carry, and the fix is to add the fact to the capability.

`AppAi.account` carries the identity it was bound to:

```ts
type AppAi = {
  account: { identity: AccountIdentity; client: OpenAI } | null;
  runtime: { client: OpenAI } | null;
  connections: AiConnections | null;
};
```

`packages/app-shell` inference selections and the inference picker take `ai:
AppAi` and nothing else from the App.

## Consequences

- `accountInferenceId`, `runtimeInferenceId`, and `matchInferenceTarget` in
  `inference-selections.ts` and `createInferenceConnections` in
  `inference-picker/connections.svelte.ts` take `AppAi`; the inference
  identity is built from `ai.account.identity`.
- The App's union arms may drop keys, which [ADR-0389](0389-the-open-call-decides-the-app-s-type-and-a-local-app-has-no-account-members.md) relies on.
- A new shared component states which capability it needs in its signature,
  and a reader learns what it touches without reading its body.
- "Capability" in this sense matches `SyncCapability` and
  `PersistenceCapability` in `@epicenter/data` and ADR-0366; it earns a
  `docs/CONTEXT.md` entry when these records are accepted.

## Considered alternatives

- **A narrower Pick.** Still a subset of the handle, still couples shared code
  to the handle's key set. Refused.
- **Passing the whole App to shared code.** Hands ownership-shaped power
  (`close`, `sqlite`) to code that should only read one capability. Refused.
