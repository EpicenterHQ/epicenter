# 0704. Messages stages replies as folder notes and sends only selected ones through one journaled owner

- **Status:** Accepted
- **Date:** 2026-11-02
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (Messages keeps its replies in a local folder); [ADR-0701](0701-apps-run-as-separate-programs.md) (Messages is a program of its own); [ADR-0702](0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md) (a folder write is checked against its version, with no cross-process lock and no fsync).

## Context

Messages kept one draft per conversation as `drafts/<id>.md` and the latest
send from it as `attempts/<id>.md`, both in the browser's private files for
the origin `http://127.0.0.1:5188` (OPFS, `openDevice` from
`@epicenter/folder/browser`). `Startup.svelte` opened them before the app
rendered. The composer's Send button sent at once: `sendDraft` in
`apps/messages/src/lib/drafts.ts` wrote a `sending` attempt and cleared the
draft, then posted through the local program, whose `/beeper` endpoint and
`epicenter messages --json` both answered `{ action: 'send', chatId,
profile, text }` by posting straight to Beeper. That raw send recorded
nothing, so the CLI could post with no attempt at all.

Three things broke that shape. A person and their agents could not read or
edit the drafts outside the browser. Every send went out the moment it was
pressed, with no way to review a batch. And the attempt record had only the
folder file API's durability: an OPFS write, and on the node host a check
then rename with no lock and no fsync (ADR-0702), so neither "recorded before
Beeper was asked" nor "one sender at a time" held across processes.

## Decision

**A reply is a Markdown note in the Messages folder, and saving it never
sends.** The folder is `Messages` under the Epicenter folder
(`~/Epicenter/Messages`, or under `EPICENTER_FOLDER_DIR`), named by
`messagesPaths` in `packages/cli/src/messages.ts`. Its contract is
`messagesContract` in `packages/cli/src/messages-contract.ts`, published as
`apps/messages/static/contract.json`:

```txt
~/Epicenter/Messages/
  replies/<id>.md    chatId, chatTitle?, profile, status: draft | ready; the text in the body
```

`<id>` is a `timeId()` the page makes, so replies sort by when they were
written and one conversation can have several. `status: ready` means a person
or agent reviewed it; it sends nothing either.

**Every send goes through `createMessages` in
`packages/cli/src/messages-outbox.ts`, and it sends only replies named by
version in one `send` operation.** The local program
(`apps/messages/scripts/serve.ts`, `POST /messages`) and
`epicenter messages --json` both answer through `openMessages`; the demo runs
the same `createMessages` in the page over memory. The protocol
(`messagesRequest` in `packages/cli/src/messages-protocol.ts`) admits no
`send` of raw text: `{ action: 'send', items: [{ id, over }] }` names each
reply and the version reviewed. On the page, **Send selected** in Replies is
the only control that issues it. Connecting, reconnecting, reloading, and
starting the local program issue no `send`.

**A send is claimed in the journal, with its exact text, before Beeper is
asked, and an unanswered claim is never asked again.** The journal is
`<data dir>/messages/sends.sqlite` (`openSendJournal` in
`packages/cli/src/messages-journal.ts`), outside the folder, in WAL mode with
`synchronous = FULL` and `fullfsync`. One row per attempt:

```txt
sends(attempt_id, reply_id, reply_version, chat_id, chat_title, profile,
      text, state, active_pid, pending_id, routed_chat_id, delivery, note,
      claimed_at, updated_at)
state: claimed -> accepted -> sent
               \           \-> failed
                \-> not-sent      (accepted or claimed -> sent | not-sent by a person)
```

`claim` is one `BEGIN IMMEDIATE` transaction that refuses while the reply has
a `claimed` or `accepted` row, while the chat has a `claimed` row, or when this
`reply_version` is already `sent`. Only then is Beeper asked, once, with SDK
retries off. Its answer is recorded: a pending id and routed chat
(`accepted`), a 4xx other than 408 and 409 (`not-sent`), or nothing that says
either way (the row stays `claimed`). A `claimed` row nobody is asking about
shows **Check in Beeper** and settles only by a person's **I checked Beeper:
it was sent** or **I checked Beeper: not sent** (`resolve`). Later replies to
that chat are skipped while it stands; other chats go on.
The claim records the sending process ID until its Beeper wait ends. A second
process cannot resolve it while that sender is alive, so a manual resolution
cannot open a second send during the first one's network call. A stopped
process leaves a dead ID, allowing a person to resolve the unknown outcome.

