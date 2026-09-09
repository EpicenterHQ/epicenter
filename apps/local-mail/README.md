# local-mail

Gmail in Epicenter. Local Mail pulls a Gmail account into a disposable local
cache with a whole-mailbox download followed by `history.list` updates, records triage
acts as durable local assertions, and delivers them back to Gmail from one
reconciler per account.

It is a first-party Epicenter application and nothing else (ADR-0317). There is
no CLI, no MCP server, no HTTP API, and no standalone Bun or Tauri runtime. The
human workflow is the application: connect an account, look at the mailbox,
triage it, reconcile, and remove it.

## Four artifacts, and none of them are Epicenter Data

| | What it is | Where it lives | If you lose it |
| --- | --- | --- | --- |
| which accounts are connected | a fact about this device | `sqlite.open('local')`, durable | reconnect each account |
| undelivered triage | a person's own act | `sqlite.open('local')`, durable | real work, unrecoverably |
| the mail itself | borrowed data | `sqlite.open('mail-<sub>')`, one per account | nothing but quota; re-pull |
| the credential | a secret | the host's keychain, never synchronized | reconnect that account |

Run ADR-0318's test on each one and it answers no four times: Gmail is the
authority for the copy, undelivered triage is a command addressed to Gmail, the
credential is Google's, and which accounts are connected is a fact about this
machine because the credential that makes a connection real cannot leave it. So
Local Mail holds no Epicenter Data at all (ADR-0319). A preference would be the
first artifact to answer yes, and there is not one yet.

Everything is reached through one scoped handle (ADR-0316):

```ts
const epicenter = createEpicenter({
	appId: 'so.epicenter.local-mail',
	binding,
});
```

**The key is Google's subject, and nothing allocates it.** Every mail file,
every intent row, and every secret is addressed by `sub`, which Google returns
identically on every connection, so reconnecting an account lands on its own
rows by arithmetic rather than by lookup. An earlier design minted a row id for
each account and keyed the stores by it, which meant removal deleted the only
name those rows had; deriving the key removes that failure rather than guarding
against it. The address is display metadata and is refreshed on each connection.

**The split is by lifetime, not by concern.**

```txt
<epicenter-data-root>/apps/so.epicenter.local-mail/sqlite/
├── local.sqlite            durable, kilobytes, migrated, never unlinked
│     accounts, label_intents, intent_counters, last_pass
└── mail-<sub>.sqlite       borrowed, gigabytes, rebuildable
      sync_state, messages, labels
```

`local` holds the only irreplaceable bytes. A mail file is a copy Gmail still
has, so clearing one is an unlink rather than a delete of millions of rows
followed by a `VACUUM`, corruption costs one account's re-pull instead of
everything, and a statement in a mail file cannot reach another account's mail
because the file is the scope.

The schema version lives in `PRAGMA user_version`. Durable data is migrated
transactionally and a newer durable schema is refused. Known cache migrations
also run in place, preserving downloaded mail. Cache v3 clears the old history
cursor once so the next connection includes historical Spam and Trash and
repairs old label folding. Pending work and offline mail remain available.
An unrecognized cache schema is rebuilt from Gmail.

`intent_counters.next_revision` allocates revisions atomically with each intent
write and survives an empty outbox. `sync_state` holds one row with the history
cursor and last successful sync time. Pending counts are read
from the intents; they are not duplicated in the last sync report.

## Receiving mail

Sync downloads the whole mailbox, including Spam and Trash. Each completed page
is committed to SQLite and becomes readable while later pages download. The UI
refreshes local reads during synchronization; those reads do not call Gmail.
Attachments that Gmail returns as separate attachment IDs are not downloaded.

Before enumeration, Sync captures Gmail's history cursor. After enumeration, it
sweeps absent messages and saves that baseline, then replays changes from the
baseline before reporting success. Failed catchup resumes from the saved
baseline. A failure before enumeration completes leaves downloaded pages
readable, but the next attempt starts enumeration again.

