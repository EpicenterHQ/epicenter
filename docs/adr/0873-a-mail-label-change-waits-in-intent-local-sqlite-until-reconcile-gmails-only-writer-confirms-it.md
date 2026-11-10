# 0873. A Mail label change waits in intent.local.sqlite until reconcile, Gmail's only writer, confirms it

- **Status:** Proposed
- **Date:** 2026-11-11
- **Relates:** [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) for Mail: `label` changes only this computer's intent and `reconcile` is the one verb that changes Gmail; saved searches return as `views/{name}.md`.
- **Unbuilt:** a Gmail adapter that reads `google.local.md` and calls Gmail over the network; `openFixtureGmail` in `apps/mail/lib/gmail.ts` is the only adapter.
- **Relates:** [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) and [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) (the assertion and its one writer), [ADR-0319](0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md) (storage split by lifetime), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (what a path becomes), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (who commits).

## Context

ADR-0859 left Mail with `connect`, `search`, `show`, `archive`, `trash`, and `label`, each verb that changes Gmail calling it directly and safe to repeat, and deleted saved queries in `queries/`. None of it was built. The deleted Local Mail had already settled what a direct call loses: ADR-0198 and ADR-0199 moved a label change from a Gmail call on the request path to a durable assertion that one reconciler delivers, because a call that fails offline is forgotten and every surface that calls Gmail is another writer.

`apps/mail` brings that split into an `epicenter.ts`, over a synthetic mailbox, so its storage and ownership can be tested with no Google account. Each call runs in its own process (ADR-0850), so nothing survives between calls in memory: every state is a file the next process opens again.

## Decision

**Mail keeps four things in four places, chosen by ADR-0858's questions.**

```txt
~/Epicenter/mail/
├── epicenter.ts                 the actions; lib/ holds the store, query, reconcile, and adapter
├── views/<name>.md              saved searches: query, title             tracked, a commit per call
├── .cache/mirror.sqlite         messages, message_labels, labels,
│                                meta(cursor, refreshedAt)                ignored, rebuilt by refresh
├── intent.local.sqlite          label_intents(message_id, label_id, want,
│                                seq, asserted_at), meta(seq)             ignored, never rebuilt
└── fixture-gmail.local.sqlite   the synthetic Gmail: messages, labels,
                                 history id, seeded from lib/fixture.ts   ignored, the provider's state
```

**The mirror is a copy, rebuilt and never migrated.** `refresh` reads the whole mailbox (`getProfile`, `listLabels`, `listMessages`) and replaces every mirror row in one transaction, storing the provider's history id as `cursor`. `PRAGMA user_version` holds `MIRROR_VERSION`; a file with another nonzero version is unlinked and recreated, then `refresh` pulls the mailbox again (ADR-0319). Deleting `.cache/` costs one `refresh`.

**A label change is one row in `intent.local.sqlite`.** `epicenter mail label <ids> --add <label> --remove <label>` resolves each label when it runs: Gmail's system ids (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `TRASH`, `SPAM`, `CATEGORY_PERSONAL`, `CATEGORY_SOCIAL`, `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`) resolve to themselves, a custom label resolves by id or name against the mirror, and an unknown name is refused with nothing written. It writes one row per message and label, ADR-0198's partial map: a new `seq` on every assertion, and no attempt count or error column. It does not call Gmail.

**Every read shows pending intent over the mirror.** `search`, `show`, and `labels` read the mirror with `intent.local.sqlite` attached, through the temporary view `effective_labels`: the mirror's labels without pairs asserted `want = 0`, with pairs asserted `want = 1`. Filters and counts use it; messages stay ordered by date, and each message row lists its `pending` assertions. `status` reports mirror freshness and the pending count.

**`reconcile` is the only writer to Gmail.** `modifyMessage` in `lib/gmail.ts` is the only call that changes the provider, and `reconcilePass` in `lib/reconcile.ts` is its only caller. A pass delivers, then pulls (ADR-0199). It sends one `modifyMessage` per message with the label ids to add and remove, folds the response's labels into the mirror, then deletes the rows it carried by `(message_id, label_id, seq)`, so a pair asserted again during the call stays. A 400 or 404 discards that message's rows and lists them under `discarded`. Any other failure stops delivery, leaves every undelivered row as it was, and the action throws `Delivery stopped: <reason>`. Two passes at once send the same change twice, which changes nothing the second time, and each deletes only the rows it carried; no lock is held.

**The synthetic Gmail is `fixture-gmail.local.sqlite`.** `openFixtureGmail` seeds it from `lib/fixture.ts` on first open: 24 messages from fictional senders at `example.com`, `example.org`, and `example.net`, with no account and no token. It then changes only through `modifyMessage`. Its `.local` name keeps it out of every commit, and it survives each call's process, a restart of `epicenter serve`, and deleting `.cache/`. Deleting it resets the synthetic mailbox to the seed.

**Saved views are the person's Markdown.** `views/{name}.md` is a collection with `query` and an optional `title`, its notes in the body. `mail views add`, `set`, `edit`, and `delete` are the collection's verbs, each committed as its call (ADR-0850). `epicenter mail search --view <name>` runs the view's query, narrowed by `--query`.

**Only a view's verbs commit.** `refresh`, `label`, and `reconcile` write SQLite through `bun:sqlite`, never through `folder`, so the runner records no paths and makes no commit, and the app's `.gitignore` ignores every file they write.

## Consequences

- A label change is one SQLite transaction and shows at once in every search, from the command line, MCP, and the UI alike. It reaches Gmail when `reconcile` runs, and nothing runs it on a clock: a person, an agent, or the UI's "Send changes" button does.
- Pending intent survives a crash, a restart, and a deleted `.cache/`. It is lost with the computer, as an unsent draft is, and another clone of the app has none.
- Each `refresh` reads every message, 24 in the fixture. A real mailbox needs ADR-0370's maintenance through history from the stored `cursor`.
- The UI keeps nothing of its own. It calls `mail_search`, `mail_label`, and `mail_reconcile`, and shows a row's `pending` as "waiting to send".
- A real Gmail adapter replaces `lib/gmail.ts` alone; `refresh` and `reconcile` stay its only callers. Real Gmail delivers `TRASH` through `messages.trash` (ADR-0199), where the synthetic adapter takes it through `modifyMessage`.
- Undelivered intent has no discard verb yet. ADR-0199's whole-ledger discard behind `--all` is its shape when one is needed.

## Considered alternatives

- **`label` calls Gmail directly (ADR-0859).** A failed call leaves nothing to retry, reads show the old label until the next refresh, and every surface is a Gmail writer.
- **Intent rows in `.cache/mirror.sqlite`.** Deleting the cache or changing `MIRROR_VERSION` would drop undelivered changes.
- **Intent as tracked Markdown.** Every label click would be a commit, and pending changes naming other people's mail would travel to `origin`.
- **The synthetic mailbox in `.cache/`.** Deleting the cache would undo delivered changes, so a rebuilt mirror could not show that a delivery landed.
- **A fixture server process.** A second program to start; a file the adapter opens is already shared by every process.
