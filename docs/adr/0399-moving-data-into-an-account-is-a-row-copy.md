# 0399. Cross-library copying is an application workflow

- **Status:** Proposed
- **Date:** 2026-09-12
- **Supersedes:** [ADR-0143](0143-account-open-never-consumes-device-data.md) at the required adoption flow: sign-in preserves the previous owner's storage without prompting to add, delete, or keep it. ADR-0404 defines which workspace becomes visible.
- **Amended by:** [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) at local ownership: Alice, Bob, and no account have separate local namespaces. Signing out restores the no-account workspace.
- **Amends:** [ADR-0351](0351-local-data-removal-is-an-explicit-sign-out-choice.md) at the words the account menu uses: the two exits read "Sign out" and "Sign out and remove account data from this device", because "Local" now names a library rather than this machine. Person-facing copy says "this device" or "this browser" for machine scope and "Local" only for the library (ADR-0375). The decision that removal is an explicit sign-out choice, and the ordering that carries it, stand.
- **Relates:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) (the hub that keeps both libraries open), [ADR-0401](0401-a-record-names-its-destination-at-creation.md) (how a new record avoids needing this)
- **Scope:** The App already exposes device and account stores together. Optional copy workflows remain proposals; no cross-library copy feature is required by this record.

## Context

ADR-0143 proposed asking what should happen to recordings made without an
account on sign-in. ADR-0404 settles the default: preserve that workspace and
open the account's workspace. Signing out returns to the no-account recordings.
Changing which workspace is visible does not require copying or deleting data.

Under ADR-0392 an account App exposes that account's Local store beside Personal
and any available Shared library. Its Local store is distinct from the
no-account store. Having several handles does not require an application to
show every library or offer a transfer between them.

## Decision

The framework supplies libraries and safe storage primitives. Applications
choose which libraries to present and whether cross-library copying exists.
There is no required "Add to account" button, sign-in adoption prompt, or
framework copy workflow.

Local data and blobs belong to the App's captured owner within this application
and device profile. Alice, Bob, and no account select different namespaces.
Signing in, signing out, or changing accounts selects another workspace and
moves no data. Everyone using the application signed out in the same profile
reaches the same no-account workspace. Remote objects belong to their captured
application account.

If an application offers moving or copying Local recordings into an account,
it asks for confirmation in a separate dialog before creating the account
copies. The dialog names the destination account and explains that the
rows will synchronize. If the workflow also uploads audio, it names that
separate operation and its destination account. Copying a reference alone does
not upload bytes or grant access to another account's remote object.
The dialog states whether the original rows remain; blob deletion is a separate
choice. Signing in is not confirmation and starts no copy or upload.
The application owns this dialog; the storage APIs do not present UI.

If an application offers copying, it composes reads and ordinary creation in
the destination library. The store mints new row IDs.
Blob references are ordinary copied values (ADR-0393). The application chooses the copied content, rebuilds
content nodes, maps references between copied records, and explains partial
results. A live row cannot simply be spread into another store. The application
must distinguish copied references from any bytes it explicitly saved or
uploaded. Rows in two libraries of the same captured App can reference the
same local blob. Copying across owners must explicitly make the referenced
bytes accessible to the destination; copying a BlobId alone does not do that.

This record promises no identity-preserving copy, deduplication, automatic
merge, or exactly-once retry. Those require a named product workflow and its
own evidence. Reusing IDs through independent offline row creation is not a
safe substitute: the store's `document.test.ts` exercises conflicting chosen
IDs losing one row's content. Recovering old content uses ordinary
working-copy edits and new-row admission, not identity-preserving reconstruction
(ADR-0395).

Sign-in does not copy device preferences or records. Applications do not bypass
storage invariants to implement a transfer. Creating a row in an account library
creates no byte-delivery obligation. Explicit hosting remains an operation on
`app.blobs.remote`, independent of copying.

## Consequences

- Opening an App and using blob storage do not depend on a copy feature.
- A future copy feature must name its behavior for missing files, linked rows,
  repeated requests, interruption, and source deletion. Ordinary creation alone
  does not establish a retry or batch-atomicity guarantee.
- Ordinary sign-out preserves the account's local rows and bytes and returns
  to the no-account workspace. An explicit removal action must define its
  scope using the captured owner: device data is account-owned too. It must
  leave other accounts and the no-account namespace untouched and warn before
  deleting local-only copies. This record does not implement that action.
- Remove the old capture, admit, and device-delete adoption path after the
  two-scope replacement is verified. Keep storage validation, saved-file
  preservation, explicit uploads, and explicit erasure; they are not adoption policy.

## Considered alternatives

- **Keep Add, Delete, Keep as a first-run prompt.** Rejected because sign-in
  preserves the previous workspace and sign-out restores access to it. A
  transfer is an optional, separate product action.
- **A required store-level `copyRow(from, to)` workflow.** Rejected because no
  application workflow currently requires its selection, retry, or conflict
  policy. Reusable storage work can be extracted when a real caller needs it.
- **Copy automatically on first sign-in.** Rejected because it decides for a
  person that their machine-only recordings belong in an account.