Subsequent Sync calls use the saved cursor regardless of elapsed time. A full
scan happens only without a cursor or when Gmail says it expired. History label
events apply additions and removals to cached labels; unrelated labels survive.
The cursor and resulting message changes commit together.

Reloading the browser retains SQLite mail and pending changes. Browser
credentials live in memory, so reconnecting Gmail enables network work again.
Pending changes are delivered by the next reconciliation run, before receiving
Gmail updates. Reading the downloaded mailbox needs no Gmail connection.

The outbox reads pending changes and the last failure from durable storage.
Opening the mail cache is optional enrichment for subject lines; a cache
failure cannot hide waiting work or prevent the removal dialog from showing it.
Account removal waits for admitted reads, including their optional cache access.

## The write model

There is one model, and this is it (ADR-0198, ADR-0199).

**A triage act writes a durable assertion, not a Gmail call.** Acting on a
message records one row per touched label: a partial map from (message id, label
id) to want or do-not-want, per account. Ids only, never names, because Gmail's
label ids are immutable and its names are editable display strings. The map
holds opinions only about labels a person touched, so it never claims a whole
desired label set, and it is keyed so re-asserting a pair overwrites it. Archive,
then un-archive, then archive is one row.

Each current UI action records one message, one label, and its desired presence.
The account owner checks membership and writes durable SQLite without opening
the cache or consulting credentials. Undo records the opposite choice against
the captured account and message with a newer revision. A triage action requests
reconciliation only after its local write succeeds.

**One reconciler per account is the only thing that writes to Gmail.** It drains
the account's assertions, retires each one Gmail confirms, then pulls Gmail's
facts. `reconcileNow` is the only way to start one, and a second caller arriving
mid-pass requests a follow-up pass. All callers wait until those passes finish.
The run retains rejection notices across its follow-ups. Account removal closes
admission and waits for all accepted work before checking pending changes.

**Nothing reconciles in the background.** A pass runs when the application
opens, when a person records triage, and when a person presses Retry. Owed work
that misses all three waits in the outbox until the next time the application is
opened, which is why the outbox is durable and why it is the first thing a
person sees.

**Reversal is a new assertion.** Undo asserts the opposite want on the same key.
Nothing retires an assertion by comparing it to the cache: the cache lags Gmail
and can be incomplete, so a "the cache already agrees" rule would drop real
writes on stale evidence. Only provider confirmation retires an assertion.

**Undelivered work is an outbox.** `label_intents` is what is owed and
`last_pass` is what happened the last time this device tried to pay it; the
outbox is the projection of the two, and a failure is still there after the
window that saw it was closed and reopened (ADR-0327). `discardAll` abandons
every undelivered assertion; it cannot un-send one already delivered. There is
no attempt counter, no per-row error, no retry schedule, no dead-letter tier,
and nothing expires. Retries are bounded by a human, which is what discard is
for.

**Reads apply the overlay.** A page of the triage list is Gmail's facts with
this machine's undelivered assertions applied, computed in SQL so filtering,
ordering, and paging are all post-overlay: an archived message leaves the inbox
page immediately and the page still comes back full.

## Shape

| Module | What it owns |
| --- | --- |
| `storage.ts` | the app id, both schemas, and how each kind of file is opened |
| `accounts.ts` | account admission, connect/remove, durable label choices, and sessions |
| `handle.ts` | the one way both stores read and write their database |
| `mailbox.ts` | one account's disposable cache, which is one file, and the overlay |
| `intent-store.ts` | one account's slice of the durable assertions, keyed by `sub` |
| `reconcile.ts` | the one Gmail writer: drain, then pull |
| `outbox.ts` | what is owed, what the last pass said, and the two as one view |
| `sync.ts` | full pull and incremental `history.list` folding |
| `oauth.ts` | the authorization-code and PKCE flow, as a page performs it |
| `token-manager.ts` | the live access token over the stored refresh token |
| `gmail-client.ts` | the Gmail transport, with backoff and one-shot refresh |
| `schema.ts` | the Gmail shapes this application reads |

