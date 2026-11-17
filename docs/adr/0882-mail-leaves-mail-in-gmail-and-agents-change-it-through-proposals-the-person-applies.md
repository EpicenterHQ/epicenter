# 0882. Mail leaves mail in Gmail, and agents change it through proposals the person applies

- **Status:** Proposed
- **Date:** 2026-11-12
- **Amended:** 2026-11-12: Mail holds several Gmail accounts, one file each, named by address; nothing syncs on `serve`'s clock, and a read catches the caches up from Gmail's history instead (ADR-0849 has no schedules); a full sync fills an account's cache in place, its `meta` saying how complete it is, and no sync removes a message until Gmail says it is gone; every read answers with each account's freshness and never refuses for one account; cache writes commute, so syncs and reads apply history at once and only a full sync takes the account's lock; a sync waits out Gmail's quota and a read does not; `connect` finishes in the terminal it waits in, then copies the account, and answers only once it is searchable.
- **Amended:** 2026-11-15: Gmail connects from Mail's private HTTPS page on any device. One Web application OAuth client replaces the Desktop client and temporary loopback listener. The browser keeps state and a PKCE verifier in sessionStorage; Google returns to the same static Mail page, which scrubs its query and calls `finish`. The Studio keeps the client secret and refresh tokens. No application login, callback server, or server-side pending-attempt store is added. Authorization finishes before the browser starts the existing resumable sync. Changing OAuth client requires reconnecting each account once, preserving caches and proposals.
- **Amended:** 2026-11-15: Mail shows one row per account and conversation. The person uses Archive, Read/Unread, and Move to Trash directly in its reader. These explicit choices create no proposal; Gmail holds their result. Proposals remain agent suggestions requiring review. Both paths share one live message operation. Reader actions capture the displayed message ids, leave later replies alone, and update cached labels using Gmail's message version without advancing the history cursor. Message search remains available to agents.
- **Amended:** 2026-11-15: The Studio owns each browser-started download through the existing experimental action-run API. Mail starts one `sync` run per account and observes its yielded progress. Closing the page stops only observation; reopening the same browser attaches to its pending receipts without starting another copy. Pause explicitly cancels the host run, including Gmail quota waits. The account's resumable cache survives an interrupted host, but restarting the server does not automatically rerun the action. Mail adds no job store or schedule.
- **Amended:** 2026-11-13: the review UI reads account caches, binds approval to the reviewed file and selected ids, and keeps outside edits behind a new review.
- **Amended:** 2026-11-13: Mail opens the inbox, with account and label selection, bounded search pages, and a plain-text conversation reader; proposal review stays intact across reading and workspace switches. Read catch-up cancels after three seconds per account and answers from the cache.
- **Unbuilt:** `draft`. Built: `connect`, `sync`, `status`, `mailboxes`, `search`, `thread`, proposals, `apply`, the mailbox UI, and the proposal review UI, in Mail's own repository (`braden-w/mail`), with plain `fetch` against Google's REST endpoints and tests against a fake Google.
- **Relates:** [ADR-0847](0847-an-app-brings-its-providers-credentials-with-a-default-in-its-code.md) (the person's own Google client), [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (`epicenter mail connect` on the server, and no schedules), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) (`data/`), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (the data's private backup), [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md) (yields), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (an app imports any library).

- **Current boundary:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md): Mail now lives at `apps/mail/code/` with sibling `data/`, checkpointed by the private root repository. The separate Mail repositories and per-action commit bookkeeping described below are historical; the Gmail authority and proposal-review decisions remain.

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
never committed. Agent proposals and their reviewed outcomes are committed;
the person's direct reader actions leave their result in Gmail.**

```txt
~/Epicenter/apps/mail/
  code/                                     epicenter.ts, package.json, ui/
  data/
    google.local.md                          the person's OAuth client, one for every account
    accounts/
      gmail-<address>.local.md               one account's refresh token
      gmail-<address>.local.sqlite           its cache, rebuilt from Gmail; its meta says how complete
      gmail-<address>.sync.local.lock        held while a full sync copies the account
    proposals/<time>.md                      what an agent wants done to mail; committed
```

