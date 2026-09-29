# 0461. Portable data folders live under named scopes

- **Status:** Proposed
- **Date:** 2026-09-29
- **Unbuilt:** the file-authoritative root, explicit device-local sync attachment, scope-bounded opening and copying, and migration from Yjs-backed stores and working copies.

## Context

A portable file root needs separate places for Local and account-linked data. The older Yjs store addresses put a definition before its Local or account owner. The current checkout is a working copy of a Yjs document. Neither layout decides the root of a future file-authoritative folder.

One person can retain Local data and data for several accounts. An account's sync identity is the pair of authority ID and principal ID, not an email, display name, or principal alone. Principal IDs can repeat across authorities. A file root must keep selected scopes apart while letting sibling data folders link to each other and be copied as one unit.

Private storage already uses `deviceOwnerPath` to encode each identity component as UTF-8 hex. That reversible address is appropriate for app-private storage. In a visible file root it can produce long, opaque directory names, especially when a self-hosted authority ID already encodes its origin. The visible folder's name need not encode its sync destination.

## Decision

**The portable file root groups data folders by selected scope.** `local/` belongs to this device. `accounts/` holds separately named folders that a person may connect to accounts. A data folder is named by its stable definition ID within that scope.

```text
Epicenter/
  local/
    so.epicenter.notes/
      kv.json
      notes/n7.md
    so.epicenter.files/
      files/f2.md
      files/f2.jpg
  accounts/
    braden-cloud/
      so.epicenter.notes/
        kv.json
        notes/n8.md
```

**The directory name is a changeable label, not account identity.** `braden-cloud` is only an example. A person chooses a name or accepts a suggestion. The app checks that the name is portable across its supported filesystems, including length and case-insensitive collisions; it never merges folders because their labels match. Renaming the directory does not change the saved files or their relative links. An app-directed rename updates its private folder selection; a rename made in another tool requires the person to locate the folder again before sync resumes.

**A visible folder does not authorize synchronization.** The app records the person's selected folder and its exact `{ authorityId, principalId }` destination in device-private sync state. A sync session captures that selection and verifies it before publishing. Signing in, finding a plausible directory name, importing an archive, cloning Git, or copying a folder cannot create or retarget that selection. A second copy remains a valid readable folder; it does not interrupt the selected folder's sync or become another active sync owner.

On a new device, after private state is lost, or after an external rename, the person explicitly selects the folder and account before sync starts. The app shows both choices before the first publication; it cannot infer the folder's former account from its files. If the selected folder and remote both contain data, attachment must use a defined merge or import procedure rather than treating every local difference as a fresh edit. Only one folder per account can be selected for automatic sync on one device. Rehoming is an explicit import or publication to a chosen destination with fresh destination sync state; it does not reuse the old account's pending work or history as if it belonged to the new account.

The account identity and sync selection are local configuration, not part of the portable document files. The current files remain readable without either. Git history may live alongside those files, but is not required to open or recover their saved current state.

**A selected scope is the boundary for opening, copying, and resolving links between data folders.** A Local view opens `local/`; an account view opens one selected `accounts/<name>/`. A parent `Epicenter/` directory containing other folders is not an implicit grant to them. Opening a folder for inspection does not attach it to the current signed-in account or start synchronization. A link leaving the selected scope remains an unresolved external reference even if the target exists elsewhere under `Epicenter/`.

Copying one complete scope preserves its saved current files and relative links between its data folders, provided the copy includes all their actual attachment bytes. Copying one data folder preserves that folder's owned files but may leave links to siblings unresolved. Credentials, private SQLite databases, and device-private sync selection are outside this portable root. A copied account folder remains readable without signing in; publishing it to an authority is a separate authorized operation.

This is a proposed address for folders deliberately migrated to file authority. It does not relocate current IndexedDB databases, native Yjs/SQLite/blob paths, claims, or Markdown checkouts. Shared-owner addressing and permissions require a separate decision before Shared file folders exist.

## Consequences

- A person can copy or remove one selected scope's portable files as a subtree without walking every definition directory. Local files and other account folders stay outside that subtree.
- Relative links between sibling data folders use the same spelling inside Local and account scopes. Moving the whole scope preserves them.
- Inspecting one definition across scopes requires enumerating folders. A copied folder remains readable but needs an explicit account selection before it can sync on a new device.
- After device-private configuration is lost, the files alone do not reveal which exact remote account a folder previously synced with. The person must choose that destination again. Backing up the files recovers the data; preserving private settings or reselecting accounts recovers sync connections.
- Filesystem traversal and link resolution must stay inside the selected scope, including through native symlinks. A writer must not follow a link into another scope and then treat those bytes as owned or synchronizable data.

## Considered alternatives

- Put the definition ID first, with `local/` and `accounts/` below it. This makes one definition's owners adjacent, but scatters one account's data and makes account-wide copying, removal, and file access grants require enumeration across definitions.
- Derive `accounts/<authority-hex>/<principal-hex>/` from `deviceOwnerPath`. This can locate a folder from account identity without a folder picker, but transfers app-private byte encoding into the visible root. Long self-hosted origins can make the encoded authority segment too long for a filesystem component, and neither segment helps a person recognize the account. A matching path alone still cannot authorize adoption of a stale imported copy.
- Use `accounts/<principal>/` or a readable account name *as identity*. Principals can repeat across authorities, and display names can change or collide. A readable name is a locator, not proof of a sync destination.
- Put an `account.json` binding inside each folder. This makes a copied folder self-describing, but neither a file nor a matching name proves that its contents should publish to that account. Treating the file as authorization lets an external edit or stale clone silently retarget sync. Keeping the file as a non-authoritative hint still adds a second fact that can become stale; explicit folder selection supplies the needed connection. ADR-0151 used `account.json` as a witness for a deterministic hash in private SQLite storage, not as authority to publish a portable folder.
- Use one `account/` directory that changes with sign-in. Keeping earlier accounts would then require another retained location, an identity binding, and a replacement workflow. Switching accounts must not silently turn one person's files into another's.
- Combine the authority and principal into one encoded or hashed segment. A reversible encoding still has a length limit; a hash is bounded but opaque. Neither makes the folder easier to recognize than a chosen label, and knowing its identity still would not authorize automatic adoption of an imported folder.