## Where the desktop and the browser differ

One application, built twice (ADR-0310). The difference is two typed failures
rather than any branch in application code.

- **Secrets.** The desktop leaf reaches the OS credential store through the
  host; the browser leaf holds a credential for the life of the tab and nothing
  longer. Not `localStorage`, not IndexedDB, not encrypted in the page.
- **Credential lifetime.** The desktop keeps a refresh token across launches, so
  reopening the application delivers what was owed. A browser tab keeps one only
  while it is open, so closing it means connecting again.

### Connecting an account, on each build

A third difference, and the one with the most machinery behind it: where Google
sends a person back to.

The web build leaves the page. The tab goes to Google, Google returns it to
`connected`, and the page that comes back reads the PKCE verifier out of
`sessionStorage` and redeems the code. That is the whole flow.

The desktop build cannot do that, for two reasons that meet in the middle. An
Epicenter app window admits navigation only to the host's loopback origin, so
Google's consent screen cannot open inside it. And Google refuses a custom URI
scheme for a Desktop OAuth client, admitting only a loopback redirect, so there
is no `epicenter://` address to hand it. The consent screen therefore opens in
the person's own browser, and Google answers on the host's socket rather than in
the WebView that started the exchange.

```
Mail WebView                    Epicenter host          person's browser        Google
     |                                |                        |                  |
 click Connect                        |                        |                  |
     |  openUrl(accounts.google.com)  |                        |                  |
     |------------- Tauri opener ----------------------------->|                  |
     |                                |                        |--- consent ----->|
     |  GET /api/mail/pending-callback|                        |                  |
     |------------------------------->| 204, nothing yet       |                  |
     |<-------------------------------|                        |                  |
     |            (poll)              |  GET /apps/mail/connected?code=...         |
     |                                |<-----------------------|<--- redirect ----|
     |                                | holds the URL          |                  |
     |                                |----------------------->| "close this tab" |
     |  GET /api/mail/pending-callback|                        |                  |
     |------------------------------->| 200 { callbackUrl }    |                  |
     |<-------------------------------| and forgets it         |                  |
     |                                |                        |                  |
 redeem the code with the verifier held here, and put the refresh token
 in `device.secrets`
```

**The host is a letterbox, not a party to the exchange.** It holds one opaque
URL for one collection and reads nothing out of it. The verifier never leaves
the Mail window, so the window is the only thing that can redeem the code, and
the refresh token goes straight to `device.secrets` from there (ADR-0310).

One grant makes it work, and it is narrow. The Mail window holds
`opener:allow-open-url` scoped to `https://accounts.google.com/*`, and nothing
else native: see `apps/epicenter/src-tauri/capabilities/mail-gmail-authorization-*.json`.
The callback route is deliberately unguarded, because a browser following a
redirect carries no session cookie, and a forged callback fails the window's
`state` check anyway.

`src/authorization-return.ts` owns both paths, because the host routes one and
both builds read the other, and a string spelled twice is how they drift.

**No redirect URI is registered, and none can be.** The Google client is
Desktop type, and RFC 8252 section 7.3 requires an authorization server to allow
any port for a loopback redirect, because a native application takes whatever
port the operating system gives it. Google honours that: the Desktop client
creation form has no redirect URI field at all, so `39130`, `39131`, whatever
`EPICENTER_DEV_PORT` names, and the web build's `localhost:5177` all work with
nothing configured anywhere. `redirectUri()` deriving the address from
`window.location.origin` is not a convenience, then; it is the only shape that
matches what Google will accept.

The limit runs the other way. A Desktop client can use loopback and nothing
else, so if the standalone web build is ever served from a real domain it needs
its own Web client with that origin registered exactly (ADR-0083).

