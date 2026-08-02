# local-mail

Headless Gmail reader and triage ledger for local tools and agents. It pulls a
Gmail account into a private SQLite mirror with full pulls plus incremental
`history.list` polling, records triage acts as durable local assertions, and
delivers them back to Gmail from one writer per account. CLI queries, a stdio
MCP server, and a loopback SPA all read the same two files.

Two files per account carry that, and the difference between them is the whole
design:

| File                 | Holds                                | If you lose it             |
| -------------------- | ------------------------------------ | -------------------------- |
| `mail.v<version>.db` | Gmail's facts, mirrored              | Nothing but quota; re-pull |
| `intent.db`          | What the user asked for, undelivered | Real work, unrecoverably   |

Design authority lives in ADRs first, then the current code:
`docs/adr/0081-*.md` (a per-device grant and mirror), `docs/adr/0082-*.md`
(push-free `history.list` polling), `docs/adr/0098-*.md` (state round-trips
through Gmail), `docs/adr/0116-*.md` (desktop-first, one Bun engine),
`docs/adr/0188-*.md` (who owns the Google application identity, and the
device-only credential boundary), `docs/adr/0196-*.md` (the mirror is a reader
and one full message fetch is its entire budget), `docs/adr/0197-*.md` (the
artifact is named by its corpus version), `docs/adr/0198-*.md` (what a durable
write is), and `docs/adr/0199-*.md` (who delivers it). The mirror is Gmail-owned
cache data. Human-meaningful mail state must round-trip through Gmail, not a
local-only table; an undelivered assertion is not an exception to that, because
it names a Gmail label id and exists in order to stop existing.

## The write model

There is one model, and this is it (`docs/adr/0198-*.md`, `docs/adr/0199-*.md`).

**A triage act writes a durable assertion, not a Gmail call.** Acting on a
message records one row per touched label in a durable `intent.db`, a per-account
partial map from (Gmail message id, Gmail label id) to want or do-not-want. Ids
only, never label names: Gmail's label ids are immutable, its names are editable
display strings. The map holds opinions only about labels the user touched, so it
never claims a whole desired label set, and it is keyed so that re-asserting a
pair overwrites it. Archive, then un-archive, then archive is one row.

**One reconciler per account is the only thing that writes to Gmail.** It drains
the account's assertions, retires each one Gmail confirms, then pulls Gmail's
facts. It holds the per-account lock, so writing and pulling cannot interleave.
It wakes on app start, the poll interval, a coalesced local write, and an
explicit reconcile, and never after the app closes.

**Reversal is a new assertion.** Undo asserts the opposite want on the same key.
Nothing retires an assertion by comparing it to the mirror: the mirror lags Gmail
and can be incomplete, so a "the mirror already agrees" rule would drop real
writes on stale evidence. Only provider confirmation retires an assertion, and
only the reconciler does it.

**Undelivered work is visible and discardable.** Status reports the undelivered
count, the age of the oldest, and the current reconcile failure as one message.
Discard removes an undelivered assertion so it is never sent; it cannot un-send
one already delivered. There is no attempt counter, no per-row error, no retry
schedule, no dead-letter tier, and nothing expires. Retries are bounded by a
human with a discard button.

