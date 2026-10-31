# Messages

Read conversations and send text replies through Beeper Desktop, in
Epicenter's own interface. Messages is a program you run on the computer
where Beeper Desktop runs: a small local server serves the page and answers
its Beeper requests through the Epicenter CLI, which keeps the Beeper token
in the device keychain. It always starts with fictional demo chats.

```sh
bun run --cwd apps/messages start    # build, then serve http://127.0.0.1:5188
```

A page loaded once reopens offline: Kit registers `src/service-worker.js`
(the shared `cacheSite` from `@epicenter/vite-config/offline`), which caches
the page and its static files and passes everything else through, and
`static/site.webmanifest` makes it installable (decision 85). Messages has
no icons of its own, so the manifest names none.

Epicenter no longer hosts apps
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)), and
Beeper Desktop listens only on this computer, so a page served from anywhere
else (`bun dev:messages`, a static host) shows the demo only and says how to
start Messages for live Beeper.

## Run and check safely

```sh
bun dev:messages                                     # demo only, port 5188
bun run --cwd apps/messages typecheck
bun run --cwd apps/messages test
bun x playwright test -c apps/messages/playwright.config.ts
bun test packages/cli/src/messages.test.ts
```

The end-to-end suite builds Messages and serves it with its own local
program on port 5189 (which must be free), with a fake Beeper in place of the
CLI's connection, in Chromium and WebKit. It covers drafts in this browser
(created, edited, cleared, kept across a reload, and made and edited offline
in demo mode), demo sends and their check, repair, `epicenter check` of the
browser's files, live Beeper through the local program, and reopening the
page offline from its service worker (in Chromium with
`context.setOffline`; WebKit under Playwright blocks an offline navigation
before any service worker sees it, so there it checks that the worker
controls the page and has cached it). No check reads the keychain, needs
a real Beeper account, or reaches a real recipient. Demo replies and incoming
messages stay in memory and reset on reload.

The Community garden conversation includes a generated photo you can
enlarge, and Noah's a downloadable fictional route file. Both are bundled
with the app; viewing them never fetches from Beeper or another website. Live
media still opens in Beeper.

## What it keeps

Messages' files are a contract (`src/lib/contract.ts`, published as
`static/contract.json`):

```txt
drafts/<id>.md      the reply being written: chatId, profile, mode; the text in the body
attempts/<id>.md    the latest send from that composer: chatId, profile, mode,
                    state (sending, accepted, acknowledged), attemptId, pendingId;
                    the text sent in the body
```

`<id>` is `<mode>-<sha256 of mode, profile and chat>`, so demo and live
drafts never share a file. The files are this browser's for the origin
Messages is served on (OPFS, `openDevice` from `@epicenter/folder/browser`),
for good.

Messages is local only: of the variants an app may have
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)),
it keeps just the local one, with no online variant, because Beeper Desktop
only listens on this computer. A draft and its send attempt belong to that
Beeper installation, and the send protocol below needs its writes to land
at once, offline or not. Messages never signs in, and nothing uploads.

| Data | Where |
| --- | --- |
| Conversations, messages, accounts, delivery | Beeper; read into an in-memory query cache, never kept here |
| The current reply, the latest send | `drafts/`, `attempts/` in this browser |
| Beeper access token | The device keychain, through the Epicenter CLI (`openBeeper` in `@epicenter/cli/messages`) |
| Selection, filter, loaded pages, connection mode | Memory; every launch begins in demo mode |

Selecting a conversation creates no file; the first keystroke creates its
draft (`fieldEdit` with `create`), and each keystroke after updates it.
Emptying the composer clears the draft (its note stays, with an empty
body); no action deletes a draft's note. The
composer keeps typed text until its save answers; a failed save keeps it with
Save again, Discard, and Copy. The conversation list shows a **Draft**
preview of a non-empty draft, and **Check send** for an unconfirmed attempt,
for the current mode and connection only.

A draft or attempt that does not read as one (another program edited it) is
shown as its text, with what is wrong as typed, and saved fixed with
**Save repair** (`replace`); text that still does not fit is refused and
stays to fix.

## Connect Beeper

With Messages started (`bun run --cwd apps/messages start`), **Connect
Beeper** takes an access token created under Beeper Settings → Integrations →
Approved connections. The page sends it once to the local program, which
stores it in the keychain; Connect again with the field empty uses the saved
one. Disconnect removes the saved token; it does not revoke the token Beeper
issued or delete drafts. Beeper must keep running on this computer.

The local program (`apps/messages/scripts/serve.ts`) listens on `127.0.0.1` only and
answers `POST /beeper` only when the request names its own host (so a
DNS-rebound name cannot reach it), comes from its own origin (so another site
open in the browser cannot), and is JSON. It runs each operation as
`epicenter messages --json` does: validated against the protocol, with the
Beeper endpoint fixed to `http://127.0.0.1:23373` and SDK retries off. Tokens
never appear in command arguments, files, browser storage, or error output.

Manual token setup is the only connection flow. Do not connect production
accounts while developing; use demo mode, or a separate Beeper installation
with test accounts.

## Reading and sending

Recent conversations combine networks, filter by loaded title and network,
and load further pages. A conversation shows plain text, timestamps, and
delivery status where Beeper has it; other content has a placeholder and
**Open in Beeper**. An open conversation refreshes every four seconds and the
list every five. Messages sends no read receipts and offers no archive,
delete, edit, reaction, account, or new-conversation operation.

A send captures the text on screen and the attempt shown, waits for the
composer's typing to land, then, serialized per draft in the tab and by a Web
Lock across tabs:

1. reads the attempts from storage and refuses when they differ from what
   the page shows (another tab sent first);
2. refuses an unconfirmed or changed attempt, a draft or attempt that needs
   repair, and a draft that names another conversation or connection;
3. saves a new **sending** attempt, and clears the draft only when the text
   on screen is unchanged; if the clear fails, nothing is sent and the
   attempt is acknowledged;
4. asks Beeper, and records Beeper's pending id on the attempt when it
   accepts.

If Beeper does not confirm, or the receipt cannot be saved, the attempt stays
unconfirmed and the person must check Beeper. **I checked** acknowledges the
attempt shown; **keep as draft** restores its text when the composer is
empty. A stale check cannot restore an accepted send or acknowledge a newer
attempt. Reload, reconnect, and draft saves never resend.

This is send recovery on one computer, not an outbox: it does not make Beeper
idempotent, and editing attempt files by hand can defeat it.

References: [Beeper Desktop API](https://developers.beeper.com/desktop-api/),
[authentication](https://developers.beeper.com/desktop-api/auth/).
