# Local Mail pending overlays: one mailbox database, one writer, offline triage and draft edits

**Date**: 2026-08-01
**Status**: In Progress
**Owner**: Braden
**Branch**: `claude/local-mail-sync-model`
**Decisions** (read these first; this spec plans them, it does not decide them): [ADR-0198](../docs/adr/0198-local-mail-stores-gmail-facts-and-durable-local-overlays-in-one-stable-file-per-account.md) (three tiers, one stable file), [ADR-0199](../docs/adr/0199-every-local-mail-write-is-a-local-intent-and-sync-is-the-only-provider-transition.md) (one writer, replay-then-refresh), [ADR-0200](../docs/adr/0200-an-offline-draft-edit-replaces-a-known-gmail-drafts-whole-mime-content.md) (draft edit is a whole MIME replacement)
**Standing constraints** (not reopened here): ADR-0196 (one `messages.get` per message, no attachment bytes), ADR-0116 (desktop-first, no background mail service), ADR-0082 (push-free polling), ADR-0098 (every human-actionable concept is Gmail-expressible)

## One Sentence

Local Mail's per-account SQLite file becomes a mailbox database of provider
facts plus durable local overlays plus derived indexes, every write becomes a
local intent, and `sync()` becomes the only thing that writes it or talks to
Gmail on its behalf.

## Current shape

```txt
click archive
  -> POST /api/accounts/:a/messages/modify
  -> Gmail messages.modify            (fails outright with no network)
  -> patchMessageLabels(...)          (writes the `messages` FACT table,
                                       outside the sync lock, silently
                                       swallowing failures)
  -> UI reconciles from TanStack's mutation cache
                                      (per tab, in memory, dies on reload)
```

Three concrete problems, all live:

1. **Two writers to the fact tables.** `sync.ts` writes under the per-account
   gate and the `lock.ts` sync-owner lock; `modify.ts`'s `patchMessageLabels`
   writes the same `messages` table from the HTTP route, the CLI, and MCP under
   neither. `MirrorWriteError.MirrorBusy` was written for two sync processes;
   the fold widened it to a triage click in the same process.
2. **The fold has a fact-tier side effect nobody asked for.** It stamps
   `synced_at` without moving the cursor, and `finishFullPull` sweeps
   `WHERE synced_at < ?`, so a fold shields a row from a sweep.
3. **Nothing survives the app.** Optimism lives in
   `apps/local-mail/ui/src/lib/optimistic.ts` reading TanStack's mutation cache. There is no
   offline triage and there are no drafts at all.

And the storage lifecycle is wrong for what is coming: ADR-0197's version bump
names a **new empty file** and refuses to carry the predecessor forward, so the
first durable local byte in `mail.v5.db` would be destroyable by a routine
release.

## Target shape

```txt
click archive
  -> POST /api/accounts/:a/messages/modify
  -> write ONE overlay row (desired state, keyed by message id + label id)
  -> return immediately, works offline, survives quit

read
  -> SELECT from a view composing facts + overlays
  -> every row carries `pending: boolean`

sync()          <- the ONLY writer, the ONLY Gmail caller
  1. replay pending overlays to Gmail
  2. refresh Gmail facts (history.list / full pull)
  3. retire overlays Gmail confirmed
```

One stable file per account: `<dataDir>/<accountEmail>/mail.db`. The corpus
version moves into `_meta` and governs the fact tier alone; a bump rebuilds fact
tables in place and never touches overlays.

## Overlay shapes

Two kinds, and only two in v1. Both are **desired end state keyed by the
provider's own stable identifier**, never an operation log.

| | key | value | replayed as | undo before sync |
|---|---|---|---|---|
| label override | (message id, label id) | present or absent | `messages.modify` / `trash` / `untrash` | delete the row (no network call at all) |
| draft replacement | Gmail draft id | complete base64url RFC 2822 MIME | `drafts.update` | delete the row |

