# 0445. Vocab keeps chat on the device and syncs saved entries

- **Status:** Proposed
- **Date:** 2026-09-24
- **Relates:** [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) (finished turns), [ADR-0419](0419-stores-open-for-explicit-owners-and-compose-live-projections.md) (explicit Local and Personal owners), [ADR-0444](0444-chat-stores-finished-messages-as-rows.md) (message rows)

## Context

Vocab opens a Local store and an account-backed Personal store. Its conversation
and message rows previously lived in Personal with the saved vocabulary entries.
Practice takes a snapshot of selected entry text and puts that text in the first
turn of a new conversation. It writes no practice result back to the entries and
keeps no reference to their row ids. The transcript is session history, while
the curated entries are the work a learner expects to have on another device.

## Decision

The Local declaration owns `conversations`, `messages`, and the `showReadings`
setting. The Personal declaration owns `entries`. Both use Vocab's namespace in
their separate owner partitions. Vocab binds the chat controller to Local and
the entry state to Personal. Conversation metadata and finished messages remain
in the same local document; deleting a conversation deletes its message rows in
one local transaction. A conversation records an account key made from the
authority and principal ids, and the controller shows only conversations for
the signed-in account. This is UI separation inside one app-wide Local store,
not a separate encrypted device partition per account.

This is a clean break. Existing Personal chat rows are not copied into Local.
Sign-in still gates Vocab because the tutor uses account-backed hosted inference.

## Consequences

A conversation survives a reload on its device but does not appear on another
device. Saved entries still sync. Practice copies entry text into the local
opening turn, so later edits to the entry do not rewrite an earlier transcript.
Saving a useful word or phrase from a reply remains an explicit entry action.

The two declarations prevent new chat writes from entering the account store.
Old Personal chat data may remain in existing stored documents; this change does
not purge or migrate it.

## Verification

Vocab's typecheck proves the chat controller receives Local table handles and
entry state receives a Personal table handle. The store-contract test checks the
declarations' table ownership.