**Refused, deliberately:** a generic queue or event log, a payload or operation
table, a provider-independent request abstraction, standing policy over a thread
or query, cross-account atomicity, `messages.batchModify`, background delivery
after the app closes, and browser-memory optimism beside the durable ledger. Each
one is a decision with a record; the full list, with its reasons, is under
[Refused](#refused) at the end of this file.

**Build state.** The model above is the architecture and the only one to design
against. Everything below this line describes that model, not a migration state,
so read a disagreement between this file and the working tree as work that is
owed rather than as a second model that is allowed. The names used below are the
destination's: where a tree still spells the pass `sync`, the write route
`POST /messages/modify`, or the MCP tool `modify_labels`, that is the migration
and not an alternative vocabulary. Nothing on the old write path may be extended:
`src/modify.ts`, every request-path Gmail call, and
`ui/src/lib/optimistic.ts` are deletions, not code to build on. What is still
owed, wave by wave and with its gates, is
`specs/20260801T210000-local-mail-intent-and-reconciler-clean-break.md`, which is
also the only place a per-file migration status belongs, because that file is
deleted when the work lands and this one is not.

## Shape

- Runtime: Bun. `bun:sqlite` stores the mirror, built-in `fetch` calls Gmail,
  `oauth4webapi` handles OAuth.
- One SQLite artifact per connected account, under `<data-dir>/<accountEmail>/`,
  named `mail.v<version>.db` after `MIRROR_VERSION` in `src/db.ts`: the version
  of the corpus contract this build stores, not the app's release version.
  `mirrorAt` from `@epicenter/sqlite/bun-mirror` owns the naming, the two opening
  modes, artifact inventory, and grammar-scoped `reclaimPredecessors`; the app
  owns the version constant, DDL, ingestion, cursors, locking, file permissions,
  readiness, and reclamation timing. Opening is non-destructive and never falls
  back to a lower version: a bump is a new filename, not a migration, so nothing
  is dropped or unlinked on open and the predecessor is retained until something
  reclaims it. There is no schema version stamped in the file. See ADR-0197.
  Bumping `MIRROR_VERSION` costs one full re-pull of the mailbox, and until that
  re-pull finishes `status` reports the artifact as `building`, never `ready`.
  The refresh token lives in a separate `0600 credentials.json` at the data-dir
  root, never inside the mirror db.
- One durable `intent.db` per account, beside the mirror at
  `<data-dir>/<accountEmail>/intent.db`. It holds the account's undelivered label
  assertions and is the only irreplaceable local state in the app. Deliberately
  not inside the mirror: the mirror is version-named and reclaimable, so a corpus
  bump or a `reclaimPredecessors()` would silently discard pending work. It is
  outside ADR-0197's `<name>.v<version>.db` filename grammar, so reclamation
  cannot name it and neither opening mode touches it.
- The per-account layout is therefore:

  ```
  <data-dir>/credentials.json          0600  refresh tokens
  <data-dir>/provider.json             0600  cached client-identity override
  <data-dir>/<accountEmail>/
      mail.v<version>.db               0600  Gmail facts, disposable, re-pullable
      intent.db                        0600  undelivered assertions, durable
  ```

- Data and account directories are `0700`. The mirror artifact, its `-wal` and
  `-shm` sidecars, `intent.db`, and `credentials.json` are `0600`.
- Tables: `messages`, `labels`, and `_meta`. Thread facts are derived from live
  messages instead of stored in a separate `threads` table.
- `messages.resource` holds the parsed `messages.get(format=full)` payload
  verbatim. It is deliberately not called `raw`: `format=raw` is Gmail's name for
  the base64url RFC 5322 blob this app never fetches. Everything SQLite can
  project from the resource is a generated column; the only stored derivations
  are `subject`, `sender`, and `body_text`, which exist because triage pushes its
  filter and sort into SQL and `json_extract` cannot reach a header array or a
  base64url MIME tree. Everything else is derived at read time. See ADR-0196.
- `messages.body_text` is decoded at ingest from `text/plain` MIME parts, with
  stripped `text/html` as a fallback. That makes SQL and MCP useful for body
  questions without adding FTS yet.
- The mirror is a disposable offline reader, not an archive. One
  `messages.get(format=full)` is the entire per-message budget: no `format=raw`,
  no `messages.attachments.get`, no attachment or media bytes on disk in any
  form. Attachments are metadata only, enough to say "this message has a 42 KB
  PDF" and not enough to open it; opening it is Gmail's job. When Gmail returns a
  body part as an `attachmentId` instead of inline data, the reader says it has
  no offline body for that message rather than spending a second call. See
  ADR-0196.
- The app detail pane can render formatted email from the stored Gmail payload,
  but only behind the SPA sanitizer boundary. DOMPurify strips executable markup
  and remote assets before the single `{@html}` sink renders the body on a light
  email canvas; plain text stays available as the fallback view.

## Commands

Connect once. A packaged distribution can supply its Google OAuth Desktop
client identity through the native shell. The official Epicenter client is not
provisioned in this repository yet, so source builds remain bring-your-own: set
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`, then run the connect flow.

```sh
bun run src/bin.ts connect
```

One client identity serves every Gmail account connected on this machine. An
explicit `GMAIL_*` pair is the machine-wide override and wins over the identity
supplied by a packaged distribution. Because Google binds a refresh token to
the client that minted it, changing the effective pair means reconnecting
*every* account here; a stored grant is never reinterpreted under a new client,
so a mismatch fails loudly on the next refresh instead of surfacing as Google's
opaque `invalid_grant`. The client id and secret are public application
configuration, not user secrets: the Gmail access and refresh tokens are the
secrets, and they never leave this device. Epicenter Cloud and self-hosted
Epicenter instances are not in the Gmail path at all, so which instance you
select has no effect on any of this.

Provide the pair however you keep local secrets for the first connect:
an export, a local `.env`, or a secrets manager such as
`infisical run --path=/apps/local-mail -- bun run src/bin.ts connect`. On the
first successful connect or refresh, Local Mail caches an explicit override to
a 0600 `<data-dir>/provider.json` sibling to `credentials.json`. The
distribution identity is never copied into that user-owned file. Every later
run and every other git worktree on this machine reads the override from there,
so no per-worktree config is needed. See [`.env.example`](.env.example) for the
canonical override names.

Local Mail requests `gmail.modify` so label changes can round-trip through Gmail.
Trash and untrash are in scope and built: the app UI moves a message to Trash and
undoes it, delivered through Gmail's own `messages.trash` / `messages.untrash`
verbs rather than as a label delta, though it is stored as an ordinary `TRASH`
assertion like any other label. Although Google grants send at the same OAuth
layer, Local Mail exposes no send, reply, compose, or drafts today, and
permanent delete is refused outright: `messages.delete` is deliberately never
wired. The difference matters when reading the two lists at the end of this
file. Send and drafts are unbuilt; permanent delete is a decision.

Headless bootstrap is still available. The refresh token is redeemed
immediately (one refresh grant plus a profile read), so a dead token fails
here rather than on the first sync, and the account email comes from the
Gmail profile instead of being typed:

```sh
bun run src/bin.ts seed-token <refresh-token>
```

Run a reconcile pass: drain this account's assertions, then pull Gmail's facts.

```sh
bun run src/bin.ts reconcile --full

bun run src/bin.ts reconcile --watch
```

There is no separate sync verb, because a pass is drain-then-pull and the pull is
its second half. If the open app already owns this account's reconciler, a
headless pass yields to it rather than becoming a second writer.

Check connection and mirror state:

```sh
bun run src/bin.ts status
```

Query the mirror:

```sh
bun run src/bin.ts query "SELECT subject, sender FROM messages ORDER BY internal_date DESC LIMIT 10"
```

Triage messages. Each verb records label assertions for the ids you name; the
account's reconciler delivers them. Output is human-readable; add `--json` for
the typed outcome MCP and the `app` HTTP API share.

```sh
bun run src/bin.ts archive <id...>
bun run src/bin.ts unarchive <id...>
bun run src/bin.ts mark-read <id...>
bun run src/bin.ts mark-unread <id...>
bun run src/bin.ts trash <id...>
bun run src/bin.ts untrash <id...>
bun run src/bin.ts label <id...> --add Work --remove Promotions
```

`archive`, `mark-read`, and friends are the triage vocabulary; `label` is the
transparent primitive they desugar to (`archive` is `label --remove INBOX`).
They are spellings, not separate write paths: archive, read, star, trash, and a
custom label are one assertion with a different label id, so every verb here
reaches the same single assert. `LOCAL_MAIL_READ_ONLY` refuses every write while
leaving `query`/`status` and the pull half of a pass available.

An assertion is durable the moment the verb returns, so a triage act survives an
offline machine, a killed process, and a reboot. It is not a Gmail write yet:
`status` reports how many assertions are undelivered and how old the oldest is,
and a discard is how you abandon one before it is sent.

Serve the triage UI and its API from one loopback process:

```sh
bun run src/bin.ts app
```

`app` is the desktop runtime host: it owns this account's reconciler and serves the triage
SPA (`ui/`) plus a same-origin `/api` on `127.0.0.1`, then prints the origin to
open (`http://127.0.0.1:PORT`). It launches no browser; opening the window is the
host's job (a terminal today, Tauri later), not the engine's. Security: every
request is Host-checked first (the DNS-rebinding kill switch); the web UI carries
a per-launch local API bearer that the host injects into the served HTML as
`window.__LOCAL_MAIL__ = { origin, bearer }` before the SPA boots (no URL
fragment, no session-exchange endpoint, no sessionStorage), and that HTML is
served `no-store` and frame-denied so a rotated bearer is never cached and a
cross-origin page cannot frame the auto-authenticated SPA. The bearer is a
loopback credential, never a Gmail token. In app mode the host loads every
connected account and serves them under one origin: `GET /api/accounts` lists
the loaded accounts, and reads/writes live under `/api/accounts/:account/*`.
The write surface collapses to four routes over the same core the CLI verbs and
MCP tools use:

| Route                                         | Does                                                          |
| --------------------------------------------- | ------------------------------------------------------------- |
| `POST /api/accounts/:account/messages/assert` | Record label assertions for concrete ids and return           |
| `POST /api/accounts/:account/reconcile`       | Wake the reconciler now: drain, then pull                     |
| `GET /api/accounts/:account/pending`          | The undelivered assertions as stored, so discard can name one |
| `POST /api/accounts/:account/pending/discard` | Abandon undelivered assertions, by id or all                  |

The first two are the whole write door and the invariant lives there: a request
asserts or it wakes the reconciler, and nothing else reaches Gmail. The last two
are the ledger surface, and they are the only place individual assertions are
enumerated; they exist so a human can name one to discard. `GET /status` carries
the aggregate reading (undelivered count, age of the oldest, the current
reconcile failure as one message) and never a per-assertion status, because there
is not one. The ledger pair is decided but not built: it is wave W2 of
`specs/20260801T210000-local-mail-intent-and-reconciler-clean-break.md`.

Archive, read, star, trash, and custom labels all desugar to assertions
client-side; trash is an ordinary `TRASH` assertion here and routes to Gmail's
`messages.trash` / `untrash` only at delivery. The old direct-write vocabulary
(`POST .../messages/modify`, `POST .../messages/trash`, `POST .../sync`, and the
`ModifyMessageLabelsOutcome` shape with its `folded` and `aborted` fields) is
deleted, not deprecated: it described a request that talked to Gmail, and no
request does that any more. `LOCAL_MAIL_READ_ONLY` disables writes end to end;
`--port <n>` pins the server port (`LOCAL_MAIL_PORT` is the env fallback).

Bulk and thread actions enumerate concrete message ids from the mirror at the
moment you act. A message that arrives in that thread afterward is untouched,
because nothing durable refers to the thread.

Develop the UI against a running `app`:

```sh
LOCAL_MAIL_PORT=4177 bun run src/bin.ts app   # serves /api + writes the presence file
bun run --cwd ui dev                          # Vite proxies /api to the host and injects its bearer from the presence file
```

The dev server reads the host's `0600` presence file (`runtime.json`) for the
per-launch bearer and injects it on each proxied `/api` request (SvelteKit's dev
HTML pipeline bypasses Vite's HTML transform, so the prod `window.__LOCAL_MAIL__`
injection is a proxy-side header in dev). No token is typed by a human. Start the
host first; a host restart rotates the bearer, so restart the dev server to pick
it up. Pin `LOCAL_MAIL_PORT` if the host uses an ephemeral port.

Serve tools to an MCP host:

```sh
bun run src/bin.ts mcp
```

When more than one account is connected, `local-mail app` serves all of them
under one origin with an account switcher. Set `LOCAL_MAIL_ACCOUNT` only for
headless `reconcile`, `query`, and `mcp`, which operate on one account per
process.

Tools:

- `query`: read-only SQL over the mirror, capped at 1000 returned rows. The read
  connection attaches the account's `intent.db` read-only, so a query can see
  both the mirror's stored labels and the effective set that overlays the
  account's undelivered assertions over them. Triage against the effective set;
  the stored labels are Gmail's last word, not what the user has already asked
  for.
- `status`: account, cursor, row counts, and the write ledger: undelivered count,
  age of the oldest, and the current reconcile failure if there is one. Aggregate
  only, by design.
- `reconcile`: one pass, drain then pull. Yields if another process owns this
  account's reconciler.
- `assert`: record label assertions on messages by id, adding or removing labels
  by id or exact name. It returns what it stored, not what Gmail did, because
  delivery has not happened yet; an agent that needs to know its write landed
  reads `pending` or `status` afterward rather than assuming. Unlisted under
  `LOCAL_MAIL_READ_ONLY`. The CLI triage verbs above are the human-facing form of
  this one tool.
- `pending`: this account's undelivered assertions, so an agent can see work it
  asked for rather than assuming it landed. Decided but not built; it lands with
  the ledger surface in wave W2.

## Config

- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`: the machine-wide Google OAuth
  Desktop client override. The resolver reads the pair atomically from the
  environment first, then `<data-dir>/provider.json`. A packaged distribution
  identity is the fallback and is never persisted as an override. Missing
  credentials in a source build fail loudly naming the exact variables.
  Changing the effective client requires reconnecting every account on this
  machine.
- `LOCAL_MAIL_ACCOUNT`: optional account override for `reconcile`, `query`, and
  `mcp`. Required only when more than one account is connected.
- `LOCAL_MAIL_DIR`: data directory override.
- `LOCAL_MAIL_TOKEN_FILE`: token file override.
- `LOCAL_MAIL_GMAIL_API_BASE`: test plumbing only; points the Gmail client at
  a mock server in the MCP subprocess test.
- `LOCAL_MAIL_PORT`: fallback for pinning the `app` server port; prefer
  `--port <n>` for normal use. Also names the port the Vite dev proxy targets
  when the host uses an ephemeral port.

## Testing

Run from this package:

```sh
bun test
bun run typecheck
```

The tests use real `bun:sqlite` temp files for DB behavior, a fake
`GmailClient` for sync folding, mock HTTP endpoints for OAuth, and a real MCP
stdio subprocess for the agent-facing protocol surface.

## Not built yet

- Remote image loading and Gmail-perfect HTML fidelity. Formatted bodies render
  as sanitized inline HTML on a light canvas; remote assets stay stripped, and
  there is no show-images proxy yet.
- Signed distribution. The Tauri desktop shell (`src-tauri/`, run with
  `bun run app:desktop`) spawns this engine, reads the origin it prints, and
  opens a `WebviewUrl::External` window at it, owning only the window and the
  engine's lifetime (Rust never touches Gmail tokens, mail data, or the bearer).
  `bun run desktop:build` produces a local unsigned macOS `.app` with the compiled
  Bun sidecar and bundled SPA resources. The shell can compile in the
  distribution's public Google client identity, but no official Epicenter
  identity is provisioned in this repository. Signing, notarization, and the
  official Google client still need release configuration, as described in
  `src-tauri/README.md`.
- The ledger surface. `GET /pending`, `POST /pending/discard`, the CLI `pending`
  and `discard` verbs, the MCP `pending` tool, and the SPA's pending panel are
  decided and unbuilt (wave W2). Until they exist, `status` reports the count and
  the oldest age but nothing can abandon an undelivered assertion, which is the
  one exit besides delivery that the model promises.
- Enumeration surfaces. Thread and bulk acts, and asserting `UNREAD` off when a
  message is opened, are wave W3. The semantics are already fixed: enumerate
  concrete message ids from the mirror at the moment the user acts, never at
  delivery time.
- Gmail-backed drafts, send, reply, and compose. Allowed in principle only for
  drafts, which round-trip (ADR-0098); none is built, and shipping send would
  widen the OAuth grant past `gmail.modify` (ADR-0188).
- FTS5. `LIKE` over `body_text` is enough for the current mirror size.

## Refused

These are decisions, not gaps. Each has a record, and adding one back is an ADR
rather than a pull request.

- **Local-only mail state**: snooze, send-later, and a local tag or read flag
  that never reaches Gmail (ADR-0098). A pending assertion is not an exception:
  it names a Gmail label id and exists in order to stop existing.
- **Permanent delete and spam reporting.** `messages.delete` is never wired, and
  a deferred, discardable, silently-retried intent is the wrong shape for an
  irreversible act (ADR-0198).
- **A locally held draft as durable intent.** A Gmail-backed draft is a different
  thing and is merely unbuilt; a draft that lives only on this device is a second
  durable write shape (ADR-0198).
- **Attachment and media bytes on disk, in any form.** One
  `messages.get(format=full)` is the entire per-message budget (ADR-0196).
- **Thread-level modify.** `threads.modify` applies to the thread as Gmail sees
  it at delivery, which would silently include messages that arrived after the
  user acted. Triage is message-level for that reason, not for lack of effort
  (ADR-0199).
- **`messages.batchModify`.** Its response body is empty, so it proves nothing
  about which assertions landed. The reopen condition is named and specific in
  ADR-0199; the quota saving alone does not meet it.
- **A generic queue, event log, or provider-independent operation abstraction**,
  and any per-assertion attempt counter, error column, retry schedule, or
  dead-letter tier (ADR-0198, ADR-0199).
- **Background delivery after the app closes**, and any always-on warm-mirror
  daemon (ADR-0116, ADR-0199).
- **Push/Pub/Sub**, and any LAN or remote exposure: the server binds `127.0.0.1`
  (ADR-0082, ADR-0116).