Each file is one thing with one lifetime, and which files exist is Mail's
state. The client lives as long as the person uses Google; an account's
sign-in and its cache until the person removes the account, by deleting its
files. Mail keeps no list of accounts and
no state about a sign-in in progress. Every file but the proposals is
`.local` (ADR-0870), so none is committed.

Every account's cache has the same tables whatever its provider, so search,
the UI, and an agent's SQL read every account alike, and a provider's sync is
the only code that knows the provider. Its `meta` says how far to trust it:
`cursor` is the provider's history point (Gmail's historyId) the cache is
complete through, and `filling`, present while a full sync runs, is `first`
(partial) or `refill` (complete through `cursor`, some rows newer).

- **Connect Gmail and Reconnect live in Mail's browser UI.** One Web application
  OAuth client registers the home's exact private HTTPS Mail address, including
  its trailing slash. Tailscale Serve can expose that page to the person's
  devices without exposing it publicly. `connect` takes the browser's random
  state and S256 PKCE challenge and returns Google's consent address. The
  browser keeps its verifier, expected account, and ten-minute expiry in
  sessionStorage. On Google's return, Mail removes the authorization query,
  checks and consumes the matching attempt, and calls `finish` with the code
  and verifier. The Studio exchanges it with the configured client and return
  address, verifies the granted scope and actual mailbox address, and saves
  only that account's refresh token and issuing client id. A reconnect to a
  different address is refused before saving. Google owns single-use code
  consumption; Mail keeps no server-side pending sign-in record. The page
  sends no referrer and loads no third-party resources. The phone needs only
  its browser and access to the Studio, with no SSH port forwarding.
  `finish` returns before downloading. The browser then starts one Studio-owned
  `sync` run for that account and observes the action's yielded progress.
  Accepted work continues after the tab closes. The existing run client keeps
  a browser-local receipt; returning attaches to that id and replays progress
  or the final result. Pause explicitly cancels the host run. Another browser
  sees account-level progress from the cache but has no receipt for Pause.
  The host owns its event log outside Git; Mail keeps no job database or
  timer. A server restart interrupts the run without rerunning it. Continue
  download resumes its saved cache. Reconnect never deletes a
  cache or a proposal. The former interactive terminal command, temporary
  listener, and paste-URL path are removed. A new OAuth client requires a
  one-time reconnect for every existing mailbox; its files remain readable.
- **`epicenter mail sync`** brings each account's cache up to date. An
  account's first sync lists every message and fetches each page's messages
  as it lists them, into the cache, so recent mail is searchable first; a
  stopped sync goes on where it was. Paging a mailbox that changes can skip a
  message, so it applies the history so far and lists again until a listing
  finds nothing new. Each later sync asks Gmail's history for what changed
  since the cache's `cursor`. When Gmail no longer has that history, the
  account is read again in place, fetching the messages the cache holds by
  their labels alone. No sync removes a message until Gmail has said it is
  gone, and it removes them in the transaction that moves `cursor`. Writes to
  a cache commute: a row keeps Gmail's `historyId` for its message and no
  older copy overwrites it, a removed message's id stays in `gone`, and
  `cursor` only moves forward, so syncs and reads apply history at once
  without waiting. Only a full sync takes turns, so two never split Gmail's
  quota: it holds an exclusive SQLite transaction on the account's lock file,
  which the operating system releases when its process ends. When Gmail
  refuses a request for its per-minute quota, a sync waits with jittered
  exponential backoff, or for `Retry-After` when Gmail supplies it, and keeps
  trying; a read answers from the cache instead. It yields its progress
  (ADR-0879), reads Gmail, and writes only `.local` files, so it commits
  nothing.
