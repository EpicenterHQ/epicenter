# 0882. Mail leaves mail in Gmail, and agents change it through proposals the person applies

- **Status:** Proposed
- **Date:** 2026-11-12
- **Amended:** 2026-11-12: Mail holds several Gmail accounts, one file each, named by address; nothing syncs on `serve`'s clock, and a read catches the caches up from Gmail's history instead (ADR-0849 has no schedules); a full sync builds a new cache and swaps it in whole; `connect` finishes in the terminal it waits in, then copies the account.
- **Unbuilt:** proposals, `apply`, `draft`, and the UI. Built: `connect`, `sync`, `status`, `search`, and `thread`, in Mail's own repository (`braden-w/mail`), with plain `fetch` against Google's REST endpoints and tests against a fake Google.
- **Relates:** [ADR-0847](0847-an-app-brings-its-providers-credentials-with-a-default-in-its-code.md) (the person's own Google client), [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (`epicenter mail connect` on the server, and no schedules), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) (`data/`), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (the data's private backup), [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md) (yields), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (an app imports any library).

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

**Gmail is the authority for mail. Mail keeps a cache of each account that is
never committed, and commits only what the person or an agent decided.**

```txt
~/Epicenter/mail/
  epicenter.ts  package.json  ui/            the code repository
  data/
    google.local.md                          the person's OAuth client, one for every account
    sync.local.lock                          held while a sync runs
    accounts/
      gmail-<address>.local.md               one account's refresh token
      gmail-<address>.local.sqlite           its cache, always complete, rebuilt from Gmail
      gmail-<address>.filling.local.sqlite   a cache a full sync is building
    proposals/<time>.md                      what an agent wants done to mail; committed
```

Each file is one thing with one lifetime, and which files exist is Mail's
state. The client lives as long as the person uses Google; an account's
sign-in until the person removes the account, by deleting its files; its
cache until the next full sync replaces it. Mail keeps no list of accounts and
no state about a sign-in in progress. Every file but the proposals is
`.local` (ADR-0870), so none is committed.

- **`epicenter mail connect`** signs one Gmail account in on the computer that
  runs `serve`, in a terminal there. It starts Google's consent for the
  person's own OAuth client (ADR-0847), a Desktop-app client, asking once for
  `gmail.modify`, which covers every later step, with a PKCE verifier it keeps
  in memory, and redirects to `http://127.0.0.1:<port>/`. When the browser runs
  on that computer, or reaches it through `ssh -L`, `connect` receives the code
  on that port. From any other browser the redirect fails to load, and the
  person pastes the address it landed on into the terminal `connect` waits in.
  `connect` exchanges the code, learns the account's address, and writes the
  refresh token to `data/accounts/gmail-<address>.local.md`, made or replaced;
  then it syncs that account, so the account is searchable when `connect`
  ends. Connecting an account again replaces its sign-in and keeps its cache.
  The author's client is the Desktop-app client in Infisical at
  `/apps/local-mail` (`VITE_GMAIL_CLIENT_ID`, `VITE_GMAIL_CLIENT_SECRET`),
  copied into `data/google.local.md`; nothing reads Infisical at run time.
- **`epicenter mail sync`** brings each account's cache up to date. An
  account's first sync lists every message and fetches each page's messages
  as it lists them, into the account's filling file; once that is complete, it
  is renamed over the cache, so the cache is always complete and a stopped
  sync goes on in the filling file. Each later sync asks Gmail's history for
  what changed since the `historyId` the cache holds. When Gmail no longer has
  that history, the account is filled again the same way while its old cache
  keeps answering. One sync runs at a time: it holds an exclusive SQLite
  transaction on `data/sync.local.lock`, which the operating system releases
  when its process ends. It yields its progress (ADR-0879), reads Gmail, and
  writes only `.local` files, so it commits nothing.
- **Reads catch up; nothing syncs on a schedule** (ADR-0849).
  `epicenter mail search <query>` and `epicenter mail thread <id>` first apply
  Gmail's history since each account's last sync, one request an account when
  nothing changed, then answer from the caches: every account, or the one
  `--account <address>` names, each row naming its account. A read never
  starts a full sync; when an account needs one, the read says to run
  `epicenter mail sync`. An agent may also open an account's cache with any
  SQLite library, since reads reach the whole Epicenter (ADR-0880).
- **A proposal** is one verb applied to many messages, written by an agent as
  `data/proposals/<time>.md`:

  ```md
  ---
  account: gmail-mira@example.com
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
  A proposal names one account, whose ids its lines are. A line holds a Gmail
  message id and nothing else: the UI shows each message's sender and subject
  from that account's cache, so no email text is committed and a line cannot
  claim to be a message it is not.
- **`epicenter mail apply <proposal>`** is the only action that changes Gmail.
  It runs the proposal's verb on its listed messages, signed in as the
  proposal's account, and refuses a proposal whose account Mail is not
  signed in to. It skips a message whose
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
  body, sender, or subject is in it; the person's own addresses are, naming the
  accounts proposals act on.
- Losing an account's cache loses nothing: the next `sync` rebuilds it. A full
  sync takes as long as Gmail takes to list and fetch every message, at about
  40 requests a second.
- A read needs Gmail reachable to catch up, and says so when it is not. Within
  15 seconds of a sync it asks Gmail nothing, so a burst of reads costs one
  request an account.
- A full sync renames a new cache over the old one, so an agent that holds a
  cache open across it gets an I/O error and opens the file again.
- An address is an account's identity. A Workspace admin renaming an address
  makes it a new account, copied again, and its proposals name the old one.
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
- **`serve`'s clock runs `sync` every 5 minutes.** Keeps the caches current
  between reads, but it is a schedule, which ADR-0849 refuses, and a cache is
  stale only when someone reads it, which is when a read catches it up.
- **A copy of Mail per account** (`epicenter new mail-work`). Works with no
  code, but there is no search across accounts, and a UI that shows accounts
  side by side has to call another app's actions.
- **Accounts named by the person, or by Google's `sub`.** A name the person
  chooses changes, and committed proposals would point at nothing. `sub` never
  changes, but needs the `openid` scope and puts an opaque id where the
  address says which account it is.
- **The sign-in token inside the account's cache.** One file an account, but
  deleting the cache, which loses nothing, would sign the account out.
- **A lease in the cache, with an expiry.** Outlives a process that dies and
  needs renewing on every write and a takeover; the operating system's lock
  does neither.
- **A full sync that refreshes the old cache in place.** Needs a mark on every
  row and leaves the cache half refreshed while it runs; building a new one
  and swapping it in needs neither.
- **Finishing a sign-in from a second call** (`connect <address>`). Lets a
  person paste the address anywhere, but keeps the sign-in in progress in a
  file, which needs a compare-and-set between connects. Mail's UI decides how
  it takes the address when it is built.
- **An action `audience` that hides `apply` from agents.** Enforces the rule,
  but adds a platform concept before an agent has ever crossed it.
