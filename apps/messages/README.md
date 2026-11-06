# Messages

Read conversations through Beeper Desktop and stage replies as Markdown
notes on this computer, then send the ones you choose. Messages runs on the
computer where Beeper Desktop runs. Its desktop app starts the local program
and opens the page in its own window. The terminal path remains available:

```sh
bun run --cwd apps/messages start    # build, then serve http://127.0.0.1:5188
```

The terminal-served browser page, once loaded, reopens offline: Kit registers `src/service-worker.js`
(the shared `cacheSite` from `@epicenter/vite-config/offline`), which caches
the page and its static files and passes everything else through, and
`static/site.webmanifest` makes the browser page installable (decision 85).
That manifest names no icon; the desktop bundle has its own Messages icon.

Epicenter no longer hosts apps
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)), and
Beeper Desktop listens only on this computer, so a page served from anywhere
else (`bun dev:messages`, a static host) shows the fictional demo only and
says how to start Messages.

## Desktop

The desktop app is a small Tauri shell. It starts the same Bun local program
as `start`, waits for the program to open the folder and listen on a fresh
loopback port, then opens that page in its own window. The program keeps the
same `~/Epicenter/Messages` folder, send journal, and keychain entry as
`start` and `epicenter messages --json`, so every path uses one send owner.

```sh
bun dev:messages:desktop
bun build:messages:desktop
```

The development identity uses its own app data and keychain scope, and keeps
replies under `~/Epicenter Dev/Messages`. A desktop build does not register a
service worker. If its local program cannot answer, the window shows a failure
instead of substituting fictional conversations. The labeled **Try the demo**
control inside a running Messages app remains available.

The desktop build is macOS-focused. Its sidecar compiles only for the host's
Rust target triple. The app is unsigned, has no automatic updates, and uses a
fresh port each time it starts. `tauri dev` first makes a static desktop build,
so it has no hot module replacement.

## Run and check safely

```sh
bun dev:messages                                     # demo only, port 5188
bun dev:messages:desktop                             # isolated desktop development build
bun run --cwd apps/messages typecheck
bun run --cwd apps/messages test
bun x playwright test -c apps/messages/playwright.config.ts
bun test packages/cli/src/messages.test.ts packages/cli/src/messages-outbox.test.ts
```

The end-to-end suite builds Messages and serves it with its own local
program on ports 5189 and 5191 (which must be free), with the real send owner over
separate scratch Messages folders and journals and a fake Beeper in place of the CLI's
connection, in Chromium and WebKit. It covers replies opening from the folder
before Beeper connects, editing and marking ready with no send, importing a
draft an earlier Messages kept in the browser, Send selected, a send with no
answer and its check, a reload that sends nothing, `epicenter check` of the
folder, the demo, and reopening the page offline from its service worker (in
Chromium with `context.setOffline`; WebKit under Playwright blocks an offline
navigation before any service worker sees it, so there it checks that the
worker controls the page and has cached it). No check reads the keychain,
needs a real Beeper account, or reaches a real recipient.

The Community garden conversation includes a generated photo you can
enlarge, and Noah's a downloadable fictional route file. Both are bundled
with the app; viewing them never fetches from Beeper or another website. Live
media still opens in Beeper.

## What it keeps

| Data | Where |
| --- | --- |
| Conversations, messages, accounts, delivery | Beeper; read into an in-memory query cache, never kept here |
| Replies, draft or ready | `~/Epicenter/Messages/replies/<id>.md` |
| Send attempts | `~/Library/Application Support/so.epicenter/messages/sends.sqlite` |
| Beeper access token | The device keychain, through the Epicenter CLI |
| Selection, filter, loaded pages, demo | Memory |

The folder is `Messages` under the Epicenter folder, or under
`EPICENTER_FOLDER_DIR`; the journal is under the app's data directory, or
`EPICENTER_DATA_DIR` (`messagesPaths` in `@epicenter/cli/messages`).
The local program prints the folder's path when it starts.

A reply is a note of Messages' contract (`messagesContract` in
`@epicenter/cli/messages-contract`, published as `static/contract.json`):

```md
---
chatId: '!abc:beeper.com'
chatTitle: Ada Test
profile: 3f1c…            # sha256 of the Beeper account ids it was written for
status: ready             # or draft
---
See you at ten.
```

You and your agents can read, write, and edit these with any editor, with or
without Beeper running; Messages shows changes within a few seconds, and
`epicenter check http://127.0.0.1:5188/contract.json ~/Epicenter/Messages`
checks them. A new note needs a unique `<id>` (Messages uses `timeId()`), the
conversation's `chatId`, and the `profile` of the accounts it is for, which
any reply Messages wrote carries. Neither `draft` nor `ready` sends anything.
A note that does not read is shown with its text, to fix in place or in any
editor.

Messages has no online data variant
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)):
Beeper Desktop only listens on this computer. The send journal belongs to
this computer's Beeper installation;
if you sync the folder to another computer, a ready reply could be sent from
either.

