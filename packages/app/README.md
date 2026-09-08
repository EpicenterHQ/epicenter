# @epicenter/app

An app opens a data session for one account and owns that session until it closes.

```ts
import { createEpicenter } from '@epicenter/app';

const epicenter = createEpicenter({
 appId: APP_ID,
 definition: honeycrispDefinition,
});
const session = epicenter.open(account);
const result = await session.opened;
// Use result.data, or present result.error.
await session.close();
```

Construction is inert. `open(account)` returns a session synchronously;
`session.opened` resolves once with an opened replica or a typed failure. The
handle serializes acquisition and release, so a new keyed Svelte child may open
before its predecessor's cleanup without racing for the same Web Lock.

The boot node renders sign-in while signed out and keys its session child on
`auth.state.account`. The child captures that Account for its initial open,
retries, and local erasure. Refresh and offline operation preserve the Account
and the local session. Sign-out retires account transport; the tree closes the
data session. Returning to the same person after sign-out creates a new Account.

Opening is cache-first. A device with a local generation can open it offline;
a device without one must reach the account to list, fetch, or create a
generation. The session owns persistence, sync, and their teardown. The same
code runs in a browser and a desktop WebView; the account supplies the transport.

`session.erase({ afterClose })` closes the session, runs the optional sign-out
step, then erases every local generation for the captured principal and app.
It never rereads the current auth selection. Failure leaves the session closed.
Whispering separately removes that account's local audio where supported.

The local replica address includes the opening app, principal, data definition,
and generation. `appId` is explicit even when it matches the definition id.
Current builds select one server; changing local address partitioning to support
multiple servers is a separate storage migration.

Device-owned SQLite files and secrets belong to `@epicenter/device`. This package
owns client data sessions in both browser and desktop deployments. License:
AGPL-3.0-or-later.
