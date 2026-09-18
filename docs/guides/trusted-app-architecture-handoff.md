# Trusted app architecture handoff

This document is a cold-start handoff for the Epicenter app-ownership work.
Read current code and ADRs as evidence, but preserve the explicit decisions
below unless a concrete external constraint contradicts them.

## Frozen destination

Epicenter authenticates one person and owns the shared curated workspace. It
admits trusted installed apps. Every trusted app receives:

```txt
- a shared Epicenter client: workspaces and person-wide capabilities
- one private operational directory: named by its app id
```

```txt
<Epicenter root>/
  data/                         shared curated Epicenter authority
  apps/
    <app-id>/                   private operational place for one trusted app,
                               including app-local blob bytes
      blobs/                    app-local bytes; account-remote uploads are explicit
```

The directory is an ownership boundary, not an operating-system sandbox. Apps
are trusted code running as the machine owner. Peers never receive another
app's path, SQLite handle, or a generic query API.

The host allocates the place nominally by admitting the app id. It does not
create, track, reclaim, back up, quota, or inspect it. The directory exists when
the app writes into it.

## Runtime shape

Static UI apps use workspaces and published app capabilities. They do not get a raw
webview filesystem bridge. When an app needs private operational state, a
trusted Bun/native runtime is composed with its own directory.

```txt
UI app -> shared Epicenter client -> workspace data / shared capabilities
UI app -> app runtime             -> app-specific verbs
app runtime -> injected appDir    -> private operational files
```

Do not add `epicenter.storage`, `epicenter.database`, generic SQLite APIs, or a
filesystem bridge. A private place is not a storage platform.

## Provider grants

A provider grant is not an Epicenter primitive. It is an OAuth authorization
owned by the app whose durable operational state it names.

```txt
Google authorizes Mail to operate a Gmail account.
QuickBooks authorizes Books to operate a company.
```

The app owns its provider client id, scopes, refresh token, provider identity,
mirror, locks, and reconciliation lifecycle. Epicenter never brokers, stores,
refreshes, revokes, enumerates, or shares provider accounts.

Use this discriminator:

```txt
Credential names durable app-local state? -> owning app keeps it.
Credential names no durable app-local state? -> it may be a reusable person value.
```

Google browser sign-in may make a second app's consent flow low-friction, but
authorizations remain separate. Calendar can reuse Google's remembered account
selection while receiving its own Calendar grant, never Mail's Gmail token.

Refuse global connected-provider registries, shared refresh-token vaults,
host-level connect/disconnect/refresh/revoke lifecycle, cross-app operational
stores, peer SQL, and permission theater.

Cross-app use has two forms only: the owning app publishes a stable verb, or a
person promotes a durable fact into the shared Epicenter replica.

## Mail example

```txt
apps/local-mail/
  credentials.json
  accounts/
    <google-sub>/
      mail.vN.db                disposable versioned Gmail materialization
      intent.db                 durable pending user actions
      lock.db                   one reconciler at a time
```

There is one Epicenter person at the root and possibly many Google accounts
inside Mail. The partition identity must become Google's stable OpenID Connect
`sub`, not an email address. The visible mailbox is the confirmed Gmail mirror
plus pending local intent. A peer must not read the mirror because it would miss
that overlay and depend on a disposable schema. Old local directories are a
clean break: never import, rename, copy, migrate, or delete them.

## Shared transcription

Epicenter owns a capability exactly when the resource behind it is contended on
the machine or singular to the person. Local transcription is contended: one
model cache, one accelerator, one RAM budget. So the host owns the active local
model and Home administers it (ADR-0180).

An external transcription service is not contended. It is a network call with a
key, and that set grows with a vendor landscape nobody here controls. A host
owning it would grow a provider catalog, a per-provider capabilities matrix, a
per-provider error taxonomy, and a settings surface that has to know every
provider to render, which ADR-0202 already forecloses. Route selection therefore
stays app-owned, exactly as ADR-0180 reserved it.

```ts
const { data, error } = await epicenter.transcription.transcribe(audioBlobId);
```

The input is a blob id, never audio: `recording.stop` publishes the bytes
host-side, and nothing in this namespace moves them across the boundary. There
is no per-call model, no app-level override of the active model, and no model
listing. Hints are advisory, and the result reports which ones applied.

Whispering keeping its cloud providers is the rule, not an exception. Its
`ProviderAccess` discriminant already names the axis: `onDevice` and `session`
are closed sets the host owns, `key` and `endpoint` are an open set the app
owns.

A brought API key names no durable state, so it may one day be a person-owned
value (ADR-0074's remaining scope under ADR-0202). That would be a store, never
a router: the key can be shared without the client becoming host-owned. One
caller today and no vault code, so it is deferred rather than designed.

## Active branch and evidence

The active dependency branch is `claude/local-mail-storage-followup`. It has
unmerged local work for the canonical app-data root, Local Books and Mail root
moves, host-root composition, ADR-0201, ADR-0202, and the correction that every
trusted app has a private place.

Read these first:

```txt
docs/adr/0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md
docs/adr/0202-a-provider-account-belongs-to-the-app-whose-durable-state-it-names-and-epicenter-brokers-none.md
specs/20260802T120000-app-data-root-and-partitions.md
packages/constants/src/app-data.ts
apps/local-mail/src/paths.ts
apps/local-books/src/paths.ts
apps/epicenter/src-tauri/src/app_data.rs
apps/epicenter/src/main.ts
```

The root checkout is intentionally dirty with user-owned documentation work.
Do not reset, overwrite, or casually switch it. Integrate on a clean dependency
train worktree. Reconcile `docs/adr/README.md` deliberately, and regenerate
`docs/spec-history.md` rather than hand-merging generated counts.

## Remaining work

1. Review and integrate the app-data and host-root work as a dependency train,
   not isolated cherry-picks: the Mail mirror and intent foundations sit below it.
2. Implement Mail's Google `sub` identity wave with no legacy-path migration.
3. Nothing. The transcription review is done and it produced no wave: ADR-0180
   already governs the local route at the right scope, `packages/app` already
   implements it, and the correction landed in the section above.
4. Rerun focused package, structure, and documentation checks after rebasing.

Success means a new app is explainable in one sentence:

> It receives a private place it alone owns, shares curated facts through workspaces,
> and owns any provider relationship whose durable state it creates.

Use `/codex:rescue` only for a bounded second opinion or recovery need. Do not
invent a generic integration or storage platform merely because a new app has a
new provider.
