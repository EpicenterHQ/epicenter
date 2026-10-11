# 0461. Portable data folders group by Local or account owner

- **Status:** Proposed
- **Date:** 2026-09-29
- **Implementation:** Whispering's desktop shell opens `~/Epicenter/local/so.epicenter.whispering` by default, or the directory `WHISPERING_DATA_ROOT` names. `@epicenter/principal` derives portable account keys with golden-vector tests; Local CLI admission validates managed folder names and layout. The source CLI reports account paths without creating them.
- **Unbuilt:** account-folder discovery and bootstrap, explicit cloud transfers, credential separation for portable copies, owner-bounded opening, copying, and link resolution, and migration from Yjs-backed stores and working copies.

## Context

A portable file root needs separate places for Local and account-linked data. The older Yjs store addresses put a definition before its Local or account owner. The current checkout is a working copy of a Yjs document. Neither layout decides the root of a file-authoritative folder. Whispering's desktop shell already uses a Local file-authoritative folder.

One person can retain Local data and data for several accounts. An account's identity is the pair of authority ID and principal ID, not an email, display name, or principal alone. Principal IDs can repeat across authorities. Independent native applications must find the same account directory after sign-in, including when Epicenter desktop is not installed. A chosen folder name such as `braden-cloud` would require every application to ask for the folder or consult a shared device registry.

Private storage already uses `deviceOwnerPath` to encode each identity component as UTF-8 hex. That reversible address is appropriate for app-private storage, but a self-hosted authority ID already contains the hex of its origin. Encoding it again can make a portable path component too long. A lossy slug can merge distinct identities on case-insensitive filesystems.

## Decision

**The portable root groups data folders by owner.** The owner is Local for account-independent data, or a specific account. `~/Epicenter/local/` contains Local data. `~/Epicenter/accounts/` contains one directory for each account identity. A data folder has a stable folder ID relative to its owner, conventionally a reverse-DNS name. Its name is not a globally unique repository identity.

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

The account directory in this example derives from `{ authorityId: "epicenter-api", principalId: "user-123" }`. The same definition can have a separate data folder in Local and for each account. Copying an account directory copies its contained data folders together.

**A folder ID names a dataset; a definition interprets its files.** The complete
managed address includes the deployment channel, Local or account owner, and
folder ID. A browser origin supplies another physical storage boundary.
Reverse-DNS names give compatible tools a shared addressing convention.
`so.epicenter.notes.work` names an independent sibling dataset: dots are literal
characters, with no directory nesting or permission inheritance.

A folder definition names no dataset. Opening names it: the browser and
desktop openers require the folder ID, and an application keeps its usual ID
beside its opening code. A folder ID is neither a schema fingerprint nor an application ownership claim.
Several tools may interpret one dataset, and one application may open several
datasets with one definition. Applications must agree on the meaning of shared
fields they write. App IDs and private SQL namespaces remain separate choices.
Opening captures the selected address; changing sign-in does not retarget the
existing handle or move its files.

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

Each implementation must pass the same golden vectors. The derivation is a permanent path contract. An incompatible change requires an explicit migration from the old path. Account identity selects local storage independently of cloud discovery. A selected account folder can be created and edited offline from the cached identity without an origin. Its absence says nothing about cloud contents. An external rename breaks automatic discovery until the derived name is restored. Applications show a human account name in their UI and can reveal the directory, but that name does not participate in the path.

**Finding a directory does not authorize a transfer.** Sign-in lets an application calculate a path and open saved files for local editing. It transfers no folder content. Each standalone application owns its Epicenter authentication session; none keeps a private record that enrolls a folder for automatic publication. Directory names and configured origins can be compared with the cloud listing without a local installation database. Standard Git origin records the repository destination; it grants no permission. Git owns history comparison and reconciliation, while Epicenter captures the account and supplies trusted-service credentials ([ADR-0489](0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md)).

Changing accounts is a deliberate departure and opening. A native shell captures one account and root for its process lifetime. Switching gives pages the bounded close flush of ADR-0529, without asking, and relaunches the whole shell; detaching or reloading its page retains the owner and its lock. Recordings, drafts, admitted writes, and transports retain the identity captured when they began. Signing in does not move existing Local data. Browser storage uses the same account identity and folder ID in its OPFS directory, lock, and notification names; each browser origin still has its own physical storage. Account startup on both platforms remains unbuilt.

