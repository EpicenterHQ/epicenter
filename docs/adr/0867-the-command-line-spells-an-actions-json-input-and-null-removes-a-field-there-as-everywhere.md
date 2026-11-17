# 0867. `null` removes a field on every surface, and the exit code says what happened

- **Status:** Proposed
- **Date:** 2026-11-10
- **Amended:** 2026-11-11, with ADR-0850: a run never commits, so exit 3 is gone; a snapshot that fails after an action returned leaves the answer and exit 0, and the app's status says why.
- **Amended:** 2026-11-15, by [ADR-0925](0925-an-actions-input-on-the-command-line-is-one-json-object.md): the command line gives an action's input as one JSON object. The flag spelling this record first described, and `--input`, are gone; its rule that `null` removes a field stands.
- **Relates:** [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (the four verbs, MCP), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (snapshots), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (`serve` runs actions through the command line).

## Context

A collection's `set` merges as JSON Merge Patch (RFC 7396) does: a field not
given is kept, and a field given as `null` is removed
(`packages/app/src/collection.ts`). Every field's description says "null
removes it", and the command line prints it. But on 2026-11-10 the command
line stored the string `"null"` for `--reading null`, and removed a field
only through a whole JSON object given in a separate option that no help
mentioned. `epicenter vocab words set` with a key and no field answered as
`get`. An action that returned but whose commit failed exited 0.

Both reviewers of the command line (2026-11-10) kept the merge: replacing a
whole file undoes a `review` that lands while the phone's UI edits the notes,
and an agent changing one field over MCP would have to resend every other.

## Decision

**`null` removes a field that may be absent, on every surface.** A
collection's `set` takes the fields to change; `null` for one removes it. The
command line gives the same JSON object a page and an agent give (ADR-0925),
so `epicenter vocab words set '{"word":"你好","reading":null}'` removes
`reading`, and the text `"null"` is stored as that text.

**One description per field serves every surface.** "null removes it" is true
on the command line and over MCP alike.

**`set` given no field and no body throws** (exit 1), since it changes
nothing. The collection's `set` refuses it, so the answer is the same over
MCP; the command line does not check it a second time.

**The exit code says what happened.**

| Code | Meaning |
| --- | --- |
| 0 | the action returned |
| 1 | the action threw, or an app did not sync |
| 2 | the action did not run: a usage error |

## Consequences

- Removing a field is the same act on every surface, and no option or verb
  exists only for it.
- An agent that gets exit 0 knows the action ran and must not run it again,
  whatever became of the snapshot after it; `epicenter <app>` says when one
  failed (ADR-0850).

## Considered alternatives

- **`--unset <field>`.** A second concept beside RFC 7396's `null`, and an
  option name a collection's field could collide with.
- **An `unset` verb beside `set`.** One more tool per collection for agents to
  choose among.
- **`set` replaces the whole file.** A save from a UI that loaded the file
  before a `review` writes the old schedule back; an agent changing one field
  must resend every other.
- **`set` requires a revision read by `get`.** It rejects saves that do not
  overlap and moves the merge into every UI. An optional `revision` input stays
  open for when overlapping edits prove frequent.
- **A flag for each field, with the word `null` read as `null` where a field
  takes it (this record until 2026-11-15).** A second input language beside
  JSON; ADR-0925 replaces it.
- **Exit 1 for an uncommitted write.** It reads as "the action threw", and an
  agent would retry an `add` that already ran.
- **Exit 3 for an action that returned but whose commit failed (this record
  until 2026-11-11).** A run no longer commits, so there is no commit of its
  own to fail.
