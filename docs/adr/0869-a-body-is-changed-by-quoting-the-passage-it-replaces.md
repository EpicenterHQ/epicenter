# 0869. A body is changed by quoting the passage it replaces

- **Status:** Proposed
- **Date:** 2026-11-10
- **Relates:** [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (a collection's actions, revised in place to give `edit` and to give a body only to a new file), [ADR-0867](0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md) (`null` removes a field), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (an app's verbs as its own), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (one write, one commit).

## Context

One file in an app is written by several hands: the phone UI, the web UI, an
agent over MCP, an agent on the computer with its own file tools, and the
author in an editor. Every write through an action holds the app's lock and
is one commit, so two writes never interleave inside a file. They can still
undo each other across a read.

`set` merges fields: it changes only the lines it is given and keeps the rest,
so a caller that sends only what changed cannot undo another caller's field.
The body had no such shape. A UI showed the body, the person changed it, and
the UI sent the whole body back with `set --body`. Anything written to the
body between that read and that write was lost without a word:

```txt
09:00  phone opens task a; its body is "Call the bank."
09:01  an agent appends "Ask about the fee." to a's body
09:02  phone saves "Call the bank before noon."   the agent's line is gone
```

## Decision

**A body is changed by quoting the passage it replaces.**

```txt
epicenter tasks edit a --old "Call the bank." --new "Call the bank before noon."
MCP     tasks_edit { "id": "a", "old": "Call the bank.", "new": "…" }
UI      call('edit', { id: 'a', old: loadedBody, new: draft })
```

- `old` must occur in the body exactly once. Absent, the edit is refused as
  `Changed` ("does not have that text; it may have changed since it was read,
  so get it again"); present more than once, it is refused with "quote more
  around it". Nothing is written either way.
- An empty `old` fills an empty body, and is refused as `Changed` once the
  body has text.
- The quoted text is the precondition, scoped to the passage. Two callers
  editing different passages both land; a caller quoting a passage someone
  changed is refused. This is the shape of Claude Code's Edit tool
  (`old_string`, `new_string`), so an agent already knows it.
- A UI that edits the whole body quotes the body it loaded. On `Changed` it
  gets the file again and either reapplies its change to the new body (Capture
  toggling a checkbox) or says the text was not saved and keeps it for the
  person to save over the other change on purpose (Tasks' "Keep mine", Vocab
  saving again).
  A view's client answers the case as an `ActionError` named `Changed`.

**`set` gives a body only to a file it makes.** `set --body` on a file that
already has a body is refused: "already has a body, which set does not
replace; change it with edit". A body read earlier can then never undo a later
one through `set`.

**Fields stay last-writer-wins, one field at a time.** Two `set`s of the same
field keep the later; a caller sends only the fields it changed, and `null`
for one emptied (ADR-0867). A form that changes fields and the body saves
twice: `set` for the fields, then `edit` for the body, as two commits.

A collection now gives `list`, `get`, `set`, `edit`, and `delete`; a
collection of one file gives `get`, `set`, and `edit`.

## Considered and not chosen

- **A revision on every file, checked by every write (`--if <rev>`).** Every
  caller would carry it, refresh it after each write, and be refused for a
  change to a field it never touched. The quoted passage protects exactly what
  the caller read.
- **`edit` over the whole file, front matter too, checked after.** Fields
  would be edited as text, losing the typed flags and the refusal before
  anything is written, and a field's line would be quoted against however
  the file happens to spell it.
- **A file API over MCP (read, write, edit any file of an app).** A second
  way to write beside the actions breaks the one-to-one map of the command
  line, MCP, and HTTP, and lets a remote caller write a file no collection
  declares.
- **Multi-hunk patches (Codex's `apply_patch`).** One span covers what the
  UIs and agents do; an agent changing three passages makes three edits.
  Revisit if agents keep needing several passages changed as one commit.
- **Validating and committing native file edits after the fact (a hook).**
  It can report a bad file but not refuse one, and it adds a process that
  watches the folder. An agent on the computer may still edit files with its
  own tools; `epicenter sync` commits what that leaves, outside these
  guarantees.

## Consequences

- No write through an action can undo a body change it did not read.
- An agent is told, in the Epicenter's `AGENTS.md`, to prefer
  `epicenter <app> <verb>` and to change a body with `edit`; it may use its
  own file tools, and then commits with `epicenter sync <app>`.
- A form save is two commits when both fields and body change.
- A stale `set` of the same field still wins. Optional expected values per
  field (`--if-title`) would close that; they wait for a case that needs them.
