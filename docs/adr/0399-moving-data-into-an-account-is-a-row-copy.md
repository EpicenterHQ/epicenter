# 0399. Cross-library copying is an application workflow

- **Status:** Proposed
- **Date:** 2026-09-12
- **Supersedes:** [ADR-0143](0143-account-open-never-consumes-device-data.md) entirely: there is no Device workspace to add, delete, or keep, and no `device.capture`, `account.add`, or `device.delete` verb, because `app.device` is always open beside `app.account.personal`.
- **Amends:** [ADR-0351](0351-local-data-removal-is-an-explicit-sign-out-choice.md) at the words the account menu uses: the two exits read "Sign out" and "Sign out and remove account data from this device", because "Local" now names a library rather than this machine. Person-facing copy says "this device" or "this browser" for machine scope and "Local" only for the library (ADR-0375). The decision that removal is an explicit sign-out choice, and the ordering that carries it, stand.
- **Relates:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) (the hub that keeps both libraries open), [ADR-0401](0401-a-record-names-its-destination-at-creation.md) (how a new record avoids needing this)
- **Unbuilt:** The two-scope App and removal of the old capture-and-admit path. No cross-library copy feature is required by this record.

## Context

ADR-0143 answered a question the hub deletes. Opening an account replaced the
Device store, so a person who had recorded without an account had to be asked
what became of that store: Add admitted its rows through native intents, Delete
threw them away, and Keep left them for later. The flow existed because only
one store could be open at a time, and every part of it (the capture verb, the
one-shot admission, the deferred source deletion, the interrupted-flow
guarantee) is machinery for moving a whole store while its owner is closed.

Under ADR-0392 Local remains available beside the account libraries. Signing
in no longer replaces the Local library, so there is no adoption question the
framework must ask. Having both handles does not require an application to
show both libraries or offer a transfer between them.

## Decision

The framework supplies libraries and safe storage primitives. Applications
choose which libraries to present and whether cross-library copying exists.
There is no required "Add to account" button, sign-in adoption prompt, or
framework copy workflow.

Local data belongs to the application in one device storage or browser profile,
not to the signed-in account. Signing in, signing out, or changing accounts
does not move it. Alice and Bob using the same app and storage profile reach
the same Local library; their Personal libraries remain separate. Local blobs are
app-scoped and independent of those row libraries. Remote objects belong to
their captured application account.

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
uploaded. Rows in two libraries can reference the same app-local blob.

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
- Sign-out does not raise the question at all. The device store is not account
  data, so removal takes the account library's copy and leaves `app.device`
  intact. ADR-0351's "Sign out and remove local data" names the wrong thing
  once Local is a library, so the account menu reads "Sign out" and "Sign out
  and remove account data from this device".
- Remove the old capture, admit, and device-delete adoption path after the
  two-scope replacement is verified. Keep storage validation, saved-file
  preservation, explicit uploads, and explicit erasure; they are not adoption policy.

## Considered alternatives

- **Keep Add, Delete, Keep as a first-run prompt.** Rejected because there is
  no moment when a store is about to be replaced, so the prompt would fire on a
  condition the system no longer has.
- **A required store-level `copyRow(from, to)` workflow.** Rejected because no
  application workflow currently requires its selection, retry, or conflict
  policy. Reusable storage work can be extracted when a real caller needs it.
- **Copy automatically on first sign-in.** Rejected because it decides for a
  person that their machine-only recordings belong in an account.
