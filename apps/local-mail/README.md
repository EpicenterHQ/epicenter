# local-mail

Headless Gmail mirror for local tools and agents. It syncs a Gmail account into
a private SQLite database with full pulls plus incremental `history.list`
polling, then exposes the mirror through CLI queries and a stdio MCP server.

Design authority lives in ADRs first: `docs/adr/0081-*.md`,
`docs/adr/0082-*.md`, `docs/adr/0087-*.md`, then the current code. The mirror is
Gmail-owned cache data. Human-meaningful mail state must round-trip through
Gmail, not a local-only table.

## Shape

- Runtime: Bun. `bun:sqlite` stores the mirror, built-in `fetch` calls Gmail,
  `oauth4webapi` handles OAuth.
- One SQLite file per connected account: `<data-dir>/<accountEmail>/mail.db`.
  The refresh token lives in a separate `0600 credentials.json` at the data-dir
  root, never inside the mirror db.
- Data and account directories are `0700`. `mail.db`, `mail.db-wal`,
  `mail.db-shm`, and `credentials.json` are `0600`.
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

Connect once. Local Mail is BYO: set one Google OAuth Desktop client pair as
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`, then run the connect flow. The stored
token records the concrete client id that minted it, and later refreshes refuse
if the configured client id changes:

```sh
bun run src/bin.ts connect
```

The client pair is machine-level bring-your-own configuration, not Epicenter
infrastructure. Provide it however you keep local secrets for the first connect:
an export, a local `.env`, or a secrets manager such as
`infisical run --path=/apps/local-mail -- bun run src/bin.ts connect`. On the
first successful connect or refresh, Local Mail caches the pair to a 0600
`<data-dir>/provider.json` sibling to `credentials.json`. Every later run and
every other git worktree on this machine reads it from there, so no per-worktree
secrets config is needed. See [`.env.example`](.env.example) for the canonical
names.

Local Mail requests `gmail.modify` so write-through label changes can round-trip
through Gmail. Although Google grants send at the same OAuth layer, Local Mail
does not expose send, reply, compose, drafts, trash, untrash, or delete in this
phase.

Headless bootstrap is still available. The refresh token is redeemed
immediately (one refresh grant plus a profile read), so a dead token fails
here rather than on the first sync, and the account email comes from the
Gmail profile instead of being typed:

```sh
bun run src/bin.ts seed-token <refresh-token>
```

Build or refresh the mirror:

```sh
bun run src/bin.ts sync --full

bun run src/bin.ts watch
```

Check connection and mirror state:

```sh
bun run src/bin.ts status
```

Query the mirror:

```sh
bun run src/bin.ts query "SELECT subject, sender FROM messages ORDER BY internal_date DESC LIMIT 10"
```

Triage messages. Each verb is a Gmail label change that the mirror folds in
after Gmail accepts it. Output is human-readable; add `--json` for the typed
`ModifyMessageLabelsOutcome` that MCP and the `app` HTTP API share.

```sh
bun run src/bin.ts archive <id...>
bun run src/bin.ts unarchive <id...>
bun run src/bin.ts mark-read <id...>
bun run src/bin.ts mark-unread <id...>
bun run src/bin.ts label <id...> --add Work --remove Promotions
```

`archive`, `mark-read`, and friends are the triage vocabulary; `label` is the
transparent primitive they desugar to (`archive` is `label --remove INBOX`).
Any per-id rejection or a systemic abort exits nonzero, so
`mark-read <id> && next` never proceeds on a mailbox that did not change.
`LOCAL_MAIL_READ_ONLY` refuses every write while leaving `query`/`status`/`sync`
available.

Serve the triage UI and its API from one loopback process:

```sh
bun run src/bin.ts app
```

`app` is the desktop runtime host: it runs the sync loop and serves the triage
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
The label write route is `POST /api/accounts/:account/messages/modify`
(`{ ids, addLabels, removeLabels }` -> `ModifyMessageLabelsOutcome`) over the
same core the CLI verbs and MCP tool use, so archive/read/label all desugar to
add/remove sets client-side. `LOCAL_MAIL_READ_ONLY` disables writes end to end;
`--port <n>` pins the server port (`LOCAL_MAIL_PORT` is the env fallback).

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
headless `sync`, `query`, and `mcp`, which operate on one account per process.

Tools:

- `query`: read-only SQL over the mirror, capped at 1000 returned rows.
- `status`: account, cursor, and row counts.
- `sync`: one local mirror refresh pass. This writes only the local cache.
- `modify_labels`: add or remove Gmail labels on 1 to 100 messages by id or
  exact name (`addLabels`/`removeLabels`), then fold Gmail's response. Per-id
  rejections ride inside the structured result; only a systemic abort sets
  `isError`. Unlisted under `LOCAL_MAIL_READ_ONLY`. The CLI triage verbs above
  are the human-facing form of this one tool.

## Config

- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`: the BYO Google OAuth Desktop client
  keys. The resolver reads them at connect/refresh from the environment first,
  then `<data-dir>/provider.json`, which is cached as `0600` on first connect.
  Missing credentials fail loudly naming the exact variables.
- `LOCAL_MAIL_ACCOUNT`: optional account override for `sync`, `query`, and
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
  Bun sidecar and bundled SPA resources; signing and notarization still need
  Apple Developer credentials and config, as described in `src-tauri/README.md`.
- Send, reply, compose, drafts, trash, untrash, and permanent delete.
- Thread-level modify and `messages.batchModify`. Triage is message-level.
- FTS5. `LIKE` over `body_text` is enough for the current mirror size.
- Push/Pub/Sub and any LAN or remote exposure (the server binds `127.0.0.1`).
