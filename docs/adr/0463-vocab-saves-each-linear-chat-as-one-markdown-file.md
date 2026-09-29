# 0463. Vocab saves each linear chat as one Markdown file

- **Status:** Proposed
- **Date:** 2026-09-29
- **Amends:** [ADR-0444](0444-vocab-stores-finished-chat-messages-as-local-rows.md) at per-message Local rows; [ADR-0445](0445-vocab-saves-local-chats-and-syncs-saved-entries.md) at device-only history; [ADR-0452](0452-vocab-chats-persist-chosen-expressions-before-the-tutor-speaks.md) at the Local chat row and message table. Their save timing and fixed-focus behavior remain.
- **Unbuilt:** file-backed Vocab chats, preservation and migration of existing device histories, and account synchronization.

## Context

Vocab currently saves a chat's focus in one device-local row and each finished message in another. Saved expressions follow the account, but conversations do not. This lets a learner retry a failed tutor opening or answer on the same device. It does not let them continue the conversation on another device or read it as a current file outside Vocab.

Vocab's current tutor uses text messages. A chat starts with one to three chosen expressions, may begin with a tutor turn, and may end with an unanswered learner turn. Its message IDs and timestamps serve the current row store and rendering; no Vocab feature links to an individual saved message. The agent loop also supports tools in other products, but Vocab does not pass it a tool catalog.

## Decision

**Each saved Vocab chat is one Markdown row file containing one linear conversation.** The file path supplies the chat identity. Its frontmatter contains the fixed focus snapshot, `createdAt`, and `updatedAt`. The body contains completed turns in their conversation order. The focus is model context, not a hidden turn. A chat file exists before the tutor opening starts; a failed opening leaves an empty body that can be retried.

An account's Vocab data folder holds these files at `chats/<chat-id>.md`. Copying one file to a new path creates another chat. The account folder supplies account isolation; the file does not repeat an account key or chat ID in frontmatter.

```md
---
format: vocab-chat/1
createdAt: 2026-09-29T10:00:00Z
updatedAt: 2026-09-29T10:04:00Z
focus:
  - entryId: w123
    text: serendipity
---

# Tutor

Have you found something useful by accident?

# Learner

Yes, I found a book while looking for another one.
```

An exact, unindented line `# Tutor` or `# Learner` starts a turn. The following text belongs to that turn until the next marker or the end of the file. The file codec treats these lines as a transcript grammar, independently of Markdown rendering and code-fence state. When message text itself contains a marker line, the codec prefixes one backslash on write and removes one on read. It also prefixes an existing backslash run before such a line, so decoding preserves the original text. The app preserves uninterpretable source and refuses a typed append until it can read the chat safely. It does not repair or normalize a file merely by opening it.

The app writes blank lines around headings for readability. Those blank lines are framing, not separate messages. If an outside editor changes separator spacing, the codec still reads recognizable headings; a change at the edge of a message may change that message's whitespace. The app preserves the edited source until the person or app makes another explicit edit.

The file's order is the turn order. Per-turn IDs and timestamps are not part of this Vocab file format. The Vocab adapter may supply temporary IDs and ordering values required by the current agent loop, but those values are not historical facts or cross-file references. `updatedAt` retains chat-list recency in a complete copy; an outside writer that adds a turn without updating it leaves the chat readable but may leave it in its old list position.

Vocab saves the learner's submitted turn before generation and appends a tutor turn only after a clean finish. Drafts and partial responses remain transient. A finished answer appends to the current readable chat file through a conditional write. If the file changed during generation, the answer may follow text the tutor did not see. The app retries a failed conditional write against the newer file rather than creating another chat.

**A Vocab chat is an editable document under the data folder's ordinary file merge policy.** A clean text merge may combine an earlier edit with a later answer generated before that edit. When overlapping changes produce conflict markers, Vocab preserves the raw file and refuses typed continuation until the markers are repaired. Sync does not mint a second chat ID or give chats a separate merge rule.

This format is specific to Vocab's text tutor. It does not establish one transcript format for Epicenter's tool-bearing agent conversations.

## Consequences

- Copying a chat file creates an independent conversation without rewriting embedded message IDs. A learner or agent can revise the copy and continue it while retaining the original.
- Vocab needs a source-preserving file codec and conditional file writes. The field-notebook demo currently refuses divergent Git histories, so it does not yet implement ordinary file merging.
- A merged chat does not prove that a tutor answer was generated from every preceding turn in the current file. A marker-bearing file is saved data but cannot supply a typed prompt until repaired.
- Deleting a chat file on one device beats a concurrent append on another when those Git histories merge. The appended turn remains in retained Git history but not in the current data folder.
- Migrating existing device chats must retain each chat's focus, text, role order, and unanswered learner turn, including legacy chats without a focus row. The old storage remains available until migration is verified. The account transition must address histories under the old web origin before changing Vocab's URL.
- Raw files need a documented reserved-heading escape. Outside writers can edit prose freely, but an exact turn heading they add or remove changes the parsed conversation.
- Chat-list recency is saved at chat level rather than reconstructed from per-message timestamps. Existing per-message IDs and timestamps are not preserved as portable transcript fields.

## Considered alternatives

- Keep one file per message. Independent files reduce path collisions, but reconstructing a coherent chat still needs ancestry and branch selection. Reading or copying a conversation also requires gathering many files.
- Store JSON or JSONL messages and render Markdown as an export. Structured boundaries become easier, while multiline tutor answers become harder to read and edit in the saved source.
- Use comment-only turn markers. Markdown previews hide the speaker labels.
- Add IDs and times to every speaker heading. No current Vocab feature needs durable turn identity; requiring outside writers to mint it makes direct append harder. Add stable turn anchors if a real cross-app reference requires them.
- Fork a chat whenever source changes during generation or synchronization. This would preserve each answer's original prompt context but would make Vocab interpret a document differently from other Markdown rows and require new chat IDs during sync.
