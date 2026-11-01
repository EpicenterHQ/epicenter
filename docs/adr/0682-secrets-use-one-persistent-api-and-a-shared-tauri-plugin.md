# 0682. Secrets use one persistent API, kept in the account crate's keychain on the desktop

- **Status:** Proposed
- **Date:** 2026-10-22
- **Relates:** [ADR-0701](0701-apps-run-as-separate-programs.md) (each app is its own desktop program; one that signs in or keeps keys registers the `epicenter-account` crate); [Portable capability packages](0681-portable-capability-packages-follow-the-resource-they-own.md) assigns app-owned secret values to `@epicenter/secrets`; [Native authored defaults](0660-native-apps-default-authored-work-to-the-epicenter-root.md) separates authored Folders from app-managed private state.
- **Unbuilt:** `@epicenter/secrets`, its Tauri adapter over the account crate's keychain commands, and browser/desktop contract checks. The existing CLI credential flows remain separate.

## Context

One application codebase runs as a website and as its own desktop program
(ADR-0701). Its credential persistence calls need the same meaning and
TypeScript surface in each build. Connection definitions can be authored
Folder records and participate in Git synchronization; the credentials that
authorize a connection need separate storage.

The CLI already wraps `Bun.secrets`, but a desktop program does not need a
Bun executable merely to persist credentials. A desktop program that signs
in or keeps keys (Whispering, Vocab) already registers the `epicenter-account`
crate, which keeps the account's
refresh token and the API keys a page saves in the OS keychain
(`keychain_get` and `keychain_set`, and `keychain` from
`@epicenter/auth/tauri`). Reusing it keeps desktop storage policy in one
implementation.

## Decision

**`@epicenter/secrets` exposes one asynchronous, persistent string-value API.
The browser uses localStorage; a desktop app uses the keychain through
`epicenter-account`.**

The proposed public object is `secrets`, with these operations:

| Operation | Successful result |
| --- | --- |
| `get(name)` | The stored string, or `null` when the entry is absent |
| `set(name, value)` | Store or replace the string under that name |
| `delete(name)` | Whether an entry was removed; an absent entry is not an error |

The shared TypeScript contract is:

```ts
import type { Result } from 'wellcrafted/result';

type SecretError = {
  readonly name:
    | 'InvalidName'
    | 'NotBound'
    | 'Denied'
    | 'Unavailable'
    | 'Failed';
  readonly message: string;
};

type Secrets = {
  get(name: string): Promise<Result<string | null, SecretError>>;
  set(name: string, value: string): Promise<Result<void, SecretError>>;
  delete(name: string): Promise<Result<boolean, SecretError>>;
};

declare const secrets: Secrets;
```

`SecretError` has `InvalidName`, `NotBound`, `Denied`, `Unavailable`, and
`Failed` variants. Both adapters return these tagged failures rather than
rejecting for ordinary storage failures. Missing is a successful `null`, not a
failure. The TypeScript adapter translates the generated native response
envelope into this public contract. The app owns serialization of structured
credentials. Names use the one-segment lowercase ASCII grammar
`^[a-z0-9][a-z0-9.-]{0,63}$`; a name selects an entry within the bound scope,
never a service or path.

Operations are asynchronous even though localStorage is synchronous. The
`secrets` object is the capability handle; importing it acquires no storage and
reads no credentials. There is no open or close lifecycle, factory requirement,
database catalog, or multi-key transaction promise. Persistence is the fixed
policy; sync flags, session modes, expiry, listing, and rename are outside this
initial contract. Persistence does not promise survival of browser-data
clearing, eviction, or operating-system loss.

**The portable package selects its adapter at runtime; a build may pin one
adapter without changing app calls.** The bare `@epicenter/secrets` entry checks
the environment when an operation is called, then loads the browser or Tauri
implementation. Explicit `@epicenter/secrets/browser` and
`@epicenter/secrets/tauri` entries let a build select one implementation and omit
the other. Shared application code retains the same import and operations.

Environment selection and authorization have different jobs. Inside Tauri,
every operation uses the account crate's keychain commands. A missing command,
denied capability,
unbound scope, or unavailable OS store is an error; none selects localStorage.
Rust enforces the caller's permission and scope at runtime regardless of how
the frontend bundle selected its adapter. Outside a browser or Tauri page, the
portable entry refuses rather than creating a process-memory fallback.

