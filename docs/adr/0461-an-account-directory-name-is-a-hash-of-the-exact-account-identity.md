# 0461. An account directory name is a hash of the exact account identity

- **Status:** Proposed
- **Date:** 2026-09-29
- **Relates:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) takes the account out of authored folder addresses; [ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) proposes this name for private runtime storage.
- **Unbuilt:** the private runtime root of ADR-0496. Once the desktop host stops placing installed apps' folders under `accounts/<account-key>/`, that root is the only intended consumer.

## Context

Authored data folders used to group by owner: `~/Epicenter/local/<folder-id>/`
for Local data and `~/Epicenter/accounts/<account-key>/<folder-id>/` for each
account. The desktop host still opens installed apps' folders there
(`installed_apps.rs`). [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)
replaces that layout: a folder is `<root>/<folder-id>/` whoever is signed in,
and the account only matters when a transfer runs.

A directory that does belong to one account still needs a name every program
can compute from the session alone. An account's identity is the pair of
authority ID and principal ID, not an email, display name, or principal alone;
principal IDs can repeat across authorities. Private device storage encodes
each component as UTF-8 hex (`deviceOwnerPath`, `device_owner::path`). A
self-hosted authority ID already contains the hex of its origin, so encoding
it again can exceed a filesystem's component limit. A lossy slug can merge
distinct identities on case-insensitive filesystems.

## Decision

**A directory named for an account is the hash of its exact identity.** Let
`A` be the UTF-8 bytes of `authorityId` and `P` the UTF-8 bytes of
`principalId`:

```text
lowercase_hex(SHA-256(U32BE(byte_length(A)) || A || P))
```

`U32BE` is the four-byte unsigned big-endian length of `A`, so no second
length or separator is needed. Both IDs must be nonempty, well-formed Unicode
strings without control characters; an `A` longer than `2^32 - 1` bytes is
refused. The exact UTF-8 bytes are hashed without trimming, case folding, or
Unicode normalization. The result is 64 lowercase ASCII hex characters, with no
salt, domain tag, or version prefix.

```text
("epicenter-api", "user-123")
  -> b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7
("instance-68747470733a2f2f6578616d706c652e74657374", "instance")
  -> 478bb60d9394294f671f2c4a5afe2819848e57243d4d319e14f5e8d1fe269653
("A", "é")
  -> 1f9770442aa6f99e1fe926643b4ba2cc764e63abaee38dcc6bb158a62c3d4720
```

`accountKey` in `packages/principal/src/account-key.ts` and `account_key` in
`apps/epicenter/src-tauri/src/device_owner.rs` pass these vectors. The name is
a permanent path contract; an incompatible change needs an explicit migration
from the old path. A person sees the account's display name and can reveal the
directory; the display name does not participate in the path.

**Authored folders do not use it.** Neither `~/Epicenter/` nor a browser's
private file system has an `accounts/` or `local/` level for authored data.

## Consequences

- Programs that need an account's directory compute the same name from the
  same session, without a registry or a chosen alias.
- The name is opaque: it does not identify the person at a glance.
- Once installed apps' folders move to `<root>/<folder-id>/`, nothing in code
  calls either derivation until ADR-0496's runtime root is built. If that
  proposal chooses another address, both derivations and their tests go.

## Considered alternatives

- **Group authored folders under `local/` and `accounts/<account-key>/`.**
  Signing in changed which dataset an app opened, and connecting Local work to
  an account meant copying it without its history. ADR-0532 keeps one folder
  per folder ID instead.
- **A human-chosen directory name such as `braden-cloud`.** Independent
  programs cannot derive it after sign-in.
- **Slugify `authorityId` and `principalId`.** Case folding, punctuation
  replacement, or truncation can merge distinct identities.
- **`deviceOwnerPath` under `accounts/`.** Its second hex encoding of a
  self-hosted origin can exceed a filesystem component limit.
- **A version prefix or domain tag in the hash input.** Neither distinguishes
  anything inside one parent directory; an incompatible change still needs a
  migration.
