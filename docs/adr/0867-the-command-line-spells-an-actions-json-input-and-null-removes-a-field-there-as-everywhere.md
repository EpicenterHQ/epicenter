# 0867. The command line spells an action's JSON input, and `null` removes a field there as everywhere

- **Status:** Proposed
- **Date:** 2026-11-10
- **Relates:** [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (the four verbs, MCP), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (a write is one commit), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (`serve` runs actions through the command line).

## Context

A collection's `set` merges as JSON Merge Patch (RFC 7396) does: a field not
given is kept, and a field given as `null` is removed
(`packages/app/src/collection.ts`). Every field's description says "null
removes it", and the command line prints it. But `epicenter vocab words set
你好 --reading null` stores the string `"null"`. The only removal is
`epicenter vocab words set --input '{"word":"你好","reading":null}'`, which
works only with `--input` first and is in no help. `epicenter vocab review 你好
great` answers `<grade>: must be equal to constant`. `epicenter vocab words set
你好` with no field answers as `get`. An action that returned but whose commit
failed exits 0.

Both reviewers of the command line (2026-11-10) kept the merge: replacing a
whole file undoes a `review` that lands while the phone's UI edits the notes,
and an agent changing one field over MCP would have to resend every other.

## Decision

**The command line is a spelling of the action's JSON input, and a flag's value
is read as its field's type.**

| Field | On the command line | JSON |
| --- | --- | --- |
| number | `--interval 3` | `3` |
| switch | `--done`, `--done=false` | `true`, `false` |
| list | `--tag a --tag b` | `["a", "b"]` |
| one of choices | `--grade good`; any other value is refused, naming `again, hard, good, easy` | `"good"` |
| a field that may be `null` (each field of a collection's `set`) | `--reading null` | `null`: the field is removed |
| text | `--reading "nǐ hǎo"` | `"nǐ hǎo"` |

The string `"null"` for a field that may be `null` is given with `--input`.
`--no-done` is refused with `to make it false: --done=false`.

**`--input <json|->` gives the whole input as one JSON object.** It goes
anywhere before `--`, reads standard input when given `-`, and takes no
positionals or field flags beside it. `epicenter serve` runs every MCP call
this way.

**One description per field serves every surface.** "null removes it" is true
on the command line and over MCP alike.

**`set` given no field and no body throws** (exit 1), since it changes
nothing. The collection's `set` refuses it, so the answer is the same over
MCP; the command line does not check it a second time.

**The exit code says what happened.**

| Code | Meaning |
| --- | --- |
| 0 | the action returned, and its writes are committed or there were none |
| 1 | the action threw, or an app did not sync |
| 2 | the action did not run: a usage error |
| 3 | the action returned, and its writes are not committed |

## Consequences

- Removing a field is the same act on every surface, and no flag or verb exists
  only for it.
- A field cannot be set to the text `null` with a flag.
- An agent that gets exit 3 knows the action ran and must not run it again; the
  answer under `--json` still carries what it returned and why the commit
  failed.

## Considered alternatives

- **`--unset <field>`.** A second concept beside RFC 7396's `null`, and a flag
  name a collection's field could collide with.
- **An `unset` verb beside `set`.** One more tool per collection for agents to
  choose among.
- **`set` replaces the whole file.** A save from a UI that loaded the file
  before a `review` writes the old schedule back; an agent changing one field
  must resend every other.
- **`set` requires a revision read by `get`.** It rejects saves that do not
  overlap and moves the merge into every UI. An optional `revision` input stays
  open for when overlapping edits prove frequent.
- **`--no-<switch>`.** A second spelling of false.
- **Exit 1 for an uncommitted write.** It reads as "the action threw", and an
  agent would retry an `add` that already ran.
