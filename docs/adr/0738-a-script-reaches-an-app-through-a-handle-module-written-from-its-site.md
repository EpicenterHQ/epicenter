# 0738. A script reaches an app through a handle module written from its site

- **Status:** Superseded
- **Date:** 2026-11-04
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Relates:** [ADR-0731](0731-every-app-signs-in-as-its-site.md) (an app acting as itself names nothing; a script names the app), [ADR-0723](0723-an-apps-site-is-found-by-convention.md) (the contract at `/contract.json`), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names from the host), [ADR-0737](0737-an-apps-actions-are-request-notes-it-watches-in-this-devices-place.md) (request notes).
- **Unbuilt:** all of it: `epicenter add`, `epicenter run`, `open(handle)`, and `epicenter check` comparing a handle with its site's live contract.

## Context

An app opens its own data with `openDevice(contract, …)` (the
`@epicenter/folder` entries for `/node`, `/tauri`, and `/browser`) or
`openRemote(contract, { account, site })` (`packages/folder/src/remote.ts`).
The app imports its own contract and knows its own site.

A script that reads Whispering's recordings has neither. It can fetch
`https://whispering.epicenter.so/contract.json` at run time, which gives it
no types, or copy the contract by hand, which goes stale without notice when
the app adds a field. ADR-0731 named the shape a script should use,
`open(handle)`, without saying where a handle comes from.

## Decision

**A script reaches an app through a handle module: `{ site, contract }`.**
`epicenter add <site>` fetches `<site>/contract.json` and writes the module
into the current directory, named by the app's derived name:

```ts
// whispering.ts, written by: epicenter add https://whispering.epicenter.so
import { defineContract } from '@epicenter/definition/contract';

export default {
	site: 'https://whispering.epicenter.so',
	contract: defineContract({ /* the site's contract.json */ }),
};
```

**A script opens the handle with `open(handle)`** and gets the contract's
typed client over the app's folder at its derived path.

```ts
import whispering from './whispering.ts';

const recordings = await open(whispering).recordings.list();
```

**`epicenter run <file>` runs a script under Bun,** with the packages a
handle and `open` need.

**`epicenter check` flags a handle whose contract no longer matches its
site's live contract.** Re-running `epicenter add <site>` rewrites the
module.

**An app acting as itself names nothing; a script names the app.** The
handle carries the site, so a script never states a path, a repository, or
a client id.

## Consequences

- A script gets types for the app's data at the version it added, and a
  check that says when the app has moved on.
- A handle module is a copy of the contract, and a cache of the site's file:
  deleting it loses nothing, and `epicenter add` rebuilds it.
- A script that ignores `epicenter check` keeps running against the old
  contract until a write is refused.
- Scripts need Bun, through the engine or installed separately.

## Considered alternatives

- **Fetch the contract at run time.** No types, and every run needs the
  network.
- **A package per app on npm.** Every app owner publishes and versions a
  package in addition to their site.
- **Scripts pass a path and a contract to `openDevice`.** Every script
  repeats the derived path and its environment.
