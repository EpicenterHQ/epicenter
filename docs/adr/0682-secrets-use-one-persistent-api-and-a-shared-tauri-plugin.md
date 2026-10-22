# 0682. Secrets use one persistent API and a shared Tauri plugin

- **Status:** Proposed
- **Date:** 2026-10-22
- **Relates:** [Portable capability packages](0681-portable-capability-packages-follow-the-resource-they-own.md) assigns app-owned secret values to `@epicenter/secrets`; [Native authored defaults](0660-native-apps-default-authored-work-to-the-epicenter-root.md) separates authored Folders from app-managed private state.
- **Unbuilt:** `@epicenter/secrets`, `tauri-plugin-epicenter-secrets`, their generated bindings, native credential-store integration, and browser/desktop contract checks. The existing CLI credential flows remain separate.

## Context

One application codebase must run as a website, inside Epicenter, and inside a
standalone Tauri shell. Its credential persistence calls need the same meaning
and TypeScript surface in each build. Connection definitions can be authored
Folder records and participate in Git synchronization; the credentials that
authorize a connection need separate storage.

The CLI already wraps `Bun.secrets`, but standalone shells do not need a Bun
executable merely to persist credentials. The Folder and recorder capabilities
demonstrate another composition: one Rust plugin crate, generated TypeScript
bindings owned by its companion package, and shell-level registration and
permission grants. Reusing that composition keeps desktop storage policy in
one implementation.

## Decision

**`@epicenter/secrets` exposes one asynchronous, persistent string-value API.
The browser uses localStorage; both desktop shells use the same Rust plugin.**

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
every operation uses the native plugin. A missing plugin, denied capability,
unbound scope, or unavailable OS store is an error; none selects localStorage.
Rust enforces the caller's permission and scope at runtime regardless of how
the frontend bundle selected its adapter. Outside a browser or Tauri page, the
portable entry refuses rather than creating a process-memory fallback.

**`tauri-plugin-epicenter-secrets` is a reusable Rust dependency with a companion
TypeScript package, following Tauri's plugin contract.** Epicenter and a
standalone shell depend on the same crate and register it in their Tauri
builders. Each shell grants the plugin's commands only to its intended windows.
They do not copy the plugin implementation into app-owned command modules.

The plugin owns its Rust command registry, generated command permissions, and
Specta export. `tauri-specta` generates the plugin-qualified TypeScript commands
and payload types into the shared `@epicenter/secrets` package. Regeneration
happens when the plugin contract changes, not separately for each consuming
shell. The package's Tauri adapter uses those bindings beneath the public API.
Cargo compiles the shared crate into each shell; the frontend installs its
companion npm package. Desktop persistence requires no CLI child or Bun runtime.

**The runtime binds the namespace before granting access.** Each native shell
binds an installation scope to the window before its page loads. The secrets
plugin consumes that shell-owned binding, the installation identity required
by [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md); neither
capability derives a scope from an entry name, page title, or chosen Folder. A
page supplies an entry name, not a keychain service, application ID, or another
installation's scope. Hosted apps have separate app-owned scopes; standalone
and development installations have their own. Selecting a different authored
Folder does not relocate credentials. An installed page receives no secrets
grant by default; any later grant uses a host-issued installation scope, not a
manifest claim. The browser adapter uses a package-owned prefix within its
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
until an explicit migration decision. They are not exposed through this plugin
merely because it can read app-owned values. Sharing a credential namespace or
coordinating token refresh with a CLI is a separate consumer requirement.

## Consequences

- The same app code persists credentials in web, hosted desktop, and standalone
  desktop builds. Protection differs by storage backend and must be described
  honestly to the person saving a credential.
- One Rust plugin owns native platform behavior. Each shell composes that
  capability through its dependency and permission configuration, while the
  shared TypeScript package owns the public contract and generated bridge.
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
  credential API, but a standalone Tauri shell would acquire another executable
  and process bridge solely for storage that Rust can reach directly.
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
