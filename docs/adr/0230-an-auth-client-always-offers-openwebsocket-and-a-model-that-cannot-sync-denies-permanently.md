# 0230. An auth client always offers `openWebSocket`, and a credential model that cannot sync denies permanently

- **Status:** Accepted
- **Amended by:** [ADR-0353](0353-a-data-session-keeps-one-account-for-its-entire-lifetime.md) at the universal socket requirement: Account carries HTTP and sync transport, while AuthClient selects accounts. Cookie-only UI has no Account or socket stub; typed runtime transport refusals remain.
- **Date:** 2026-08-09
- **Amended by:** [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md): the final consequence below pointed at parking and resuming in the sync driver. The `SyncDial` contract did gain a signal (`denied`), but there is no parked state and no resume; a permanently denied connection stops for good and a credential change reloads the app.
- **Amended by:** [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md) at the mechanism, not the rule: the `denied` signal ADR-0232 added is deleted and so is `permanence`. "Denies permanently" now means the model refuses from a literal on every dial, reported as `'no-credential-model'` on `status().refusal` and dialled again on backoff. That every client offers `openWebSocket` and answers "can this client sync" at runtime is untouched.
- **Amends:** [ADR-0331](0331-whispering-authenticates-with-an-oauth-bearer-on-every-surface.md) (Whispering authenticates with an OAuth bearer on every surface): its first reason cited a compile error as the thing that stops cookie auth driving sync. The conclusion stands and the mechanism is now a permanent runtime denial.
- **Amends:** [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md) (Epicenter desktop auth is one Bun authority with credential-free windows): the application contract is `AuthClient`, not `SyncAuthClient`. Nothing else about the broker projection changes.
- **Relates:** [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) (the bearer is audience-scoped), [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md) and [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md) (a workspace boots with one `connect(toConnection(auth, nodeId))` call)

## Context

`packages/auth` carried two client shapes: `AuthClient`, and `SyncAuthClient = AuthClient & { openWebSocket }`. The split existed to buy one thing, stated in its own doc comment: passing a client that cannot sync where sync is needed should be a compile error rather than a runtime throw.

It did not buy that. Three capability postures existed against two types. The OAuth family carries a bearer and can open a socket. The same-origin cookie client cannot, and said so by omitting the method. `createDesktopBrokerAuth` also cannot, and said the opposite: it satisfied `SyncAuthClient` and threw `OpenWebSocketDenied` with `permanence: 'permanent'` on every call, because a desktop window holds no credential by design.

So the compile error landed on the one client that never syncs. The only plain `AuthClient` producer was the cookie client, whose only consumer is the billing dashboard, a surface with no sync code to pass it to. Meanwhile the desktop-host build of Honeycrisp typechecked its broker client as sync-capable and attached a sync connection to it.

The deeper reason the split could not work: `openWebSocket` already had a first-class runtime denial channel. `OpenWebSocketDenial` in `@epicenter/sync` discriminates `'permanent'` from `'transient'` precisely so a caller can tell "only an auth state change helps" from "retry may succeed", and any caller that opens a socket has to handle it, because a signed-out client denies too. Once every caller must handle the denial, a second compile-time mechanism guarding the same failure earns nothing.

## Decision

There is one client contract. `AuthClient` declares `openWebSocket`, and `SyncAuthClient` is deleted.

A credential model that can never open a socket denies permanently instead of omitting the method. The same-origin cookie client throws `OpenWebSocketDenied({ permanence: 'permanent', code: 'auth-unavailable' })` because a cookie cannot carry the bearer subprotocol the rooms route requires; the desktop broker client already did, because a window holds no credential.

`OpenWebSocketDenial` is the single answer to "can this client sync". `'permanent'` covers both the client that is merely signed out and the model that can never sync, which are the same fact to a caller: no socket, and no retry will change that until auth state does.

## Consequences

- One name for one concept. `toConnection`, `reloadOnPrincipalChange`, the Svelte wrappers and the app platform seams all take `AuthClient`.
- `reactiveAuthClient` loses its `<T extends AuthClient>` generic and the `as T` cast it forced. The generic existed only to keep a `SyncAuthClient` from decaying to an `AuthClient` across the reactive wrapper.
- The per-app `PlatformAuth` aliases are deleted. Each was a rename of a type the factory already declared, and Honeycrisp's `src/lib/platform/types.ts` held nothing else, so the file goes with it. Whispering's contract file keeps its genuine per-platform shapes.
- The trade-off, stated plainly: handing the dashboard's cookie client to a sync path is no longer a compile error. It is a permanent denial at the first dial. We accept that because the mistake had no live producer, and because the type never caught the one case that was actually wired.
- Callers must respect `permanence`. This is now the only guard, and it is not free: a caller that treats a permanent denial as an ordinary close will retry forever on backoff. The one caller is `packages/app/src/client-owned-data.ts`, which passes the account through as the transport; the classification itself lives in `packages/data/src/sync/attach.ts`, and treating a permanent denial as an ordinary close there would retry forever on backoff. Parking and resuming properly needs a signal in the `SyncDial` contract that `packages/data` does not yet expose.

## Considered alternatives

- **Make the split true: return `AuthClient` from `createDesktopBrokerAuth`.** This is the honest version of the original design, and it would have turned Honeycrisp's `epicenter-host` leaf into the compile error the split promised. Rejected because it keeps two names for a distinction the runtime denial already draws, and forces every consumer to branch on a capability whose failure it must handle anyway.
- **Keep `SyncAuthClient` and document the desktop broker as an exception.** Rejected: an exception to a type-level guarantee is not a guarantee.