Archive then undo before a pass is zero rows and zero calls. Two archives are
one row. Ten minutes of offline typing is one row and one `drafts.update`. This
is why no compaction, ordering, idempotency key, or version machinery appears
anywhere below.

## Implementation waves

Ordered so each wave leaves the app green and shippable. W0 is the prerequisite
deletion; W1 and W2 are structure with no behavior change; W3 and W4 are the
triage cutover; W5 and W6 are drafts.

### W0. Stable file (the deletion that unblocks everything)

- Stop importing `@epicenter/sqlite/bun-mirror` in `apps/local-mail`. Open
  `<accountDir>/mail.db` directly, applying the same concurrency pragmas the
  primitive applied (WAL, `busy_timeout`, `synchronous = NORMAL`,
  `foreign_keys = ON`) and the same `0600` / `0700` permissions.
- Delete `mailMirror`; move `MIRROR_VERSION` (`apps/local-mail/src/db.ts`) into `_meta` as the fact-tier
  corpus version.
- On open: if the stored corpus version differs from this build's, rebuild tier
  1 in place inside one transaction (drop fact tables, recreate from
  `MIRROR_TABLES`, clear `history_id` / `last_full_pull_at` / `last_synced_at`),
  then write the new version.
- Drop `predecessors` from `MailStatus` and from the status route.
- **Proof:** `apps/local-mail/src/db.test.ts` and `apps/local-mail/src/status.test.ts` green; `mirror: empty | building
  | ready` behaves unchanged; a test that writes a row, bumps the version, and
  asserts the fact table is empty and `_meta` carries the new version.
- **Note:** an existing install has `mail.v5.db` beside a pre-grammar `mail.db`.
  Neither is read after this wave; both are inert files a human removes. Say so
  in the app README rather than writing code to reach them.

### W1. Overlay tier and composed reads

- Add the two overlay tables from the table above, plus a `pending` marker
  column on nothing (it is derived, not stored).
- Add SQL views composing facts and overlays, and move `listMessages` and
  `getMessageDetail` onto them. `MessageSummary` and `MessageDetail` gain
  `pending: boolean`.
- Port the composition rule that currently lives in
  `apps/local-mail/ui/src/lib/optimistic.ts`'s `applyLabelDelta` and `rowMatchesLabelFilter`
  into the view.
- No writers yet, so with zero overlay rows the views are identity over the fact
  tables.
- **Proof:** every existing read test passes **unchanged** (that is the point of
  doing this before any writer exists), plus new tests that hand-insert overlay
  rows and assert composition, filtering, and the `pending` marker.

### W2. The handle collapse

- Introduce `openMailbox({ dataDir, accountEmail })`: a read surface, an intent
  surface (empty until W3), and `sync()`.
- Unexport `openMailDb`; stop `MailDb` crossing a module boundary; remove
  `syncDeps.db` from `AccountApi` so `apps/local-mail/src/http/api.ts` cannot reach the database.
- Keep the read-only handle the `query` verb needs, now pointed at the composed
  views so ad-hoc SQL agrees with the UI.
- **Proof:** `rg 'MailDb|openMailDb'` returns hits only in `db.ts` and its
  tests; typecheck green; `query` and `status` behave unchanged.

### W3. Triage writes become intents

- `POST /messages/modify` and `POST /messages/trash` write overlay rows and
  return. Same for the CLI verb and the MCP tool.
- `sync()` gains step 1 (replay) before its existing refresh, and step 3
  (retire confirmed overlays) after.
- Failure contract per ADR-0199: Gmail 400 or 404 marks the overlay failed and
  stops replaying it; anything else leaves it pending for the next pass. Reuse
  the existing `isPerIdError` boundary.
- Delete `patchMessageLabels`, `patchMessageLabelsRow`, and
  `tryFoldMessageLabels`. `foldMessageMutations` moves inside sync as the replay
  loop.
