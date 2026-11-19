# 0109. Hosted Tauri auth keeps app-owned keyring edges until three real callers earn sharing

- **Status:** Accepted
- **Date:** 2026-07-06
- **Amended by:** ADR-0260 at the decision to defer multi-account storage. Profile-correct storage is required; retaining multiple credentials remains optional.
- **Relates:** ADR-0071, ADR-0088, [ADR-0092](0092-identity-is-the-partition.md)

## Context

Honeycrisp and Whispering are the only current Tauri apps that use hosted OAuth
and OS keyring grant storage. Matter is a Tauri app, but it is a local
file/vault product and does not use hosted OAuth. Todos is not a Tauri app
today.

PR #2378 collapsed the unsafe part of the desktop keyring boundary: the webview
no longer supplies OS keyring service or account names. Rust owns those strings,
and the webview only asks to read or write the app's persisted auth grant.

The remaining repetition is small and honest. Both desktop apps already use the
shared hosted Tauri auth helper, `createHostedDeepLinkAuth`, from
`@epicenter/svelte/auth/tauri`. What remains in each app is app-edge glue:
constants, the app's `instanceSetting`, an IPC adapter, and a Rust keyring
command pair with an app-owned service name.

```txt
Current shape:

packages/auth
  -> owns PersistedAuth
  -> owns one-active-principal auth runtime

packages/svelte-utils
  -> createHostedDeepLinkAuth(...)
    -> owns hosted deep-link OAuth composition
    -> requires a credential-backed PersistedAuthStorage

apps/honeycrisp
  -> auth.tauri.ts
    -> passes Honeycrisp constants
    -> direct Tauri invoke adapter
  -> keyring_storage.rs
    -> service = "honeycrisp"
    -> account = "auth-grant"

apps/whispering
  -> auth.tauri.ts
    -> passes Whispering constants
    -> Specta/tauriOnly IPC adapter
  -> keyring_storage.rs
    -> service = "whispering"
    -> account = "auth-grant"
```

## Decision

Keep the remaining hosted Tauri auth/keyring edge app-owned while there are only
two real callers. Do not introduce a shared TypeScript helper beyond
`createHostedDeepLinkAuth`, do not introduce a shared Rust keyring crate, and do
not design multi-account storage as part of this collapse.

Each hosted Tauri app keeps a thin wrapper at its platform edge:

- TypeScript passes app constants, the app instance setting, and a
  credential-backed persisted auth store into `createHostedDeepLinkAuth`.
- The app's IPC adapter may match that app's Tauri style. Honeycrisp can keep
  direct `invoke`; Whispering can keep Specta-generated commands.
- Rust owns the keyring service/account constants. The webview does not provide
  arbitrary keyring names.

Sharing becomes mandatory only when it has three real callers or a shared
behavioral change:

1. A third Tauri app adopts hosted OAuth.
2. Honeycrisp and Whispering both need the same Rust keyring behavior change.
3. A product requirement needs remembered accounts or account switching beyond
   the current portal round trip.

If the first trigger fires, extract from the three concrete call sites. The
likely TypeScript extraction is to move the tolerant-read/strict-write grant
adapter policy into the hosted Tauri auth helper, while each app still passes
only its IPC calls and constants. The likely Rust extraction is a small shared
helper or crate for `read_grant(service)` / `write_grant(service, value)`, with
each app keeping a command wrapper that owns its service name. If the crate tax
still costs more than the third copy, defer again and document why.

Multi-account is a separate auth/runtime design, not a keyring cleanup. If it is
ever needed, prefer multiple remembered accounts with one active runtime:

```txt
Possible future multi-account shape:

Rust-owned keyring entries
  -> auth-index
  -> auth-grant:<principalId>
  -> activePrincipalId

runtime
  -> still one active principal
  -> switch account writes activePrincipalId
  -> app reloads on switch
```

Multiple live principals in one runtime remains refused unless a product needs
two principals on screen at the same time. That would reopen ADR-0088's
boot-once and reload-on-principal-change shape across every app.

## Consequences

- The useful collapse stays shipped: hosted Tauri apps share the OAuth flow
  through `createHostedDeepLinkAuth`, and Rust owns the keyring names after PR
  #2378.
- The remaining duplication is allowed at `n=2`. It is a small app-edge wrapper,
  not a second auth model.
- Honeycrisp and Whispering can keep different IPC styles. Generated Specta
  commands are not a repo-wide desktop requirement.
- A future Todos desktop build gets its own thin wrapper first. If that build
  also uses hosted OAuth, it is the third caller that reopens extraction with
  real evidence.
- Matter is not pulled into this auth shape. Its local file/vault model remains
  separate.
- Multi-account work must start in `@epicenter/auth` and product semantics, not
  in keyring account naming. Sign out, remembered accounts, revoked accounts,
  and inactive refresh-token decay all need their own decision.
- The webview still must not regain a generic keyring account or service string
  parameter. Any future remembered-account design must keep the index Rust-owned
  or validate principal-derived account names before reaching the OS keyring.

## Considered alternatives

- **Extract another shared TypeScript helper now.** Rejected. The meaningful
  shared helper already exists. The remaining duplicate TypeScript is mostly the
  tolerant-read/strict-write wrapper around each app's IPC style, and forcing one
  adapter convention at two callers would add indirection without deleting a
  product concept.
- **Extract a shared Rust keyring crate now.** Rejected. It would be the first
  shared Rust workspace crate for this concern and would need to account for
  Specta annotations, app command wrappers, and the apps' different async
  runtime joins. That is too much machinery for two stable command pairs.
- **Design multi-account storage now.** Rejected. Current auth deliberately
  persists one `PersistedAuth` cell and boots one active principal. Remembered
  accounts may become useful later, but the product question has not arrived.
- **Standardize every Tauri app on Whispering's Specta IPC shape.** Rejected.
  Whispering's generated IPC is app-local tooling, not an Epicenter desktop
  boundary rule. Honeycrisp's direct `invoke` path can stay while it remains the
  smaller app edge.
