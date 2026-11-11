# 0882. Mail leaves mail in Gmail, and agents change it through proposals the person applies

- **Status:** Proposed
- **Date:** 2026-11-12
- **Unbuilt:** all of it. The first thing that would exist is `~/Epicenter/mail/`, its own code repository, whose `epicenter mail sync` fills `data/mail.local.sqlite` from Gmail and commits nothing.
- **Relates:** [ADR-0847](0847-an-app-brings-its-providers-credentials-with-a-default-in-its-code.md) (the person's own Google client), [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (`epicenter mail connect` on the server), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (the clock), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) (`data/`), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (the data's private backup), [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md) (yields), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (an app imports any library).

## Context

Mail is where a person and their agents get through the person's inbox
together: agents triage, summarize threads, and draft replies; the person
decides what happens to their mail and sends.

Every app before Mail owns its records: a task exists only as
`data/tasks/<time>.md`. Mail's records already live in Gmail, which the person
keeps using on every device, and which will hold them after Epicenter is gone.
A copy of the mail as files in `data/` would put years of email into Git and,
through the data repository's `origin`, into a GitHub backup. A view that asks
Gmail on every read makes each agent query a network call.

## Decision

**Gmail is the authority for mail. Mail keeps a cache of it that is never
committed, and commits only what the person or an agent decided.**

```txt
~/Epicenter/mail/
  epicenter.ts  package.json  ui/      the code repository; imports googleapis
  data/
    google.local.md                    the Google sign-in (ADR-0870), never committed
    mail.local.sqlite                  the cache, never committed, rebuilt from Gmail
    proposals/<time>.md                what an agent wants done to mail; committed
```

- **`epicenter mail connect`** opens Google's consent page for the person's own
  OAuth client (ADR-0847) with the `gmail.modify` scope and writes the refresh
  token to `data/google.local.md`.
- **`epicenter mail sync`** fills `data/mail.local.sqlite`: the first run copies
  the mail Gmail lists, and each later run asks Gmail's history for what
  changed since the `historyId` the cache holds. `serve`'s clock runs it every
  5 minutes; it yields its progress (ADR-0879). It reads Gmail and writes only
  `.local` files, so it commits nothing.
- **Reads.** `epicenter mail search <query>` and `epicenter mail thread <id>`
  answer from the cache. An agent may also open `data/mail.local.sqlite` with
  any SQLite library, since reads reach the whole Epicenter (ADR-0880).
- **A proposal** is one verb applied to many messages, written by an agent as
  `data/proposals/<time>.md`:

  ```md
  ---
  verb: archive
  reason: Newsletters older than a week, none opened
  run: 2026-11-12T08-00-00-000Z
  status: pending
  ---
  - 18c2f0a91b3e44d1
  - 18c2ef77a02c9b10
  ```

  `verb` is one of `archive`, `label`, `unlabel`, `read`, `unread`, `trash`;
  `label` and `unlabel` take a `label` field. A triage that wants several verbs
  writes one proposal per verb with the same `run`, and the UI shows a run as
  its proposals side by side: "Archive 40 · Label 12 as Receipts · Trash 3".
  A line holds a Gmail message id and nothing else: the UI shows each
  message's sender and subject from the cache, so no email text is committed
  and a line cannot claim to be a message it is not.
- **`epicenter mail apply <proposal>`** is the only action that changes Gmail.
  It runs the proposal's verb on its listed messages, skips a message whose
  state already matches, writes each line's outcome into the file (`- [x]` done,
  `- [-] … already archived`), and sets `status: applied`. The person unticks a
  message in the UI to leave it out, which removes its line before `apply`.
  Rejecting a proposal deletes its file; its commit keeps what was proposed.
- **Agents never apply.** The `epicenter-app` skill and Mail's README say so;
  `epicenter` does not enforce it, since every action is open to whoever can
  reach the Epicenter (ADR-0880).
- **Replies are Gmail drafts.** `epicenter mail draft <thread> <text>` creates a
  draft in the thread through Gmail's API. Its text stays in Gmail, out of
  `data/`. The person reviews and sends it in Gmail, on any device. Mail has no
  `send` action.
- **There is no permanent delete.** `trash` is the strongest verb; Gmail keeps
  a trashed message for 30 days.

## Consequences

- The data repository's history is the person's decisions about their mail:
  what an agent proposed, with its reason, and what was applied. No message
  body, sender, or subject is in it.
- Losing `data/mail.local.sqlite` loses nothing: the next `sync` rebuilds it.
  Its first fill takes as long as Gmail takes to list every message.
- A proposal can go stale between writing and applying. `apply` checks each
  message against Gmail, not the cache.
- Mail needs no composer, no outbox, and no send path; a person sends from
  Gmail.
- "Agents never apply" is guidance. An agent that calls `apply` changes Gmail
  as the person would. If that happens, an action only a person may call is
  the next record.
- Each person brings a Google OAuth client (ADR-0847). In Google's Testing
  publishing status a refresh token expires after 7 days; the client is set to
  In production, used unverified by its one owner, so `connect` is run once.
  Verify this against Google's current policy before relying on it.
- Turning a message into a task is an app calling another app's action, which
  ADR-0880 leaves without an API. Mail's first version does not do it.

## Considered alternatives

- **Every message as a file in `data/`.** Agents could grep mail, at the cost
  of years of email in Git and in the GitHub backup, and a commit per sync.
- **A view that asks Gmail on every read.** No cache to keep, but every agent
  query is a network call and search depends on Gmail's syntax alone.
- **A verb on every line of a proposal.** One file per triage, but the person
  judges each line again, the preview has no single after-state, and the
  `reason` no longer describes the whole.
- **Agents change Gmail directly, with history as the undo.** Gmail has no
  history Epicenter can revert; a wrong archive of 400 messages is found by
  hand.
- **Drafts as records in `data/drafts/`.** Puts reply text in Git and needs a
  send path; Gmail's drafts are already a review queue on every device.
- **An action `audience` that hides `apply` from agents.** Enforces the rule,
  but adds a platform concept before an agent has ever crossed it.