- **Reads catch up; nothing syncs on a schedule** (ADR-0849).
  `epicenter mail search '{"query":"is:unread"}'` and
  `epicenter mail thread '{"id":"<id>"}'` first apply
  Gmail's history since each account's last sync, one request an account when
  nothing changed, then answer from the caches: every account, or the one
  named by the optional `account` input, each row naming its account. A read never
  starts a full sync and never refuses because of one account: it answers
  with each account's freshness, when its cache last synced, whether it is
  complete, and why it may be behind, with what to run. Catch-up has a
  three-second deadline per account, including token renewal, response bodies,
  and retries. It cancels and settles its requests before closing the cache;
  a timed-out account still answers from its cache with an error. Full sync
  and apply retain their patient retries. Search continues through bounded
  pages using the raw date, message id, and account as its position. A cursor
  belongs to one account, query, and exact label scope. These pages browse the
  changing cache rather than hold a snapshot across requests. An agent may also open an account's cache with any
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
  A standalone proposal may omit `run`; absent `status` means pending.
  A proposal names one account, whose ids its lines are. A pending line holds
  only a Gmail message id: the UI shows each message's sender and subject
  from that account's cache, so no email text is committed and a line cannot
  claim to be a message it is not.
- **The person changes a conversation directly in the reader.** `change`
  requires one account, one thread, a verb, and the displayed message ids.
  It validates the complete selection against that account's cache before
  contacting Gmail, verifies the signed-in address, then checks each message's
  live state before changing it. A later reply is never added to the selection.
  Archive removes Inbox from the shown messages. Mark read clears Unread;
  Mark unread marks the newest shown received message, or the newest non-draft
  message if all are sent. Move to Trash asks for confirmation. Drafts are
  left alone. These choices create no proposal file or committed click record.
  The shared message operation also serves `apply`, which retains its file
  recheck between reading live state and sending a change. Reader changes
  update cached labels using Gmail's message version without changing the
  history cursor or sync time, so an older concurrent sync cannot undo them.
  A write response without a version is fetched again before caching.
  Partial failures retain completed changes and offer a retry. Interactive
  actions report quota failures instead of waiting indefinitely.
- **`epicenter mail apply '{"time":"<time>"}'`** applies an agent's reviewed suggestion.
  It runs the proposal's verb on its listed messages, signed in as the
  proposal's account, and refuses a proposal whose account Mail is not
  signed in to. It skips a message whose
  state already matches, writes each line's outcome into the file (`- [x]` done,
  `- [-] … already archived`), and sets `status: applied` when every line is
  resolved. A failed request leaves a `- [!]` outcome and the proposal pending;
  a retry checks failed and pending lines again and skips resolved lines.
  Missing messages and drafts are resolved without a change. Concurrent
  applies take turns under Epicenter's app lock, claimed before contacting
  Gmail. The person unticks a message in the UI to leave it out, which removes
  its unresolved line inside `apply`, after sign-in and label preflight.
  UI approval supplies the whole-file version and a non-empty selection of
  unresolved ids. Apply checks both under the app lock before contacting
  Gmail and again after preflight, before persisting exclusions. A changed
  version refuses before a Gmail change; lines added after this checked
  selection never join that run.
  Rejecting a proposal deletes its file; its commit keeps what was proposed.
  Rejecting does not undo completed Gmail changes.
- **Mail is one app with a mailbox and proposal review.** The mailbox is its
  front door: All accounts, an account filter, inbox and other views, search, and full
  thread reading over the same caches the proposal previews use. Proposals
  are another view in that app. Opening mail does not mark it read or change
  Gmail. A proposal's message can open in the reader and return to the same
  reviewed version and selection, including after switching to Mail. Opening
  another proposal or reloading resets unsaved selections. Switching back to
  Mail restores its open conversation and originating list. Clicked labels
  match exact names in each account, independently of typed Gmail search
  syntax. The first reader uses the plain text the
  cache already holds. Its lists group matching messages before paging, using
  the newest match as the row and combining matching unread state and labels.
  A search cursor belongs to its message or conversation mode. The reader's
  controls act directly; the proposal reader remains a review preview.
  Formatted HTML needs a later decision.
