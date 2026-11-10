# Messages

Fictional Beeper conversations, as an app in `~/Epicenter/messages`.
Nothing reaches Beeper. Only `demoBeeper` exists: there is no live mode,
account, or credential setup. `epicenter` runs the actions; `epicenter serve`
serves the UI at `/messages/`.

## Files

```txt
messages/
  epicenter.ts             collections and five actions
  beeper.ts                fictional conversations and demoBeeper
  drafts/<chat>.md         saved reply in the body
  sends/<chat>.md          latest send, its attempt and state, text in the body
  beeper-demo.local.json   fictional sent messages, ignored by Git
  ui/                      SvelteKit UI with hash routes
  .cache/ui/               built UI, ignored by Git
```

Drafts have no fields. Sends have `attempt`, `state`, and `at`, with optional
`messageId`, `error`, and `checked`. States are `sending`, `sent`, `unconfirmed`,
and `not-sent`. Earlier send records remain in Git history. Delete
`beeper-demo.local.json` to reset the fictional Beeper messages; this leaves
saved drafts and send records alone.

## Actions

| Action | Does |
| --- | --- |
| `conversations` | Lists conversations newest first, with draft and send summaries |
| `read <chat>` | Reads messages, the saved draft, and latest send |
| `draft <chat> <text> [--previous <text>]` | Saves the whole draft; `''` clears it; a stale `previous` throws `Changed` |
| `send <chat> [--text <text>]` | Sends the saved draft once; optional text checks what you last read |
| `resolve <chat> <outcome> --attempt <id>` | Records a person's check as `sent` or `not-sent`; never sends |

```sh
epicenter messages conversations
epicenter messages read maya-chen
epicenter messages draft maya-chen "See you at ten"
epicenter messages send maya-chen
epicenter messages resolve harbor-ferry sent --attempt <id>
```

Quote the actual attempt value in place of `<id>`. MCP exposes the same five
actions as `messages_conversations`, `messages_read`, `messages_draft`,
`messages_send`, and `messages_resolve`. Collection verbs are not exposed.

## Sending once

1. Claim `sends/<chat>.md` with a new attempt and state `sending`. The
   compare-and-write refuses a prior `sending` or `unconfirmed` attempt.
2. Consume the saved draft only if it still matches. If it changed, put the
   record back byte for byte and send nothing. A thrown send changes no file.
3. Ask `demoBeeper` to send the consumed text once.
4. Record `sent` and the message id, or `unconfirmed` and the error. Return
   `outcome: 'sent'` or `outcome: 'unconfirmed'` with the send summary. An
   unconfirmed result includes `next`, explaining how to check and resolve it.

A blind retry finds an empty draft or a blocked send record. Two callers
compete for one file through `folder.update`, so only one reaches Beeper.
Messages never resends on its own. A person checks an unconfirmed message in
the conversation and resolves its attempt. A `sending` attempt interrupted
for more than 30 seconds also needs that check. Resolving `not-sent` restores
the sent text only when the draft is empty, so a newer reply survives.

The Harbor ferry desk demonstrates a lost confirmation: it records the
fictional message, then throws. Read the conversation to see it, then choose
“It was sent”. A new draft cannot be sent until the attempt is resolved.
Choosing “It wasn't sent” restores an empty draft and permits another send,
even though this fixture already delivered the first one. The person's check
is what decides; Messages cannot infer delivery from a timeout.

An unconfirmed send exits successfully and commits the consumed draft and send
record together as `messages: send harbor-ferry`. For example:

```txt
$ epicenter messages send harbor-ferry
outcome: unconfirmed
chat: harbor-ferry
send:
  attempt: 2026-11-11T09-00-00-000Z-abc123
  state: unconfirmed
  at: 2026-11-11T09:00:00.000Z
  text: Is there room for a bicycle?
  error: Beeper did not answer within 30 seconds
  needsCheck: true
next: Beeper did not confirm the message to Harbor ferry desk. It may have been sent: check the conversation, then run epicenter messages resolve harbor-ferry sent|not-sent --attempt 2026-11-11T09-00-00-000Z-abc123. Messages will not send it again on its own.
```

Draft and resolution calls commit as `messages: draft harbor-ferry` and
`messages: resolve harbor-ferry`. Refused calls commit nothing and leave files
unchanged. If a run dies after claiming, its `sending` record remains on disk.
The next serve backup snapshots it as `messages: changed outside epicenter`:
no action call finished to commit those changes.

See [ADR-0874](../../docs/adr/0874-an-unconfirmed-messages-send-blocks-the-next-send-until-a-person-resolves-it.md)
for the decision and limits.

## The UI

`#/` lists conversations; `#/<chat>` opens one. Desktop shows two panes;
mobile shows one. The list refreshes every 10 seconds while visible, and the
conversation every 5 seconds. Both refresh on focus and when shown again.

Drafts save after an 800 ms pause, on blur, on Save, on Cmd/Ctrl+S, and when
the page is hidden or left. Each save quotes the last saved draft as `previous`.
A conflict offers “Keep mine” and “Use theirs”. A refresh replaces the composer
only when it has no unsaved edits, save in flight, or send in flight.

Send and Cmd/Ctrl+Enter save pending edits first, then send that saved draft.
The recovery banner quotes an unconfirmed send and asks the person to check
it above. Sending stays disabled until they resolve it. Browser page exit
saves are best effort: use Save and wait for “Saved” before closing if the
text matters.

## Checks and development

From the repository root:

```sh
bun install --no-save
bun run --cwd apps/messages typecheck
bun run --cwd apps/messages test
bun run --cwd apps/messages/ui typecheck
bun run --cwd apps/messages/ui build
bun dev:messages
```

The build writes `.cache/ui/index.html`. For development, run `epicenter serve`
for the Epicenter containing Messages, then the UI dev command. The UI asks
that server to run the same actions as the CLI and MCP.
