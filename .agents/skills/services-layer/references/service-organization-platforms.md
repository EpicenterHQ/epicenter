# Service Organization And Platform Variants

This reference covers where an app's services live and how each build gets
its own implementation.

## One seam, one type

An app keeps the contract its builds share in one types file and one leaf
per build. Whispering:

```txt
src/lib/platform/
|-- types.ts              WhisperingServices, CreateServices (the contract)
|-- browser.ts            #platform/services in the web build
|-- services.tauri.ts     #platform/services in the desktop build
|-- microphone.tauri.ts   the shell's microphone, imported only by desktop leaves
`-- fetch.tauri.ts        shellFetch over send_request, likewise
```

```jsonc
"#platform/services": {
  "tauri": "./src/lib/platform/services.tauri.ts",
  "default": "./src/lib/platform/browser.ts"
}
```

```ts
// types.ts
export type CreateServices = (client: Client<Whispering>) => WhisperingServices;

// services.tauri.ts
export const createServices: CreateServices = (client) => ({ capture, transcribe, transform, connections, … });
```

Shared code imports `createServices` from `#platform/services` once, where
the app is assembled. A desktop-only helper (`microphone.tauri.ts`) is
imported by the desktop leaf directly, never through a seam. A capability
only one build has is an optional member of the contract
(`connections.useLocal?`), not a second seam.

## A smaller seam for one capability

When only one capability differs, give it its own seam rather than a
services object. Vocab's `#platform/connections` exports `openConnections`:
the web leaf is `openLocalConnectionCatalog` from `@epicenter/ai/connections`
(browser storage, keys included); the desktop leaf keeps the endpoint list in
`connections.md` in the AppData root and each key in the keychain under the
connection's id, applying a key only while the connection still names the
endpoint it was saved for.

## Desktop services and the shared crates

A standalone desktop app's shell is `epicenter-standalone` plus, for an app
that signs in, `epicenter-account`. A desktop service uses what they expose
and adds nothing that holds a credential in the page:

| Need | Desktop leaf uses |
| --- | --- |
| A secret (API key, connection) | `keychain` from `@epicenter/auth/tauri` |
| A request with the person's account | `account.fetch` from `createTauriAuth`, relayed by `account_fetch` |
| A request to a custom endpoint | the app's own shell command (Whispering's `send_request`) |
| A native command over the data folder | `rootOf(device)` from `@epicenter/folder/tauri` as its `root` |

The web leaf's equivalents are `localStorage`, browser OAuth's
`account.fetch`, and `fetch` (which needs the endpoint's CORS rule).