**The consent screen is published, and that is what makes a connection last.**
Refresh-token lifetime follows publishing status, not client type: a client left
in Testing has its refresh tokens expire after seven days, which looks exactly
like a bug and is why `refreshAccess` distinguishes `invalid_grant` and asks for
re-consent instead of retrying. Epicenter's client is In production, so a
connected account stays connected. A contributor building with their own client
should publish it too, or expect to reconnect weekly. Note that `gmail.modify`
is a restricted scope, so distributing to anyone beyond the developer needs
Google's verification review; unverified builds work but show the
"Google hasn't verified this app" interstitial.

### The registry does not synchronize, and it is not going to

ADR-0310 described an account list that reaches a person's other devices while
its credentials do not, so a new device would show every account asking to be
signed in. ADR-0319 withdrew that. The credential cannot synchronize, so a row
on a device holding no credential lists an account that device cannot read, and
an account is connected per device instead.

The credential half is real and is the half that matters for safety: a refresh
token never leaves the device that obtained it. Nothing Local Mail holds leaves
the machine, which is also what keeps a restricted Gmail scope out of the
category that a server would put it in.

## Testing

```sh
bun test --cwd apps/local-mail
```

Everything is hermetic: the tests run against in-memory SQLite through the same
`AppSqliteDatabase` contract the host and the browser implement, and against a
fake Gmail client. `test-support/check-gmail-discovery.ts` is the one live
check, and it runs weekly rather than per pull request.

## Not built yet

- **Remote image loading and Gmail-perfect HTML fidelity.** Formatted bodies
  render as sanitized inline HTML; remote assets stay stripped.
- **Enumeration surfaces.** Thread and bulk acts, and asserting `UNREAD` off
  when a message is opened. The semantics are already fixed: enumerate concrete
  message ids at the moment a person acts, never at delivery time.
- **Gmail-backed drafts, send, reply, and compose.** Allowed in principle only
  for drafts, which round-trip (ADR-0098); shipping send would widen the OAuth
  grant past `gmail.modify` (ADR-0188).
- **FTS5.** `LIKE` over `body_text` is enough at current cache size.
- **An MCP surface.** Explicitly deferred (ADR-0317). It must enter through a
  designed application service, not through a compatibility path.

## Refused

These are decisions, not gaps. Each has a record, and adding one back is an ADR
rather than a pull request.

- **A CLI, an HTTP API, and a standalone runtime** (ADR-0317). Each was a second
  storage and credential owner beside the scoped handle. Arbitrary SQL access
  and command-line-only recovery do not survive that break; a workflow that
  remains necessary earns a UI.
- **Local-only mail state**: snooze, send-later, and a local tag or read flag
  that never reaches Gmail (ADR-0098). A pending assertion is not an exception:
  it names a Gmail label id and exists in order to stop existing.
- **Permanent delete and spam reporting.** `messages.delete` is never wired: a
  deferred, discardable, silently-retried intent is the wrong shape for an
  irreversible act (ADR-0198).
- **Attachment and media bytes on disk, in any form.** One
  `messages.get(format=full)` is the entire per-message budget (ADR-0196).
- **Thread-level modify.** `threads.modify` applies to the thread as Gmail sees
  it at delivery, which would silently include messages that arrived after a
  person acted (ADR-0199).
- **`messages.batchModify`.** Its response body is empty, so it proves nothing
  about which assertions landed (ADR-0199).
- **A generic queue, event log, or provider-independent operation abstraction**,
  and any per-assertion attempt counter, error column, retry schedule, or
  dead-letter tier (ADR-0198, ADR-0199).
- **A credential brokered by a server** so a build with no window open could
  sync. It would mean Epicenter's server holding something that reads a person's
  mail, which changes what Epicenter claims to be (ADR-0310).
- **A background reconciler**, in a hidden window, a worker, or the host. Local
  Mail reconciles when somebody is using it; owed work waits until they are.
- **Reading or migrating the old layout.** `credentials.json`, `provider.json`,
  the versioned `mail.v<n>.db` artifacts, and the per-account directories are
  not read, not migrated, and not detected. Connecting an account again is the
  whole of the upgrade path.