- **Proof:** `apps/local-mail/src/modify.test.ts` rewritten against overlay rows; a sync test that
  replays an override, confirms it in the same pass, and retires it; a test with
  a Gmail client that always fails, asserting the overlay survives and the
  cursor does not move; a test asserting a 404 marks failed rather than
  retrying.

### W4. UI collapse

- Delete `readPendingWrites`, `projectMessageList`, `rowMatchesLabelFilter`, and
  the pending-masking behavior in `reconcileAfterWrite`. Render the server's
  `pending` marker instead.
- Surface the two honest states the design creates: "not yet in Gmail" and
  "could not be applied, discard?".
- **Proof:** `apps/local-mail/ui/src/lib/optimistic.test.ts` shrinks to whatever composition rule did not
  move server-side (expected: nothing, so the file deletes). Live desktop smoke:
  archive with the network off, quit, relaunch, the row is still archived and
  still marked pending; restore the network, one pass clears the marker.

### W5. Drafts fact tier

- `drafts.list` and `drafts.get` ingestion in sync's fact refresh; a `drafts`
  fact table keyed by draft id; a drafts read model.
- **Proof:** a full pull materializes drafts; a `drafts.update` performed in
  Gmail's web UI shows up on the next pass.

### W6. Draft edit overlay

- The editor writes a whole-MIME replacement overlay keyed by draft id; sync
  replays it as one `drafts.update`.
- **Proof:** edit with the network off, quit, relaunch, the edit is still there
  and marked pending; restore the network, one pass lands it and Gmail's web UI
  shows the new body; a second offline edit before any pass produces one row and
  one call.

## What proves the whole change is done

1. `rg 'bun-mirror' apps/local-mail` is empty.
2. Exactly one function writes the mailbox file, and `rg` confirms no exported
   database handle outside `db.ts`.
3. Archive offline, quit, relaunch: still archived, marked pending. Reconnect:
   one pass, marker clears, Gmail agrees.
4. Edit an existing draft offline, quit, relaunch: edit intact, marked pending.
   Reconnect: Gmail's web UI shows it.
5. Bump the corpus version with a pending overlay on disk: the fact tables
   rebuild, the overlay survives.
6. `bun run check` green.

## Refusals and reopen triggers

Carried from the ADRs so an implementer does not have to re-derive them. None of
these is a roadmap slot; each takes a new ADR.

| Refused in v1 | Reopen trigger |
|---|---|
| Offline creation of a new Gmail draft | A product commitment to composing new mail with no network. Needs a local identity and a stated reconciliation rule after `drafts.create`. |
| Attachments in the draft-edit slice | ADR-0196's own reopen trigger: a stated promise that needs bytes offline, plus where they live and who reclaims them. |
| Queued send, and automatic retry of an ambiguous send | Nothing short of a mechanism that makes a lost send response unambiguous. A queued send is ADR-0098's refused send-later. |
| Background or closed-app delivery | ADR-0116's own trigger: an always-on device that can own timers. |
| Draft conflict detection across devices | Two devices editing one draft becoming a real complaint rather than a theoretical one. |
| Per-row retry counters and backoff | A second loop, or a variable interval, that makes "when do I give up" unanswerable from the per-id versus systemic split. |
| Cross-account storage | Nothing planned. Aggregate inboxes stay a UI composition over independent mailboxes. |
| A second writer, including a fast path for one verb | Nothing. This is the property the whole design buys. |

## Open, and deliberately not blocking

- **Immediate pass on write when the app is open and online.** Purely additive
  (ADR-0199 names it as deferred). Build it if the sync interval feels slow in
  the W4 smoke, not before.
- **Where a failed overlay is surfaced.** W4 needs *a* surface; whether it is a
  per-row affordance, a status-bar count, or both is a UI call to make while
  looking at the screen, not one to freeze here.
- **ADR numbering.** 0198, 0199, and 0200 are provisional per
  `docs/adr/README.md`. Branch `worktree-local-mail-sync-docs` carries a
  different, superseded ADR-0198 and `claude/adr-authority-materialization`
  carries an ADR-0193; whoever merges reconciles.
