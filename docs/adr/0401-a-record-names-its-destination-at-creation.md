# 0401. A record names its destination at creation

- **Status:** Proposed
- **Date:** 2026-09-12
- **Relates:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) (the hub that makes several destinations reachable at once), [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) (what Local, Personal, and Shared own), [ADR-0399](0399-moving-data-into-an-account-is-a-row-copy.md) (optional application-owned copying)
- **Unbuilt:** Writes under the two-scope App. Current apps select one library before opening; this record requires no destination-control component.

## Context

While a page owned one library, a write had one possible destination and no
call site had to say which. The library selection screen answered the question
once per page, and `LibrarySelection.svelte` in Whispering is that screen.

ADR-0392 keeps up to three libraries open. Each write must use the intended
library's table handle; the App no longer identifies one destination by itself.

## Decision

Writes name their destination; applications own how that destination is chosen.
The framework neither selects Personal by default nor requires a picker,
remembered preference, or exposure of every available library.

An application may use one fixed library, use the library shown by its current
view, or offer a destination control. It resolves that policy before creation
and calls the chosen table's `create`. A person need not choose "this device"
or "account" for each recording: the developer expresses the application's
mode or workflow through the appropriate library API. Local recordings stay
local; account recordings automatically synchronize their completed audio
(ADR-0393). Moving existing Local recordings into an account is a separate,
confirmed application workflow (ADR-0399).

Missing account access is not permission
to silently redirect an account write into Local.

Proposed composition, not implemented App exports:

```ts
// The application has already selected and validated this destination.
const recordings = app.account.personal.tables.recordings;
const row = recordings.create({ title: 'Interview', audio: null });
await app.device.recording.start({ into: recordings.attachment(row.id) });
```

The table handle carries the library identity. No redundant destination field
is required on the row. A capture fills that existing row's attachment
(ADR-0393); changing a view or preference cannot retarget it.

Reading is separate. An application may show any subset of its available
libraries. A mixed-library view must make ownership clear to the person and
retain the owning handle for actions on each record.

## Consequences

- The two-scope migration removes library selection as an App-opening step.
  Existing library UI may remain as application view or destination policy;
  replace its consumers and verify them before removing obsolete wiring.
- A caller already holding the chosen table needs no extra destination argument.
- An application may omit Local from its interface or require sign-in. The
  framework still supplies the Local library without making it account-private.
- Cross-library copying is optional application work (ADR-0399), not a required
  correction flow. A remembered destination, if offered, is device policy and
  must be checked against the newly opened account before use.

## Considered alternatives

- **A mandatory picker and Personal default in the framework.** Rejected because
  available storage does not dictate an application's interface.
- **Resolve destination after capture finishes.** Rejected because account or
  view changes could send the recording somewhere other than its original row.
- **Silently fall back to Local when account access disappears.** Rejected
  because this changes ownership and delivery without the application's choice.