**Beeper's report settles an accepted send by its exact pending id, and only
the confirmed text leaves Markdown.** `check` calls
`messages.retrieve(pending_id, { chatID: routed_chat_id })`. `SUCCESS` marks
the row `sent`, sets its `text` to null, and deletes `replies/<id>.md` over
`reply_version`, so a note edited after its send stays. `FAIL_PERMANENT`
marks it `failed` and keeps the note. A `not-sent` or `failed` send whose note
is gone has it written back as a `draft` when the folder allows it; until then,
the staging list still shows the journal's text. Each selected reply gets one
`SendResult`: `accepted`, `uncertain`, `not-sent`, or `skipped` with why.

**Drafts the browser kept stay where they are, and are copied, never moved.**
`readBrowserDrafts` in `apps/messages/src/lib/browser-drafts.ts` reads the old
`drafts/` and `attempts/` from OPFS and writes nothing there. Replies lists
live drafts with text, unconfirmed sends, and unreadable notes under
**Drafts kept in this browser**, each with Copy, and Import as draft where its
conversation is known. Import saves `replies/browser-draft-<old id>.md` or
`replies/browser-send-<old id>.md`, so a second import is refused. Demo drafts
there were fictional and are not listed.

**The page opens on Replies from the folder, whether or not Beeper answers.**
`Startup.svelte` asks whether the local program serves the page; if it does,
the page lists replies first and then tries the saved token. Served any other
way, or after **Try the demo**, it runs the fictional demo, whose replies and
sends stay in memory.

**Messages has a Tauri shell that starts this same local program.** The shell
starts the compiled `scripts/serve.ts` sidecar with a lifeline on stdin, waits
for its validated `http://127.0.0.1:<port>` readiness line, and opens that
same-origin page in one window. Bun still owns the folder, journal, keychain,
and send path. The release identity keeps the same path defaults as `start`
and `epicenter messages --json`; every other identity uses `~/Epicenter Dev`
and its own app data and keychain scope. The desktop page never falls back to
fictional conversations when its program is unavailable. This shell does not
use `epicenter-standalone`, whose page opens folders through Tauri's folder
plugin rather than through a Bun owner.

## Consequences

- An agent can draft or review a reply with any editor, offline, and
  `epicenter check <url>/contract.json ~/Epicenter/Messages` checks the folder.
  An agent sends only through `epicenter messages --json` with a version it
  read, under the same journal.
- A send costs one SQLite transaction with a full flush before Beeper is asked,
  one `accounts.list` per batch to check the profile, and one `retrieve` per
  accepted send until Beeper reports it settled.
- A crash between the claim and Beeper's answer costs a person's check: the
  owner cannot tell "never posted" from "posted, answer lost", and Beeper has
  no idempotency key to ask with.
- A `ready` note being sent still reads `status: ready` on disk; the journal,
  not the note, says it is in flight, and `replies` reports both. A person who
  syncs the folder to a second computer can send the same ready reply from
  each; the journal is per computer.
- Messages' OPFS contract (`drafts`, `attempts`) is no longer published, and
  `apps/messages/src/lib/drafts.ts` and `device.ts` are deleted.

## Considered alternatives

- **Tauri serves the page and calls the Bun program across origins.** This
  needs CORS and weakens the Host and Origin check that currently admits only
  the page served by the program itself.
- **Port the send owner to Rust.** This creates a second owner for folder and
  journal behavior instead of launching the existing one.
- **Use `epicenter-standalone` and its folder plugin.** That model gives the
  page its folder. Messages requires Bun to own the folder, journal, keychain,
  and sends together.

- **`sends/<attemptId>.md` notes in the folder.** Readable, but the folder file
  API has no fsync and no cross-process lock (ADR-0702), and an editor or sync
  could change a claim.
- **A `sending` status written into the reply note.** A second write that can
  fail or race the claim, and a status an agent could edit back to `ready`
  while the send is out.
- **Moving the note into the journal at claim.** Takes the text out of
  Markdown before Beeper confirms anything, so an uncertain send stops being a
  file a person can read.
- **Matching an uncertain send by text in the chat's history.** Fuzzy; the
  same text can be sent twice on purpose.