- **The proposal review UI** at `/mail/` groups pending proposals by run and folds
  applied records away. `review` and `preview` read local caches only, join
  ids within the named account, and show cache completeness and when it last
  synced. Unidentified messages start unticked; confirmation names the
  account, action, selected count, and selected unidentified count. Cache
  evidence can refresh without resetting choices. Changed proposals require
  an explicit new review, including outside edits discovered during an apply
  or after returning from another proposal. Progress and outcomes belong to
  the submitted proposal while the person browses. Confirmation closes on
  dispatch; there is no cancellation, polling, or persistent job record.
  A reload recovers outcomes from the proposal file. Fully resolved records
  show outcomes without Apply or Reject controls.
- **Agents never call `apply` or `change`.** They write proposals for review.
  Mail's action descriptions and README say so;
  `epicenter` does not enforce it, since every action is open to whoever can
  reach the Epicenter (ADR-0880).
- **Replies are Gmail drafts.** The proposed `draft` action would create a
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
  sync takes as long as Gmail takes to list and fetch every message. Gmail's
  per-user quota and each method's cost in quota units set the rate; a full
  message fetch costs more than fetching labels alone. The client hard-codes
  neither the costs nor the quota, and waits when Gmail refuses a request.
- A read needs Gmail reachable to catch up, and says so when it is not. Within
  15 seconds of a sync it asks Gmail nothing, so a burst of reads costs one
  request an account.
- After Gmail drops an account's history, the next sync reads every message
  the cache holds again by its labels: about as many requests as the first
  sync, with no body downloaded twice. While it runs, the cache stays complete
  through its old `cursor`, and rows it has read again are newer.
- An address is an account's identity. A Workspace admin renaming an address
  makes it a new account, copied again, and its proposals name the old one.
- A proposal can go stale between writing and applying. `apply` checks each
  message against Gmail, not the cache.
- A Gmail change and its recorded outcome cannot be atomic. If a run stops
  between them, a retry checks Gmail and records that the state already
  matches. Removing a proposal line after its Gmail request starts does not
  undo the change.
- Mail needs no composer, no outbox, and no send path; a person sends from
  Gmail.
- "Agents never call `apply` or `change`" is guidance. An agent that calls either changes Gmail
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
- **Search through Gmail's own search, with no copy.** Removes every sync and
  Gmail's exact syntax comes free, but there is no local SQL across accounts,
  no shape a second provider's accounts share, and nothing offline.
- **A full sync that builds a new cache and renames it over the old.** Keeps
  one consistent snapshot, but needs a second file, a rollback journal so the
  rename is safe, a reader that reopens after an I/O error, and a download of
  every body again; filling in place with `meta` saying how complete the cache
  is tells a reader the same and needs none of them.
- **One sync lock for every account.** Simpler, but a long copy of one account
  stops every other from catching up.
- **Every sync and catch-up under the account's lock, or committing only when
  `cursor` is unchanged.** The lock makes a read wait behind a sync; the
  compare-and-set discards a run's work when another commits first, and still
  lets a slower run's chunked writes overwrite newer rows. Versioned rows make
  every order of writes end in the same cache.
- **Pacing requests by a learned rate, or by a ledger of quota units.** Gmail
  never says how much quota is left, so either learns the limit from refusals
  anyway; waiting out a refusal spends a per-minute budget as fully, with
  nothing to tune.
- **Reads that refuse while an account needs a full sync.** Never answers
  stale, but one account blocks every search; an answer that says how current
  each account is lets the caller decide.
- **Finishing a sign-in from a second call** (`connect <address>`). Lets a
  person paste the address anywhere, but keeps the sign-in in progress in a
  file, which needs a compare-and-set between connects. Mail's UI decides how
  it takes the address when it is built.
- **An action `audience` that hides `apply` from agents.** Enforces the rule,
  but adds a platform concept before an agent has ever crossed it.