**A desktop app reaches the keychain through `epicenter-account`.** The package's Tauri adapter uses
its keychain commands beneath the public API. No shell copies keychain commands into app-owned
command modules, and no second crate reaches the keychain. Desktop
persistence requires no CLI child or Bun runtime.

**The runtime binds the namespace before granting access.** The account
crate scopes the keychain by the bundle identifier the program is built with,
the installation identity [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md)
also uses; neither capability derives a scope from an entry name, page title,
or chosen Folder. A page supplies an entry name, not a keychain service,
application ID, or another installation's scope. A release and a development
build have their own identifiers, so their own scopes. Selecting a different
authored Folder does not relocate credentials. The browser adapter uses a package-owned prefix within its
origin's localStorage.
As with browser SQLite in ADR-0678, one origin is one app scope: paths and
prefixes do not isolate same-origin scripts from one another.

**The app does not synchronize secret values.** Native storage uses Apple
Keychain, Windows Credential Manager, or a supported Linux Secret Service.
The implementation requests non-synchronizing or non-roaming persistence where
the platform provides that choice. A Linux installation without an available
credential service reports unavailability rather than writing a plaintext file.
OS backup, migration, and third-party credential-service behavior are outside
the app's synchronization guarantee.

The browser stores its values in localStorage, readable by same-origin
JavaScript. This is persistent browser storage, not the OS credential store's
protection. On desktop, a granted `get` deliberately returns the secret into
the calling page's memory. Native storage protects the saved value; it does not
keep that value out of the authorized page after a read.

This capability owns app secrets, not all host credentials. Existing CLI-owned
account, AI-key, and Beeper credential flows keep their owners and service names
until an explicit migration decision. They are not exposed through this API
merely because it can read app-owned values. Sharing a credential namespace or
coordinating token refresh with a CLI is a separate consumer requirement.

## Consequences

- The same app code persists credentials in web and desktop builds. Protection differs by storage backend and must be described
  honestly to the person saving a credential.
- One Rust crate, `epicenter-account`, owns native keychain behavior. Each
  desktop program that keeps secrets composes it through its dependency and permission
  configuration, while the shared TypeScript package owns the public
  contract.
- Typed bindings keep commands and payloads aligned; Rust still validates
  untrusted input and enforces scope. Type generation does not grant authority.
- A synced connection definition can appear on another installation without a
  usable credential. The app requests authorization there instead of requiring
  another SQLite database to discover or store the secret.
- Browser storage limits, native value limits, locked stores, and denied access
  remain observable failures. Backend checks must establish the common contract
  before production delivery; this record introduces no package exports.

## Considered alternatives

- **Require Bun for desktop secret persistence.** The CLI can use Bun's
  credential API, but a desktop program would acquire another executable
  and process bridge solely for storage that Rust can reach directly.
- **A reusable `tauri-plugin-epicenter-secrets` crate with its own generated
  bindings.** Proposed here first. A desktop program that keeps secrets
  already registers `epicenter-account`, which reaches the keychain for its
  refresh token, so a second crate would duplicate it (ADR-0701).
- **Copy secret commands into each shell.** Native policy and generated bindings
  would evolve independently despite representing the same capability.
- **Require separate app source for browser and desktop secrets.** It repeats
  persistence and credential-serialization decisions in each app instead of
  changing the implementation beneath one import.
- **Require build-time selection for every consumer.** It adds configuration to
  the portable entry. Explicit adapter entries can still produce a single-backend
  build when its dependency closure matters.
- **Expose synchronization and session-storage modes.** They add policy and
  platform differences beyond the chosen persistent-value contract. Git
  synchronizes authored definitions, not secret values.
- **Use an encrypted vault such as Stronghold.** A separate vault adds unlock,
  key-management, and snapshot lifecycles. The selected native capability uses
  the operating system's credential store.
- **Permit only credential-bound requests, with no raw read.** That is a useful
  boundary for host-owned credentials, but it does not provide this app-owned
  persistent-value interface. Such brokered operations retain their own APIs.
