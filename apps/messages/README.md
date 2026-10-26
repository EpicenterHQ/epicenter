# Messages

Read conversations and send text replies through Beeper Desktop, using
Epicenter's own interface. The app always starts with fictional demo chats.
It makes no Beeper request until you explicitly connect from the desktop app.

## Run and check safely

```sh
bun dev:messages
bun run --cwd apps/messages typecheck
bun run --cwd apps/messages test
bun run --cwd apps/messages smoke:browser
bun test packages/cli/src/messages.test.ts
bun run --cwd apps/messages build:host
```

The browser development app runs on port 5188. Demo replies and incoming
messages stay in memory and reset on reload. Drafts survive reload in this
browser origin's isolated IndexedDB folder. The browser smoke uses a fresh
Chromium profile, blocks other HTTP origins, and tests only fictional chats.
CLI tests inject a fake network and memory credentials. No checks need a real
Beeper account, a saved token, or a real recipient.

The Community garden conversation includes a generated photo you can enlarge.
Noah's conversation has a downloadable fictional route file. Both assets are
bundled with the app; viewing them never fetches from Beeper or another website.
These previews demonstrate media in demo mode. Live media still opens in Beeper.

Epicenter bundles the host build at `/messages/`, offers Messages from its
Folders window, and binds its window to the chosen folder. Its default native
folder is `Messages` under Epicenter's authored folder root. Build only this
bundle with `bun run --cwd apps/epicenter build:bundled messages`; the native
shell and its compiled CLI must also be rebuilt for the new command.

## What persists

| Data | Owner and location |
| --- | --- |
| Conversation and message history, accounts, delivery | Beeper; fetched into an in-memory query cache, never mirrored into this folder |
| Current composition | `drafts/<mode>-<digest>.md` in the bound folder; IndexedDB in the browser |
| Latest submitted attempt and checked outcome | `attempts/<mode>-<digest>.md`, written only by serialized send/recovery workflows |
| Beeper access token | Device keychain, through the Epicenter CLI; scoped to the installation's app-data directory |
| Selection, filter, loaded pages, connection mode | Memory; every launch begins in demo mode |
| Source code and fictional fixtures | This source repository |

Selecting a conversation creates no file; the first keystroke schedules its
draft save. Each composer keeps its own typed text until that save answers. If a
save fails, the text stays in the composer with Save again, Discard, and Copy
controls while it is open. Draft saves debounce for about a second and send the
latest text when the composer closes or the page unloads. Switching between
conversations can briefly show an older saved value. The folder mirror shows
only files that landed on storage. The conversation list therefore shows a
**Draft** preview after a save, usually about a second after
typing. Empty drafts show the latest message instead. An unresolved attempt
shows **Check send** with its submitted text. Previews include only drafts
matching the current demo/live mode and connection profile.

The draft file records `chatId`, `profile`, and `mode` in Markdown frontmatter;
its body is the composition. Old undeclared `state` and `pendingId` keys remain
readable, but old draft-file send recovery is no longer supported. The separate
attempt file records the latest submitted text, its unique `attemptId`, its
`state`, and the Beeper `pendingId` when accepted. An invalid or unreadable
draft needs Markdown repair before composition; a failed read offers **Read
again**. A failed write leaves the mirror at its saved value. The composer
keeps the unsaved text and shows the failed save beside the editor. Send and
recovery commands show their own failures.

Draft filenames hash the mode, account-set identity, and chat ID; demo and live
drafts never share a file. The folder closes when the app unmounts. Leaving asks once, only while a
write is out: a browser tab shows "Leave site?", and a desktop window waits for
writes and closes; closing again while it waits asks whether to close anyway.

These are private personal files, not source files. The app creates no Git
repository, commit, or remote. If you deliberately put its folder under Git,
drafts follow that folder's Git policy. Synced drafts and send receipts are
not a multi-device outbox; composing and sending from multiple replicas is
outside this version's guarantee. No persistent message cache or app-data
database is needed yet.

## Connect Beeper

In the desktop app, choose **Connect Beeper**. Create an access token under
Beeper Settings → Integrations → Approved connections, paste it, and connect.
An existing token is used only after pressing Connect again. Disconnect removes
Epicenter's saved token; it does not revoke the Beeper-issued token or delete
drafts. Beeper must remain running on this device.

The page calls only `messages_beeper`, a fixed native command granted only to
Messages windows. It runs `epicenter messages --json` with a validated operation
on stdin. The CLI owns credentials and the TypeScript Beeper SDK, fixes its
endpoint to `http://127.0.0.1:23373`, and disables SDK retries. Tokens never
appear in command arguments, folder files, browser storage, or error output.
The desktop page's existing connection policy is unchanged.

Manual token setup is the first connection flow; OAuth onboarding is not
implemented. Do not connect production accounts while developing or testing.
Use demo mode or a separate Beeper installation with test accounts for a
future manual integration check.

## Reading and sending

Recent conversations combine networks, filter by loaded title and network,
and offer additional pages. Conversations offer older messages, plain text,
timestamps and available delivery status. Unsupported content has a placeholder
and an **Open in Beeper** action. Incoming data refreshes every four seconds
for an open conversation and every five seconds for the list while visible.
The app sends no read receipts and provides no archive, delete, edit, reaction,
account-management or new-conversation operation.

A send captures the text on screen and the latest visible attempt ID when
clicked, then waits for pending composer typing to land. The attempt records
the text captured at the click, even if typing continues. Within the in-tab
queue and browser Web Lock, it first reads the attempt file from storage and
checks that it agrees with the folder mirror.
A mismatch refuses the send and asks the folder to read again. It also refuses
an unresolved or changed attempt, a draft with Markdown issues, and a draft
whose conversation or connection does not match the selected chat.

The app saves a new **sending** attempt before contacting Beeper. It clears the
composer only when the displayed text is unchanged, then waits for that clear
to land. If the clear fails, nothing is sent; the attempt is acknowledged and
the saved draft text can be sent again. If Beeper does not confirm the send,
the attempt stays unresolved. If Beeper accepts it, the app records the receipt
on the attempt file. A failed receipt also leaves the attempt unresolved, so
the person must check Beeper before another send.

**I checked** acknowledges the specific attempt shown on screen. **Keep as
draft** restores its text when the composer is empty. A stale check cannot
restore an accepted send or acknowledge a newer attempt, even when both
attempts have identical text. Reload, reconnect, and draft saves never replay
sends.

This is local send recovery, not backend idempotency or a multi-device outbox.
Intentional external edits to attempt records can change the protocol. Browser
Web Locks coordinate participating tabs; the desktop shell uses one window per
folder.

References: [Beeper Desktop API](https://developers.beeper.com/desktop-api/),
[authentication](https://developers.beeper.com/desktop-api/auth/).
