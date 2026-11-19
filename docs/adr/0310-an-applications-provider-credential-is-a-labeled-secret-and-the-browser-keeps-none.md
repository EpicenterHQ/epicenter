# 0310. An application's provider credential is a labeled secret, and the browser keeps none

- **Status:** Accepted
- **Date:** 2026-08-31
- **Built**, less two things. The three verbs, the keychain leaf, the tab-memory leaf, and Local Mail's browser build all exist. Unbuilt: starting the application's window hidden at boot. Withdrawn by ADR-0323, which measured a hidden window being suspended and moved the work into the host instead. What is unbuilt is now the host-side half rather than a hidden window. Synchronization is already background rather than while-open, because closing an application window hides it and the page keeps running; what a hidden start adds is that a person who has not launched the application since quitting Epicenter still has one that is current. The registry half is settled rather than pending: ADR-0319 withdrew it, so the list does not synchronize and is not going to.
- **Amended by:** [ADR-0319](0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md) at the account registry's home and at its synchronization. Withdrawn: that the registry lives in Epicenter Data and synchronizes, and the rejection of "the account list in the application's own SQLite" below, whose premise that the file is deletable at any moment no longer holds once storage splits by lifetime. Everything else here stands, including that deleting the mailbox does not sign anybody out.
- **Amends:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) at one clause. Withdrawn: "a browser tab is not a target, so a native capability seam collapses to its `tauri` leaf and the `default` leaf is deleted rather than maintained." Shipped code already contradicts it: `apps/honeycrisp` carries a `wrangler.jsonc`, a `deploy` script, a `default` browser leaf for `#platform/auth`, and a browser-arm typecheck. A browser build is a target again, and a deliberately reduced one. The one desktop runtime, the client-owned store, and every other refusal in ADR-0227 stand.
- **Relates:** [ADR-0273](0273-an-epicenter-app-is-an-spa-with-a-namespace-and-background-work-is-a-hidden-window.md) (the host holds several third-party secrets per application behind one host-owned callback, and background work is a hidden window), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) (one handle, identical in every runtime, differences as typed failures), [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) (why the account list cannot live in the mailbox), and [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) (the scoping shape this reuses)
- **Relates:** [ADR-0316](0316-an-application-creates-one-scoped-epicenter-handle.md) (the application-facing handle that carries this capability)

## Context

Local Mail becomes a single-page application. It needs Gmail credentials for
several accounts at once, unrelated to the one Epicenter account a person is
signed into (ADR-0262). Today it enumerates accounts by reading directory names
under `<dataDir>/accounts/<email>/`, which makes the filesystem the registry and
encodes an email address in a path. A browser has neither that directory listing
nor a keychain.

The tempting shape is a secret store that can be listed by prefix, so
`secrets.list('gmail:')` answers "which accounts do I have." That makes the
credential store the account registry, puts an email address inside a key, and
leaves no room for a display name, a cursor, or a last-synced time.

## Decision

**Epicenter does not know what Gmail is. It knows how to hold one opaque value
under a label, scoped to the application that stored it.**

An application owns its provider client ID, its OAuth flow, its account list,
its token refresh, and its disconnect policy. Three separate things live in
three separate places:

| | what it is | where it lives |
| --- | --- | --- |
| which accounts are connected | a person's own data | Epicenter Data, synchronizes |
| the mail itself | borrowed data | the app's disposable SQLite (ADR-0306) |
| the credential | a secret | the host's secure store, never synchronized |

The surface is therefore three verbs and no enumeration:

```ts
await epicenter.secrets.put(accountId, refreshToken);
await epicenter.secrets.get(accountId);
await epicenter.secrets.delete(accountId);
```

`accountId` is minted by the application and already recorded in its own data,
so nothing has to ask the secret store who it is.

- **Namespaced per application, for collision and not for protection.** Two
  applications each naming a token `gmail` is a bug that silently syncs the
  wrong mailbox. It is not a sandbox, and it must not be described as one: this
  is source a person downloaded and runs, and an application that wanted a
  neighbor's token could ask the host for it directly. Sharing, if it is ever
  wanted, is two applications declaring one identity, never one reaching into
  another's namespace.
- **The browser leaf holds nothing across a tab close.** Not `localStorage`, not
  IndexedDB, and not encrypted in the page. A key the page can derive is a key
  anything running in that origin can derive, so encryption there would defend
  against a stolen disk and nothing else while reading as though it defended
  against more. In memory, for the life of the tab, permanently rather than
  provisionally.
- **The difference is a typed failure, never a platform check** (ADR-0181).
  Local Mail is one application, written once. It handles the browser refusal
  because a `Result` obliges it to, and on the desktop that branch never runs.

## Consequences

- **Background synchronization is a desktop capability.** A hidden window and a
  keychain are what buy it (ADR-0273), and a browser tab has neither. The web
  build syncs while a person is looking at it.
- **A new device shows every account asking to be signed in.** The account list
  synchronized; the credentials did not, by construction. That is the correct
  reading of what a secret is.
- **Deleting the mailbox does not sign anybody out.** ADR-0306 makes that file
  disposable, so an account list living inside it would disappear with the first
  re-pull. It lives in Epicenter Data instead.
- **No `list` means an orphaned credential is unreachable.** Disconnecting an
  account deletes its secret, which is the path that actually happens. A
  maintenance verb earns itself when orphan cleanup becomes a real problem, and
  not before.
- Local Mail stops enumerating accounts from directory names, which is what made
  its registry a filesystem fact.
- The web and desktop builds are one bundle built twice, not two applications.

## Deliberately unbuilt

- **Cross-application secret sharing.** No consumer.
- **A credential brokered by `apps/api`.** It is the only way a browser build
  gets background synchronization, and it would mean Epicenter's server holding
  something that reads a person's mail. That changes what Epicenter claims to
  be, so it requires its own decision and must not arrive as an optimization.

## Considered alternatives

- **`secrets.list(prefix)` with labels like `gmail:name@example.com`.** Rejected
  because it makes the credential store the account registry, encodes data in a
  key that can then never be renamed or extended, and has nowhere to put a
  display name or a cursor.
- **The account list in the application's own SQLite.** Rejected because
  ADR-0306 makes that file deletable at any moment, so clearing a cache would
  sign a person out of every account.
- **The credential in Epicenter Data.** Rejected because Epicenter Data
  synchronizes, and a credential that reaches every device is the opposite of
  what a secure store is for.
- **`localStorage` in the browser, encrypted with a derived key.** Rejected as
  obfuscation: the derivation input is available to anything running in the
  origin. A passphrase the host never sees would be real, and costs a person
  their mailbox when they forget it.
