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

Folder's edit owner handles draft autosave and failures; `FolderApp` owns
storage closure. Selecting a conversation creates no file; first input creates its draft.
Text typed into it uses Folder's file edit handle, so leaving the view retains
input. The conversation list shows **Draft** and a one-line preview from that
same input, including before autosave and after a failed save. Empty replies
show the latest message instead. An unresolved attempt says **Check send**, retaining its submitted text separately
from the next composition. Only drafts matching
the current demo/live mode and connection profile are shown.

`createQuery(() => context.queries.rows('drafts'))` discovers the saved Markdown
files. Tracked `createFileEdit` adapters supply their current frontmatter and
body, and a derived map joins previews to conversations by `chatId`. The query
cache owns listing and refresh, and FileEdit owns accepted input and saving;
there is no second draft store or SQL cache.

Pending or failed saves prompt before the window closes. Cancel keeps the edit available; confirming
closes immediately and may discard unsaved input. Draft filenames hash the mode, account-set identity and chat ID;
demo and live drafts never share a file. Markdown frontmatter records `chatId`,
`profile`, `mode`, `state` and `pendingId`; the body is draft text. Malformed
drafts remain on disk and block composition rather than being overwritten.

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

A send enters Folder work before waiting on the local draft queue or browser
Web Lock. Inside that turn it reads the persisted attempt and refuses another
send while the outcome is unresolved. It saves the attempted message durably
before contacting Beeper. Composer autosave cannot erase that record because it
writes a different file. Send captures its displayed source and preceding attempt
before waiting, and refuses if another submission has since been recorded. Only one latest attempt is retained for each draft. Its unique `attemptId` binds
checked recovery to the exact operation the person saw, even for identical messages.

After its attempt is durable, the send clears its captured composition only if
that source stayed unchanged during publication. Any newer composition, including
identical text typed after another change, remains available. Receipt publication
updates only the attempt. A remounted recovery action takes the same turn and
rechecks persistence, so it cannot restore a message that has since succeeded.
**I checked** explicitly acknowledges an unresolved outcome. The submitted text
remains available to copy. Existing unresolved records in draft files still
require checked recovery before composing again. Normal close drains submitted
writes without waiting for a backend reply or its later receipt write. If the
folder closes before a receipt can be saved, the durable attempt remains
unresolved and requires checked recovery. Reload, reconnect, and draft autosave
never replay sends.

This is local send recovery, not backend idempotency or a multi-device outbox.
Intentional external edits to attempt records can change the protocol. Browser
Web Locks coordinate participating tabs; the desktop shell uses one window per
folder. Memory retention does not provide durable crash recovery for text whose
publication failed.

References: [Beeper Desktop API](https://developers.beeper.com/desktop-api/),
[authentication](https://developers.beeper.com/desktop-api/auth/).