The portable-folder contract keeps credentials outside copied content. Whispering's current Local development host stores its transcription API key privately under `.git`; a filesystem copy can carry that key, so this separation is not implemented there yet. Managed account operations resolve the selected account's derived path and leave mismatching origins unchanged. They do not create an empty replacement and treat missing files as deletions. Restoring old contents in place over a folder that kept operating looks like an edit; the directory name cannot distinguish the two, and no stored identity detects it in every case. Raw Git at an arbitrary path remains outside Epicenter's owner selection.

**Local data stays Local.** No operation moves a `local/` folder into an account, binds it to one, or uploads it in place. A person may explicitly copy selected current files from a Local folder into an account folder after reviewing them. The copy creates new files at the destination; they carry no history, pending work, or credentials from their source, and the Local folder is unchanged.

**A selected owner bounds opening, copying, and links between data folders.** A Local view opens `local/`; an account view opens one derived `accounts/<account-key>/`. A parent `Epicenter/` directory containing data for other owners is not an implicit grant to them. A link leaving the selected owner’s directory remains unresolved even if its target exists elsewhere under `Epicenter/`.

Copying one complete owner's authored content preserves its saved current files and relative links between its data folders, provided the copy includes all file attachment bytes. Copying one data folder's authored content preserves its owned files but may leave links to siblings unresolved. Credentials, authentication sessions, and app/account SQL remain outside authored folders. File-first queries use transient in-memory projections under [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md). No new `.epicenter/` subtree is reserved or omitted by name. Store checkout and its baseline are removed under ADR-0501; existing manifest files remain on disk. Persistent query caching and placement are deferred. Pending-work databases require a separate backup and activation contract. The agreed default root is `~/Epicenter`; moving the root requires each independent app to select the new location or a separately specified root-discovery mechanism. Deriving an account child does not locate a moved root.

[ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) proposes shared native provider credentials and a fixed app/account runtime root outside the authored tree. Moving this portable root does not move that runtime. [ADR-0497](0497-browser-folders-use-scoped-opfs-directories.md) maps these logical authored owners to one OPFS directory per captured folder address, `Epicenter/local/<folder-id>/` or `Epicenter/accounts/<account-key>/<folder-id>/`; private live SQL stays in a separate OPFS namespace. Browser storage remains origin-private. The browser copies an earlier build's IndexedDB folder into that directory once and keeps the database as a backup; native targets do not relocate existing stores.

This address applies only to folders deliberately migrated to file authority. It does not relocate Yjs store IndexedDB databases, native Yjs/SQLite/blob paths, claims, or Markdown checkouts. Shared-owner addressing and permissions require a separate decision before Shared file folders exist.

## Consequences

- Independent native applications calculate the same account directory from the same authenticated identity without Epicenter desktop, a chosen alias, or a shared device registry.
- A person can copy one owner's saved files and relative links as a subtree. Its opaque name is stable but does not identify the person at a glance.
- The derivation removes folder-name allocation, collision handling for human names, and rename tracking. It does not remove per-transfer validation or reconciliation of a restored folder.
- The shared account path does not coordinate two processes writing the same data folder. A data definition needs its own writer and file-change contract before multiple applications open it concurrently.
- Filesystem traversal and link resolution must stay inside the selected owner’s directory, including through native symlinks. A writer must not follow a link into another owner’s directory and then treat those bytes as owned or synchronizable data.

## Considered alternatives

- Put the definition ID first, with `local/` and `accounts/` below it. This scatters one account's data and makes account-wide copying and file access grants require enumeration across definitions.
- Use a human-chosen account directory name such as `braden-cloud`. Independent applications cannot derive that name after sign-in; a shared registry or repeated folder selection would become part of account discovery.
- Slugify `authorityId` and `principalId`. Slugging can collapse distinct identifiers through case folding, punctuation replacement, or truncation. A reversible escape still leaves unbounded names. Cloud principals are opaque, while self-hosted authority IDs already contain an encoded origin, so the result is seldom readable.
- Use `deviceOwnerPath` under `accounts/`. Its second hex encoding of a self-hosted origin can exceed a filesystem component limit.
- Put an `account.json` binding inside each directory. It would add creation and mismatch recovery rules while neither locating the directory from account identity nor authorizing a transfer. A descriptive file can be added without becoming part of the address.
- Prefix the hash input with a fixed string or the directory name with a version. Neither is needed to distinguish accounts inside `accounts/`. An incompatible derivation change still requires explicit migration.
- Keep a private per-application attachment that admits a folder for synchronization. It separates finding a directory from permission to publish, but that permission is only needed when publication is automatic. It adds stored state that can drift from the directory, and recovery rules for an attachment whose directory is missing.
- Use one `account/` directory that changes with sign-in. Retaining several accounts would require another location and switching could expose one account's files under another's path.
