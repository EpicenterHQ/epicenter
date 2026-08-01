# 0200. An offline draft edit replaces a known Gmail draft's whole MIME content

- **Status:** Accepted
- **Date:** 2026-08-01
- **Relates:** [ADR-0198](0198-local-mail-stores-gmail-facts-and-durable-local-overlays-in-one-stable-file-per-account.md) (the overlay tier this row lives in), [ADR-0199](0199-every-local-mail-write-is-a-local-intent-and-sync-is-the-only-provider-transition.md) (who replays it, and why send is not an overlay), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (drafts are expressible in the Gmail API, which is what makes this allowed at all), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) (no attachment bytes on disk, which is why the first slice has no attachments)

## Context

Local Mail is gaining a durable local overlay tier (ADR-0198), and the first
non-triage thing a user wants to do with no network is finish an email they
already started. That requires deciding what a "pending draft edit" actually is:
a patch, an edit log, or a replacement.

Gmail decides it, and the answer is unambiguous. Verified against the official
Gmail API reference and drafts guide on 2026-08-01:

- The Draft resource's `id` is "The immutable ID of the draft."
- "the `drafts` resource is a container that provides a stable ID because the
  underlying message IDs change every time the message is replaced."
- "Because messages cannot be updated, the message contained in the draft is
  destroyed and replaced by the new MIME message supplied in the update
  request."
- `message.raw` must carry "the RFC 2822 formatted MIME message, encoded as
  base64URL."
- "When the draft is sent, the draft is automatically deleted and a new message
  with an updated ID is created with the `SENT` system label."

Gmail offers no partial draft update. An edit already *is* a whole replacement
on the provider's side.

## Decision

**A pending draft edit is one complete MIME replacement of an existing Gmail
draft, keyed by that draft's immutable draft id. Local Mail stores at most one
pending replacement per draft id; a later edit overwrites it. `sync()` replays it
as a single `drafts.update`.**

- **Keyed by draft id, never message id.** The message under a draft changes on
  every update and again on send, so keying on it would break on the provider's
  own ordinary behavior.
- **One row per draft id, overwritten in place.** Not an edit log. Typing for
  ten minutes with no network produces one row and, later, one `drafts.update`.
- **The stored value is the complete base64url RFC 2822 MIME** that the update
  would send. Not a diff, not a field set, not a body fragment.
- **Last local write wins locally, and wins at Gmail on replay**, because that
  is precisely what `drafts.update` does. There is no merge, because Gmail
  offers none to merge into.

This is the whole reason no versioning, patching, three-way-merge, or
predecessor machinery appears anywhere in this design: the overlay's shape is
the provider's own update shape.

### V1 refusals

- **No offline creation of a new Gmail draft.** A draft that does not exist in
  Gmail has no id to key on, so offline creation means minting a local identity
  and reconciling it after a later `drafts.create`. That is an entire
  identity-reconciliation family bought for one convenience. In v1 a draft is
  created online and edited offline.
- **No attachments in the first draft-edit slice.** Building the MIME requires
  the bytes, and ADR-0196 refuses attachment bytes on disk in any form. It is
  the same refusal, not a new one.
- **No queued send.** ADR-0199 owns this. Sending is online-only and immediate.
- **No conflict detection against a draft edited elsewhere.** If the same draft
  is edited on the phone and this pass then replays, the local replacement wins,
  because that is what `drafts.update` does. Named here so it is a known
  property rather than a discovered one.

### Reopen triggers

Each takes a new ADR, and none of them is a roadmap slot:

- **Offline draft creation**, if the product commits to composing new mail with
  no network. It needs a local identity and a stated reconciliation rule.
- **Attachments**, which is ADR-0196's own reopen trigger with a byte store
  attached, and inherits that record's requirement to name where bytes live, who
  reclaims them, and what a rebuild then costs.
- **Draft conflict handling**, if two devices editing one draft turns out to be
  a real complaint rather than a theoretical one.

## Consequences

- **The draft editor becomes fully local.** Keystrokes write the overlay; reads
  compose it over the Gmail draft fact, and the editor shows the draft as not
  yet in Gmail until a pass confirms it.
- **A drafts fact tier has to exist.** `drafts.list` and `drafts.get` become
  part of sync's fact refresh, priced by ADR-0196's per-message budget like any
  other message fetch.
- **A replayed `drafts.update` is visible churn in the fact tier.** The draft's
  underlying message is destroyed and replaced, so the next `history.list` pass
  reports a delete and an add for that message. That is idempotent under the
  existing fold, but it is the reason the read model must key drafts by draft
  id and never by the message currently under one.
- **The user can edit and triage with no network, and cannot compose new mail or
  send.** That boundary must be stated in the UI, not discovered by a user who
  typed a new message on a plane and lost it.
- **Sending remains a hard edge.** Because send deletes the draft and mints a new
  `SENT` message, a send that succeeds while its response is lost is
  indistinguishable at the client from one that never happened. ADR-0199 refuses
  to retry it automatically for exactly this reason, and this record is where
  the provider behavior that makes it ambiguous is written down.

## Considered alternatives

- **Store a field-level patch (subject, body, recipients) instead of whole
  MIME.** Rejected: `drafts.update` takes whole MIME, so a patch has to be
  rendered into whole MIME at replay time anyway, and that rendering needs the
  base it is patching. That base is a fact row that sync may have refreshed
  since, which invents a merge Gmail does not have.
- **Store an append-only edit log per draft.** Rejected: it needs compaction and
  ordering to answer the only question ever asked of it ("what should the draft
  say now"), which one overwritten row answers directly.
- **Key the overlay on the draft's current message id.** Rejected as incorrect
  on the provider's documented behavior: the message id changes on every update
  and on send, so the key would break on the first successful replay.
- **Send the update immediately when online and only overlay when offline.**
  Rejected by ADR-0199's single-writer rule, and separately here because two
  code paths for one edit disagree exactly when the network is flaky, which is
  when the feature matters.
- **Refuse offline draft editing and keep drafts read-only in v1.** Rejected:
  reading a draft you cannot finish is a worse surface than not showing drafts
  at all, and the overlay tier that makes it work is already being built for
  triage.
