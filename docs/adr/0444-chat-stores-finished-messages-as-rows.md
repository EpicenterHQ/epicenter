# 0444. Chat stores finished messages as rows

- **Status:** Proposed
- **Date:** 2026-09-24
- **Relates:** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the client loop persists finished messages), [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (one store document)

## Context

The conversation body held an attribute for each finished message. That was
the only production body whose file format needed keyed attribute
reconciliation and expected JSON parse failures. A conversation still needs
metadata and a list of finished messages, but those messages are independent
records rather than rich text bound to an editor.

## Decision

`conversations` holds its account key, title, model, and timestamps. `messages` holds one row
per finished message with a conversation id, message id, and complete JSON
message value. The agent loop still receives its `AgentMessageStore` interface;
the adapter reads and writes message rows. The loop orders them by the message's
`createdAt`. Deleting a conversation deletes its message rows in one store
transaction. If concurrent replicas mint rows for the same message id, the
adapter presents one keyed message by choosing the row with the smaller id.
Both rows remain stored.

This is a clean break for existing keyed body messages. Vocab does not read or
move them into rows. The old body codec is removed; a remaining populated
legacy body refuses file export rather than being silently omitted. Existing
conversation metadata may remain visible with no messages in the new table.

## Consequences

Chat no longer broadens the body file codec around attribute maps. Messages
become individual artifact files with ordinary frontmatter fields. A message
row's JSON field is one LWW value, as the old keyed attribute was. The adapter
may read more rows than the active conversation needs when a message arrives;
this keeps the interface synchronous and uses the existing table subscription.

## Considered alternatives

Keeping the old body map would retain its custom file codec and make the body
format serve two unrelated storage shapes. Giving message rows chosen IDs
would collide with the table invariant that only the store mints row IDs.

## Verification

Chat tests cover persisted message rows and duplicate presentation. App Shell
tests cover opening turns and deletion of linked message rows.
