# 0399. Moving data into an account is a row copy

- **Status:** Proposed
- **Date:** 2026-09-12
- **Supersedes:** [ADR-0143](0143-account-open-never-consumes-device-data.md) entirely: there is no Device workspace to add, delete, or keep, and no `device.capture`, `account.add`, or `device.delete` verb, because `app.device` is always open beside `app.account.personal`.
- **Amends:** [ADR-0351](0351-local-data-removal-is-an-explicit-sign-out-choice.md) at the words the account menu uses: the two exits read "Sign out" and "Sign out and remove account data from this device", because "Local" now names a library rather than this machine. Person-facing copy says "this device" or "this browser" for machine scope and "Local" only for the library (ADR-0375). The decision that removal is an explicit sign-out choice, and the ordering that carries it, stand.
- **Relates:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) (the hub that keeps both libraries open), [ADR-0401](0401-a-record-names-its-destination-at-creation.md) (how a new record avoids needing this)
- **Unbuilt:** All of it. `packages/data` still carries the capture-and-admit path ADR-0143 describes, and no application offers a copy.

## Context

ADR-0143 answered a question the hub deletes. Opening an account replaced the
Device store, so a person who had recorded without an account had to be asked
what became of that store: Add admitted its rows through native intents, Delete
threw them away, and Keep left them for later. The flow existed because only
one store could be open at a time, and every part of it (the capture verb, the
one-shot admission, the deferred source deletion, the interrupted-flow
guarantee) is machinery for moving a whole store while its owner is closed.

Under ADR-0392 both stores are open in the same page. `app.device.tables` and
`app.account.personal.tables` instantiate one declaration, so a row read from one is a
value the other's `insert` accepts.

## Decision

**"Add to my account" copies chosen rows and blobs from `app.device` into
`app.account.personal` through ordinary writes, and nothing else travels.**

The application reads the rows it chose from `app.device.tables`, writes them
to `app.account.personal.tables`, and copies each owned blob through
`app.account.personal.blobs`.
Row ids are preserved, so references between copied rows survive. The source
rows stay until the application deletes them, which is a second action a person
takes.

`device.kv` never travels. A microphone, a global shortcut, and an inference
selection describe this machine (ADR-0392), and copying one into an account
would sync it to a machine where it is false.

A copy is an application operation, not a store verb. `@epicenter/data`
exposes no `capture`, `add`, or adoption API, and there is no automatic merge
policy to configure.

## Consequences

- The interrupted-flow guarantee disappears with the flow. A copy that stops
  halfway leaves both libraries holding valid rows, and the person runs it
  again for what is left.
- Duplicate rows are possible: copying twice writes twice under new ids only if
  the application mints them, so an application that offers a repeatable copy
  keys on the source row id.
- Sign-out does not raise the question at all. The device store is not account
  data, so removal takes the account library's copy and leaves `app.device`
  intact. ADR-0351's "Sign out and remove local data" names the wrong thing
  once Local is a library, so the account menu reads "Sign out" and "Sign out
  and remove account data from this device".
- `packages/data` loses the capture, admit, and device-delete verbs and their
  protocol-state exclusions.

## Considered alternatives

- **Keep Add, Delete, Keep as a first-run prompt.** Rejected because there is
  no moment when a store is about to be replaced, so the prompt would fire on a
  condition the system no longer has.
- **A store-level `copyRow(from, to)` verb.** Rejected because the choice of
  which rows move, and what the person is told about the ones that stay, is the
  application's, and a two-handle write is already the shortest expression of
  it.
- **Copy automatically on first sign-in.** Rejected because it decides for a
  person that their machine-only recordings belong in an account.
