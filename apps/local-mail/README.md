# Local Mail

Local Mail downloads Gmail, records triage changes on this device, and saves
named SQL queries in your Epicenter library. Select a connected Gmail account
and press **Run** to inspect its downloaded messages and labels.

One mounted application document owns one App. The App captures the Epicenter
account and supplies synchronized data, local SQLite, and private secrets.
Gmail accounts are separate: their Google subjects select individual cache
files within the captured Epicenter account's device scope. Switching Epicenter
accounts does not expose another person's connected mailboxes.

## Saved queries and downloaded mail

The storage boundary follows who owns each artifact:

| Artifact | Storage | Synchronizes |
| --- | --- | --- |
| Named SQL definitions | `app.account.personal.tables.savedQueries`, fields `name` and `sql` | Yes |
| Connected Gmail accounts | `app.device.sqlite.open('local')` | No |
| Pending triage and last delivery report | The same durable `local` file | No |
| Downloaded Gmail facts | `app.device.sqlite.open('mail-<sub>')` | No |
| Gmail refresh token | `app.device.secrets`, labeled by Google subject | No |

A saved query uses an ordinary row ID and has no content codec. Duplicate names
and invalid SQL are allowed. **Save** stores text and waits for local
persistence; it never executes SQL. The editor reports storage failures and
preserves a draft when the stored row changes elsewhere. Incompatible rows can
be repaired or deleted using their original IDs.

**Run** captures the current SQL and selected Google subject. The product
operation fixes access to the physical `messages` and `labels` tables. SQLite
rejects writes, additional statements, schema access, and other tables, and
bounds work, rows, and result bytes. These table names are unrelated to the
synchronized `savedQueries` collection. Execution needs no Gmail credential.

Results are transient, text-rendered cells. Empty results retain headers;
duplicate column names retain their positions. Large integers and blobs retain
their exact values. Switching Gmail accounts cancels the displayed run and
clears its results. Editing or selecting a saved query never runs it.

For example:

```sql
SELECT sender, count(*) AS messages
FROM messages
GROUP BY sender
ORDER BY messages DESC
LIMIT 25;
```

Queries report downloaded Gmail facts. Triage reads additionally overlay
pending label changes: a pending archive removes a message from the inbox
immediately, while SQL still reports its cached labels until synchronization
updates the cache. Query results offer no message actions.

## Opening and closing

`ui/src/lib/data.ts` declares data without opening resources. The primary route
imports `application.ts` only after mounting, checks `app.ready`, and then
renders the mail shell. Auth callbacks and Gmail consent callbacks open no
primary library. Importing or preloading the route does not open one either.

`application.ts` calls `openApp(mailDefinition, { account })` and reads saved queries from
`app.account.personal`. Gmail SQLite and credentials live under `app.device`.
Identity is required on first opening. A cached
identity and an existing library can reopen without network access; connection
health does not disable local triage, Undo, outbox reads, or queries.

The exported `mail` object holds module-private workflow state. Core account
functions receive that state and scoped capabilities; they do not construct a
Device or own another application lifetime. Account removal refuses new work,
drains admitted work, and checks pending triage before deleting anything.

Document departure checks the query draft, stops UI producers, drains mail
work, and closes the App. A failed save prevents deliberate departure. Switching
Epicenter accounts or servers requires closure and full document navigation.
Refreshing credentials for the same owner preserves the App.

Gmail caches, account registries, credentials, and pending work use one device
namespace per app and Epicenter account. Returning to that account restores its
local data. Disconnecting Gmail remains a separate product action. Earlier
storage is neither merged nor deleted; reconnect Gmail in the intended account
namespace. Saved queries remain synchronized account data.
Durable schema version 1 is preserved;
unknown durable schemas are refused. Unknown cache schemas can be rebuilt.

## Receiving and changing mail

Sync downloads the whole mailbox, including Spam and Trash, then maintains it
through Gmail history. Each downloaded page becomes readable before later
pages finish. A full scan runs when no cursor exists or Gmail rejects an expired
cursor. History label additions and removals preserve unrelated labels.
Separate attachment bytes are not downloaded.

Each completed page saves its messages and a download bookmark in the same
SQLite transaction. If the application stops, the next sync starts at that
bookmark; an unfinished page is fetched again. A failed continuation request
with HTTP 400 triggers one fresh scan attempt. Other failures preserve the
bookmark for retry. Existing version 1 caches upgrade without losing mail.

The bookmark retains the history position from before the scan, so changes
during the download can be caught up afterward. Each fresh scan also has its
own ID: finishing removes cached messages absent from that scan without relying
on the system clock. This recovery does not require a shutdown callback to run.

Triage records a durable assertion for one message and one label. It does not
need the cache or a credential. Undo records the opposite choice against the
captured account and message with a newer revision. Only provider confirmation
retires an assertion; agreement with a possibly stale cache is insufficient.

One reconciler per Google subject delivers pending assertions before pulling
Gmail updates. Concurrent requests share the run and request a follow-up pass.
The UI requests reconciliation on account opening, after a successful triage
write, and on Retry. There is no background reconciliation timer.

The outbox reads pending assertions and the last pass from durable storage.
Cache access enriches subject lines but cannot hide pending work if it fails.
Removal refuses while changes are owed. After explicit discard or successful
delivery, removal deletes the credential, cache, and durable account rows in
that order so a failed step remains reachable for retry.

## Browser and desktop

Both builds use App-owned storage. Browser SQLite runs in an OPFS worker;
desktop SQLite runs in the native Rust owner through the host transport.
Browser Gmail credentials last only for the document. Desktop credentials use
the device keychain. Neither enters table synchronization or query results.

Browser consent opens a separate window. The `connected` route relays the
callback URL to the opening window, which retains the PKCE verifier and
completes the exchange. The receiver checks origin, source window, callback
path, and OAuth state. Cancellation or a closed consent window ends the wait.

Desktop consent opens the system browser and returns through the host's
existing callback mailbox. The App window redeems the code with its retained
verifier. The host does not perform the Gmail exchange.

Local Mail has no hosted browser origin. Its development browser runs at
`http://localhost:5177`; the local API permits that exact origin and auth
callback. Production API configuration does not acquire this development
permission. A hosted browser deployment requires its own approved Epicenter
auth callback and Google OAuth configuration.

## Development and verification

From the repository root, start Local Mail and its API with:

```sh
bun dev:local-mail
```

This uses the existing Infisical development configuration for Gmail and API
credentials. `bun dev:local-mail:ui` starts the frontend alone.

Run the application checks from the repository root:

```sh
bun test apps/local-mail
bun run --cwd apps/local-mail typecheck
bun run --cwd apps/local-mail/ui typecheck
```

The tests use synthetic mail and fake Gmail clients. Production restricted SQL
has separate Chromium, WebKit, and native transport evidence. These checks do
not establish a live Gmail connection or desktop keychain reopening.

## Scope

The UI supports mailbox triage and saved SQL inspection. It excludes
cross-account joins, saved results, automatic SQL execution, a parameter
editor, actionable query results, and a generic query framework.

There is no CLI, MCP server, standalone storage runtime, background Gmail
worker, permanent-delete queue, or server-held Gmail credential. Sending,
replying, thread operations, bulk actions, attachment downloads, and remote
image loading are outside this workflow.