## Reading and replying

Served by its local program, Messages opens on **Replies**: every reply in
the folder, whether or not Beeper is running. It then connects with the saved
Beeper token, if there is one. Connecting reads; it never sends.

With Beeper connected, recent conversations combine networks, filter by
loaded title and network, and load further pages. A conversation shows plain
text, timestamps, and delivery status where Beeper has it; other content has
a placeholder and **Open in Beeper**. Below it are the replies to that
conversation and a box for a new one: **Save draft** or **Save as ready**.
An open conversation refreshes every four seconds, the list every five, and
Replies every three. Messages sends no read receipts and offers no archive,
delete, edit, reaction, account, or new-conversation operation in Beeper.
From Replies, **New reply to this conversation** starts another local draft
for any conversation already named in a reply, even when Beeper is offline.
To start a reply to a conversation that has no local note yet, open that
conversation while Beeper is connected.

## Sending

In Replies, a ready reply for the connected accounts can be selected, and
**Send selected** sends the selected ones, in order. It is the only control
that sends. Each selected reply is named with the version shown, and the one
send owner (`createMessages` in `@epicenter/cli/messages-outbox`), which the
local program and `epicenter messages --json` share, takes each in turn:

1. skips it unless the note is still that version, ready, for the connected
   accounts, and at most 20,000 characters;
2. records the attempt and its exact text in the journal, durably, before
   Beeper is asked, unless the reply already has a send to check, its chat
   has a send with no answer, or this exact text was already sent;
3. asks Beeper once, and records what Beeper answered.

Each reply then shows what happened to it. **Sent to Beeper** follows
Beeper's pending id until Beeper reports it sent, and then the note leaves
the folder, unless it was edited since. **Not delivered** keeps the note. A
send with no answer (Beeper did not respond, or Messages stopped) shows
**Check in Beeper**: Messages never asks again on its own, holds back later
replies to that chat, and waits for **I checked Beeper: it was sent** or
**I checked Beeper: not sent**. Replies to other chats still go. A send to
check whose note is gone is listed under **Sends to check** with its text,
and comes back as a draft if it was not sent.
If a failed send's reply file is missing, Messages restores its text as a
draft when the folder is writable. Until then, Replies shows the journal's
copy under **Sends without reply files**.

Reload, reconnect, restarting Messages, and saving a reply never send. This
does not make Beeper idempotent: after a crash between recording an attempt
and Beeper's answer, only a person can say whether it went.

Agents should list the staged replies through `epicenter messages --json`
with `{"action":"replies"}` on stdin. To send, they pass an explicit
`{"action":"send","items":[{"id":"...","over":"..."}]}` using each
selected reply's current `id` and `version` from that list. This uses the
same journal and checks as the page. Sending directly through Beeper MCP
bypasses the staging record, so agents handling these replies should use
the Messages command.

## Drafts kept in this browser

An earlier Messages kept drafts in this browser's private files for
`http://127.0.0.1:5188` (OPFS: `drafts/` and `attempts/`). Messages reads them
and changes nothing there. Replies lists live drafts with text, sends Beeper
never confirmed, and notes that do not read, under **Drafts kept in this
browser**, each with Copy and, where the conversation is known, **Import as
draft**, which saves a copy in the folder. Check Beeper before importing an
unconfirmed send. Fictional demo drafts are left where they are.

## Connect Beeper

With Messages started, **Connect Beeper** takes an access token created under
Beeper Settings → Integrations → Approved connections. The page sends it once
to the local program, which stores it in the keychain; Connect again with the
field empty uses the saved one. Disconnect removes the saved token; it does
not revoke the token Beeper issued or touch your replies. Beeper must keep
running on this computer.

The local program (`scripts/serve.ts`) listens on `127.0.0.1` only and
answers `POST /messages` only when the request names its own host (so a
DNS-rebound name cannot reach it), comes from its own origin (so another site
open in the browser cannot), and is JSON. It answers each operation as
`epicenter messages --json` does: validated against `messagesRequest`, with
the Beeper endpoint fixed to `http://127.0.0.1:23373` and SDK retries off.
Tokens never appear in command arguments, files, browser storage, or error
output.

Manual token setup is the only connection flow. Do not connect production
accounts while developing; use the demo, or a separate Beeper installation
with test accounts.

## The demo

**Try the demo**, or any page not served by the local program, shows three
fictional conversations. The web fallback and **Try the demo** run the same send owner over replies and
a journal in memory, with a fake Beeper that cannot reach a network, so
drafts, Send selected, and a send with no answer (**Simulate send failure**)
behave as they do live. Everything in it resets on reload.

The decision and its alternatives:
[ADR-0704](../../docs/adr/0704-messages-stages-replies-as-folder-notes-and-sends-only-selected-ones-through-one-journaled-owner.md).
References: [Beeper Desktop API](https://developers.beeper.com/desktop-api/),
[authentication](https://developers.beeper.com/desktop-api/auth/).
