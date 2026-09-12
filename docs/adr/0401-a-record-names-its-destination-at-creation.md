# 0401. A record names its destination at creation

- **Status:** Proposed
- **Date:** 2026-09-12
- **Relates:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) (the hub that makes several destinations reachable at once), [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) (what Local, Personal, and Shared own), [ADR-0399](0399-moving-data-into-an-account-is-a-row-copy.md) (the correction when a record was created in the wrong place)
- **Unbuilt:** All of it. Whispering, Honeycrisp, and Vocab still read the page's library, and no application has a destination control.

## Context

While a page owned one library, a write had one possible destination and no
call site had to say which. The library selection screen answered the question
once per page, and `LibrarySelection.svelte` in Whispering is that screen.

ADR-0392 keeps up to three libraries open, so `insert` has to be told which
`tables` it writes to. The page can no longer answer for it.

## Decision

**An application that offers more than one library asks where a record goes at
creation, and stores the answer with the record.**

The write names the library: `app.account.personal.tables.recordings.insert(row)`, not
an `insert` that consults a page-level setting. A product surface that creates
records carries a destination control beside its create action: Whispering's
recorder, Honeycrisp's new note.

The control's initial value is `account.personal` when it is present, else
`device`. Its current value is remembered in `device.kv`, because a preferred
destination is a
property of the machine a person is sitting at rather than of the account.

Reading is separate. A view may read any open library, and a list that shows
Local and Personal rows together labels each row with the library it came from.

## Consequences

- `LibrarySelection.svelte`, the `Library` type, and the `whispering.library`
  key are deleted with the page-level choice they served.
- Every create path gains one argument. An application with only one reachable
  library (Whispering signed out, where only `app.device` is present) renders no
  control and writes to it.
- A record in the wrong library is corrected by a copy (ADR-0399), not by a
  move verb, and the person who chose wrongly chooses again on the next record.
- A destination remembered in `device.kv` survives sign-out, so the next
  sign-in restores the machine's habit rather than the account's.

## Considered alternatives

- **Default to `account.personal` and never ask.** Rejected because it makes Local
  unreachable in products where a person keeps some records off the account,
  which is the reason Local is a library rather than an offline state
  (ADR-0375).
- **Ask once per session and apply to every record.** Rejected because it is
  the page-level library under another name, and it is wrong for the first
  record after a session starts.
- **Infer the destination from the record's content.** Rejected because no
  application has a rule a person would predict.
