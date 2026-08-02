# local-mail

Headless Gmail mirror for local tools and agents. It syncs a Gmail account into
a private SQLite database with full pulls plus incremental `history.list`
polling, then exposes the mirror through CLI queries and a stdio MCP server.

Design authority lives in ADRs first, then the current code:
`docs/adr/0081-*.md` (a per-device grant and mirror), `docs/adr/0082-*.md`
(push-free `history.list` polling), `docs/adr/0098-*.md` (state round-trips
through Gmail), `docs/adr/0116-*.md` (desktop-first, one Bun engine), and
`docs/adr/0188-*.md` (who owns the Google application identity, and the
device-only credential boundary). The mirror is Gmail-owned cache data.
Human-meaningful mail state must round-trip through Gmail, not a local-only
table.

## Shape

- Runtime: Bun. `bun:sqlite` stores the mirror, built-in `fetch` calls Gmail,
  `oauth4webapi` handles OAuth.
- One account directory per connected account, `<data-dir>/<accountEmail>/`,
  holding the disposable `mail.db` mirror, the durable `intent.db` (triage this
  machine has recorded but not yet delivered to Gmail), and the `lock.db` naming
  the account's single reconciler. The refresh token lives in a separate
  `0600 credentials.json` at the data-dir root, never inside the mirror db.
- Data and account directories are `0700`. The SQLite files, their `-wal`/`-shm`
  sidecars, and `credentials.json` are `0600`.
- Tables: `messages`, `labels`, and `_meta`. Thread facts are derived from live
  messages instead of stored in a separate `threads` table.
- `messages.body_text` is decoded at ingest from `text/plain` MIME parts, with
  stripped `text/html` as a fallback. That makes SQL and MCP useful for body
  questions without adding FTS yet.
- The app detail pane can render formatted email from the raw Gmail payload, but
  only behind the SPA sanitizer boundary. DOMPurify strips executable markup and
  remote assets before the single `{@html}` sink renders the body on a light
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

Local Mail requests `gmail.modify` so label changes and trash transitions can
round-trip through Gmail. Although Google grants send at the same OAuth layer,
Local Mail does not expose send, reply, compose, drafts, or permanent delete in
this phase.

Headless bootstrap is still available. The refresh token is redeemed
immediately (one refresh grant plus a profile read), so a dead token fails
here rather than on the first sync, and the account email comes from the
Gmail profile instead of being typed:

```sh
bun run src/bin.ts seed-token <refresh-token>
```

Deliver pending local triage to Gmail, then refresh the mirror:

```sh
bun run src/bin.ts reconcile --full

bun run src/bin.ts reconcile --watch
```

Check connection and mirror state:

```sh
bun run src/bin.ts status
```

Query the mirror:

```sh
bun run src/bin.ts query "SELECT subject, sender FROM messages ORDER BY internal_date DESC LIMIT 10"
```

Triage messages. Each verb records a durable local label assertion; nothing on
this path calls Gmail. Output is human-readable; add `--json` for the typed
report the MCP tool and the `app` HTTP API share.

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
The verb then runs a reconcile pass if it can take the account's lock;
otherwise the open app or the next pass delivers it. Exit 0 means the act is
durable, not that Gmail has heard: only a refusal that recorded nothing (an
unknown label, read-only mode) exits nonzero. `LOCAL_MAIL_READ_ONLY` refuses
every act while leaving `query`, `status`, and `reconcile`'s pull available.

Serve the triage UI and its API from one loopback process:

```sh
bun run src/bin.ts app
```

`app` is the desktop runtime host: it runs the reconcile loop and serves the triage
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
No route writes to Gmail. Every act goes through
`POST /api/accounts/:account/messages/assert` (`{ ids, addLabels, removeLabels }`)
over the same core the CLI verbs and MCP tool use, so archive/read/star/label
and trash all desugar to add/remove sets client-side; the host's reconciler
delivers them, and `POST /api/accounts/:account/reconcile` is the explicit form
of that pass. Reads answer from the mirror with those assertions overlaid, so a
caller sees its own act immediately. `LOCAL_MAIL_READ_ONLY` disables writes end
to end; `--port <n>` pins the server port (`LOCAL_MAIL_PORT` is the env
fallback).

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

- `query`: read-only SQL over the mirror, capped at 1000 returned rows. Join the
  `effective_labels` view to see triage that has not reached Gmail yet.
- `status`: account, cursor, row counts, and how much local triage is still
  undelivered.
- `reconcile`: one pass. Delivers pending assertions to Gmail, then refreshes the
  mirror. Yields cleanly when another owner (the open app) holds the account.
- `assert_labels`: record a label change for 1 to 500 messages by id or exact
  name (`addLabels`/`removeLabels`). Durable and visible to every local read
  immediately; Gmail hears on the next pass. Unlisted under
  `LOCAL_MAIL_READ_ONLY`. The CLI triage verbs above are the human-facing form
  of this one tool.

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
`GmailClient` for delivery and sync folding, mock HTTP endpoints for OAuth, and a real MCP
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
- Send, reply, compose, drafts, and permanent delete.
- Thread-level modify and `messages.batchModify`. Triage is message-level.
- FTS5. `LIKE` over `body_text` is enough for the current mirror size.
- Push/Pub/Sub and any LAN or remote exposure (the server binds `127.0.0.1`).
