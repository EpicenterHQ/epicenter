# 0461. Portable data folders live under Local and derived account scopes

- **Status:** Proposed
- **Date:** 2026-09-29
- **Unbuilt:** the file-authoritative root, derived account folders, explicit device-local sync attachment, scope-bounded opening and copying, and migration from Yjs-backed stores and working copies.

## Context

A portable file root needs separate places for Local and account-linked data. The older Yjs store addresses put a definition before its Local or account owner. The current checkout is a working copy of a Yjs document. Neither layout decides the root of a future file-authoritative folder.

One person can retain Local data and data for several accounts. An account's identity is the pair of authority ID and principal ID, not an email, display name, or principal alone. Principal IDs can repeat across authorities. Independent native applications must find the same account scope after sign-in, including when Epicenter desktop is not installed. A chosen folder name such as `braden-cloud` would require every application to ask for the folder or consult a shared device registry.

Private storage already uses `deviceOwnerPath` to encode each identity component as UTF-8 hex. That reversible address is appropriate for app-private storage, but a self-hosted authority ID already contains the hex of its origin. Encoding it again can make a portable path component too long. A lossy slug can merge distinct identities on case-insensitive filesystems.

## Decision

**The portable root groups data folders by scope.** `~/Epicenter/local/` is the Local scope. `~/Epicenter/accounts/` contains one directory for each account identity. A data folder is named by its stable definition ID within its scope.

```text
~/Epicenter/
  local/
    so.epicenter.notes/
      kv.json
      notes/n7.md
    so.epicenter.files/
      files/f2.md
      files/f2.jpg
  accounts/
    b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7/
      so.epicenter.notes/
        kv.json
        notes/n8.md
      so.epicenter.files/
        files/f3.md
        files/f3.jpg
```

The account directory in this example derives from `{ authorityId: "epicenter-api", principalId: "user-123" }`. The same definition can have a separate data folder in Local and in each account scope. Copying an account directory copies its contained data folders together.

**Every application derives the account directory from the exact account identity.** Let `A` be the UTF-8 bytes of `authorityId` and `P` be the UTF-8 bytes of `principalId`. The directory name is:

```text
lowercase_hex(SHA-256(U32BE(byte_length(A)) || A || P))
```

`U32BE` is the four-byte unsigned big-endian length of `A`. The remaining bytes are `P`, so no second length or separator is needed. Both IDs must be nonempty, well-formed Unicode strings without control characters; reject an `A` longer than `2^32 - 1` bytes. Hash their exact UTF-8 bytes without trimming, case folding, or Unicode normalization. The auth server supplies the normalized authority ID; the principal ID remains exactly what that authority issued. SHA-256 emits all 32 digest bytes, encoded as 64 lowercase ASCII hex characters. No salt, domain tag, or version prefix participates in the address.

These examples pin the byte contract:

```text
("epicenter-api", "user-123")
  -> b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7
("instance-68747470733a2f2f6578616d706c652e74657374", "instance")
  -> 478bb60d9394294f671f2c4a5afe2819848e57243d4d319e14f5e8d1fe269653
("A", "é")
  -> 1f9770442aa6f99e1fe926643b4ba2cc764e63abaee38dcc6bb158a62c3d4720
```

Each implementation must pass the same golden vectors. The derivation is a permanent path contract. An incompatible change requires an explicit migration from the old path. An application may create the directory for a new account with no previous attachment; it must not treat a missing directory for an existing attachment as a new empty account. An external rename breaks automatic discovery until the derived name is restored. Applications show a human account name in their UI and can reveal the directory, but that name does not participate in the path.

**Finding a directory does not authorize synchronization.** Each standalone application owns its credentials and private sync attachment. Epicenter desktop and a CLI running as part of that installation can share Epicenter's private attachment. An attachment records the exact `{ authorityId, principalId }` and the account directory it admitted. Sign-in lets an application calculate a path and open saved files for inspection; it does not attach an imported folder or grant permission to publish its contents. Before first publication, the application explicitly attaches the folder and account. If the folder and remote both contain data, attachment uses a defined merge or import procedure.

An attached application refuses sync if its directory is missing or its saved attachment no longer matches the derived path. It does not create an empty replacement and treat missing files as deletions. A fresh installation computes the same directory after sign-in but has no attachment. Copying, restoring, or cloning the folder never copies credentials or private sync state. Restoring old contents over an already attached folder requires separate sync safeguards; the directory name cannot distinguish a restore from an edit.

**Local data never becomes account data.** An application has no operation that moves, publishes, or attaches a `local/` folder to an account. Copying files from one scope into another creates new files at the destination; they carry no sync state, pending work, or history from their source.

**A selected scope bounds opening, copying, and links between data folders.** A Local view opens `local/`; an account view opens one derived `accounts/<account-key>/`. A parent `Epicenter/` directory containing other scopes is not an implicit grant to them. A link leaving the selected scope remains unresolved even if its target exists elsewhere under `Epicenter/`.

Copying one complete scope preserves its saved current files and relative links between its data folders, provided the copy includes all file attachment bytes. Copying one data folder preserves its owned files but may leave links to siblings unresolved. Credentials, private SQLite databases, and sync attachments remain outside the portable root. The agreed default root is `~/Epicenter`; moving the root requires each independent app to select the new location or a separately specified root-discovery mechanism. Deriving an account child does not locate a moved root.

This address applies only to folders deliberately migrated to file authority. It does not relocate current IndexedDB databases, native Yjs/SQLite/blob paths, claims, or Markdown checkouts. Shared-owner addressing and permissions require a separate decision before Shared file folders exist.

## Consequences

- Independent native applications calculate the same account directory from the same authenticated identity without Epicenter desktop, a chosen alias, or a shared device registry.
- A person can copy one scope's saved files and relative links as a subtree. Its opaque name is stable but does not identify the person at a glance.
- The derivation removes folder-name allocation, collision handling for human names, and rename tracking. It does not remove private sync attachment or reconciliation of a restored folder.
- The shared account path does not coordinate two processes writing the same data folder. A data definition needs its own writer and file-change contract before multiple applications open it concurrently.
- Filesystem traversal and link resolution must stay inside the selected scope, including through native symlinks. A writer must not follow a link into another scope and then treat those bytes as owned or synchronizable data.

## Considered alternatives

- Put the definition ID first, with `local/` and `accounts/` below it. This scatters one account's data and makes account-wide copying and file access grants require enumeration across definitions.
- Use a human-chosen account directory name such as `braden-cloud`. Independent applications cannot derive that name after sign-in; a shared registry or repeated folder selection would become part of account discovery.
- Slugify `authorityId` and `principalId`. Slugging can collapse distinct identifiers through case folding, punctuation replacement, or truncation. A reversible escape still leaves unbounded names. Cloud principals are opaque, while self-hosted authority IDs already contain an encoded origin, so the result is seldom readable.
- Use `deviceOwnerPath` under `accounts/`. Its second hex encoding of a self-hosted origin can exceed a filesystem component limit.
- Put an `account.json` binding inside each directory. It would add creation and mismatch recovery rules while neither locating the directory from account identity nor authorizing sync. A descriptive file can be added without becoming part of the address.
- Prefix the hash input with a fixed string or the directory name with a version. Neither is needed to distinguish accounts inside `accounts/`. An incompatible derivation change still requires explicit migration.
- Use one `account/` directory that changes with sign-in. Retaining several accounts would require another location and switching could expose one account's files under another's path.
