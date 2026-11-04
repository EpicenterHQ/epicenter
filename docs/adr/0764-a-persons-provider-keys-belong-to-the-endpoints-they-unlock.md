# 0764. A person's provider keys belong to the endpoints they unlock

- **Status:** Accepted
- **Date:** 2026-11-04
- **Amends:** [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) at the `account` and `ai` rows, which gave the person's provider keys to `account`, and [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) at "a key is added or removed through the keys `@epicenter/account` holds": `@epicenter/ai` holds them.
- **Relates:** [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (where an app keeps its credentials), [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (a capability never imports another's code).

## Context

`@epicenter/account/tauri` exported `keychain`, which reads and writes the
API keys a page saves in the shell's credential store, and
`connectionFetch(id)`, the `fetch` the shell sends with a connection's key.
Vocab kept the store of its connected endpoints, `createKeychainConnections`,
in its own `connections.tauri.ts`, over both. So the key to a `custom`
endpoint (ADR-0757) lived in the sign-in package, the endpoint it unlocks in
`@epicenter/ai`, and the list of endpoints in an app. Whispering needed the
same store and would have copied Vocab's.

## Decision

**A provider key belongs to `@epicenter/ai`, beside the `custom` endpoint it
unlocks.** `@epicenter/account` holds the Epicenter sign-in alone.

```txt
@epicenter/ai/tauri
  keychain                     the shell's credential store, one entry per connection id
  connectionFetch(id | null)   the shell's one fetch: with a connection's key, or none
  shellFetch                   connectionFetch(null): a server on this computer
  createKeychainConnections    connections listed in an AppData note, keys in the store
  connectionsCollection        that note, connections.md, for an app's AppData contract
@epicenter/account/tauri
  createTauriAuth              the sign-in
  relayThroughShell            the one reader of the shell's streamed answers
```

- Storage does not change: the credential store on the desktop, written
  through the shell, and this site's `localStorage` on the web
  (`createBrowserConnections`). ADR-0740's move to one AppData file is still
  its own.
- The shell's commands stay in `epicenter-account`, the one shell crate;
  `keychain_get` and `keychain_set` join `CONNECTION_COMMANDS`, which an app
  that reaches endpoints other than Epicenter's registers.

## Consequences

- An app that keeps provider keys depends on `@epicenter/ai`, which it
  already does to reach the endpoints; Vocab and Whispering share one store.
- `@epicenter/ai/tauri` imports `relayThroughShell` from
  `@epicenter/account/tauri`: the shell's stream reader, not a capability's
  behavior, so the two relays read answers one way.
- An app that signs in but keeps no provider keys registers no keychain
  command.
