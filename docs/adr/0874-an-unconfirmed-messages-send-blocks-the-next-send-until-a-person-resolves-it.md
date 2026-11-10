# 0874. An unconfirmed Messages send blocks the next send until a person resolves it

- **Status:** Proposed
- **Date:** 2026-11-11
- **Amends:** [ADR-0784](0784-whispering-is-the-webs-local-app-and-messages-is-a-program-on-this-computer.md) at “Messages is a program on this computer”: Messages is an app in an Epicenter; `epicenter` runs its actions and `epicenter serve` serves `/messages/`. It has no program, listener, or data directory of its own.
- **Relates:** [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md)
- **Unbuilt:** A Beeper adapter reading Beeper Desktop on the computer that runs `epicenter serve`, with its token in `beeper.local.md`. Only `demoBeeper` exists; it uses fictional conversations and nothing reaches Beeper.

## Context

Messages was a local program: `scripts/serve.ts` listened on
`127.0.0.1:5188`, with `drafts/<id>.md` and `attempts/<id>.md` under
`<data root>/apps/so.epicenter.messages`. Attempts had states `sending`,
`accepted`, and `acknowledged`. The UI wrote drafts on every keystroke.
A Web Lock excluded another send in one browser; two browsers could both
reach Beeper.

An Epicenter action runs in a fresh process for each call. No process or
browser lock spans calls. `folder.update` compares the file it read before
writing, and reruns its revision when another process changes that file.
A send may reach Beeper even when its answer never arrives. Repeating it
cannot establish what happened and can deliver the same text twice.

## Decision

**Messages is an app whose files hold drafts and the latest send per conversation.**

```txt
messages/
  epicenter.ts
  beeper.ts
  drafts/<chat>.md          body: the saved reply
  sends/<chat>.md           attempt, state, at; body: the text sent
  beeper-demo.local.json    fictional provider state, ignored
  ui/                      hash routes, built into .cache/ui/
  .cache/ui/               ignored; served at /messages/
```

A send's optional fields are `messageId`, `error`, and `checked`. Its state is
`sending`, `sent`, `unconfirmed`, or `not-sent`. A draft has no fields.
The declaration exposes exactly five actions, with no collection verbs:

| Action | Contract |
| --- | --- |
| `conversations` | Newest conversations first, with drafts and send summaries |
| `read <chat>` | Messages, saved draft, and latest send |
| `draft <chat> <text>` | Replace the whole draft, optionally quoting `previous`; empty text clears |
| `send <chat>` | Consume and send the saved draft once; optional `text` checks the last read |
| `resolve <chat> <outcome> --attempt <id>` | Record a person's check as `sent` or `not-sent`; never call Beeper |

**A send takes the conversation's saved draft, never free text.**

The optional `text` is a comparison with the saved draft, not content to send.
The send follows four steps:

1. Claim `sends/<chat>.md` with a new attempt, `sending`, and `at` through
   add-when-absent or compare-and-write. Refuse a prior `sending` or
   `unconfirmed` record.
2. Consume the draft through compare-and-write only while its trimmed text
   still matches. If it changed, put the record back as it was and send nothing.
3. Ask Beeper once, using the consumed text.
4. Record `sent` with the returned message id, or `unconfirmed` with the error.
   Return `outcome: 'sent'` or `outcome: 'unconfirmed'`, the chat, and the send
   summary. An unconfirmed result includes a `next` line with the resolve
   command and the actual attempt id.

Two concurrent sends compete for one claim file, so one reaches Beeper.
A blind retry finds either the empty draft or the blocking claim. In the
terms of ADR-0859, `send` is the verb that is not safe to repeat and therefore
keeps its own record. It never resends on its own.

**An unconfirmed send is resolved by a person, never by a retry.**

`resolve` requires the latest attempt id and a person's `sent` or `not-sent`
outcome. It refuses a different attempt and a contradictory resolution;
repeating the same outcome is idempotent. It records `checked` without asking
Beeper. `not-sent` puts the text back only while the draft is empty.

`SEND_DEADLINE_MS` is 30 seconds. A `sending` attempt younger than the deadline
cannot be resolved. After the deadline it is treated as interrupted and needs
a person's check, just like `unconfirmed`; elapsed time never proves failure.
The UI quotes the text, time, and error and asks the person to look for it in
the conversation. The Harbor ferry desk fixture delivers its fictional message
and then throws, demonstrating why a missing answer cannot authorize a retry.

**A draft is saved on a pause, on blur, and on Save.**

The pause is 800 ms. Cmd/Ctrl+S and hiding or leaving the page also attempt a
save. A save passes `previous`, the draft as last read or saved; the comparison
runs inside the compare-and-write. A mismatch throws `Changed` and offers
“Keep mine” or “Use theirs”. Refreshes preserve dirty or in-flight edits.
Sending saves pending edits first, then checks that same text again.

## Consequences

The CLI records `messages: draft <chat>`, `messages: send <chat>`, and
`messages: resolve <chat>`. An unconfirmed send returns successfully, so its
consumed draft and send record commit together as `messages: send harbor-ferry`.
A thrown send changes no file: a refused draft consumption restores the
pre-claim record byte for byte, or removes the new claim.
The `sending` state is on disk before Beeper is asked. Ordinarily the action's
commit contains its final state; if the run dies, the pending claim survives
and the next serve backup snapshots it as `messages: changed outside epicenter`,
since no action call finished.
The intermediate `sending` state is not separately committed during a
successful run.

Only the latest send per conversation is a file. Earlier attempts remain in
Git and delivered messages remain in Beeper. This is not an outbox. Hand
edits to `sends/` can defeat the protection. Two computers with clones are
not kept apart: the app has one home, as described in
[ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md).

A person's mistaken `not-sent` decision can permit a duplicate. Refusing to
infer delivery gives the person that responsibility. No live adapter is
implemented by this decision's demo.

## Considered alternatives

- Throwing on an unconfirmed send: the CLI commits nothing for a thrown action,
  so the consumed draft and the record would be left for a backup to mislabel.

- The old program and its own listener: duplicates the Epicenter action runner
  and UI host.
- `send` taking free text: a retry after a lost answer sends twice.
- One file per attempt, `sends/<time>.md`: no single conversation file to claim.
- One file holding draft and send: their histories interleave and a draft save
  could overwrite send state.
- Asking Beeper to decide the outcome automatically: a missing answer still
  leaves the delivery uncertain; this demo makes the person's check explicit.
