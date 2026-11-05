# 0797. Front matter is a strict grammar, and anything else is body

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0796](0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md) at "Epicenter reads any YAML a person or another tool writes": it reads only the grammar below, and a file outside it is all body; [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) at a front matter that does not split into keys merging by Git's line merge: such a file has no front matter, and merges as body; [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at what the one `AGENTS.md` Epicenter writes says: it also states the grammar.
- **Relates:** [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (a note that does not read keeps its text), [ADR-0789](0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md) (the repair editor), [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) (one primitive in each language under one fixture).
- **Amended by:** [ADR-0798](0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md) at a field set normalizing first: the page normalizes, with a write, and no store normalizes.
- **Unbuilt:** all of it: the grammar's reader in TypeScript and Rust under one fixture; reading, writing, and merging through it in `@epicenter/definition`, `@epicenter/folder`, and the core; Normalize in the repair editor and `epicenter normalize`; `epicenter set` with JSON; the grammar in the `AGENTS.md` Epicenter writes; removing the YAML library from reading, writing, and merging (`packages/definition/src/note/canonical.ts`).

## Context

After ADR-0796 Epicenter writes each field as one line of JSON and patches
only the lines it changes, but it still read any YAML, so a YAML library, its
1.1 and 1.2 differences, and a second merge rule for headers that do not split
into keys stayed in both languages. Every program that reads front matter
needed all of it to cover headers that Epicenter never writes.

## Decision

**Front matter is a strict grammar: YAML restricted to `key: <JSON>`.** A file
has front matter when its first line is `---`, a later line is `---`, and
every line between them is a key, a colon and a space, and a JSON value, each
key once. JSON is YAML 1.2, so every YAML reader reads exactly the value
Epicenter means; a value that is not JSON, such as an unquoted string, puts
the file outside the grammar.

**A file outside the grammar is all body.** No opening fence, no closing
fence, or a line between them that is not `key: <JSON>` (a comment, an
indented YAML list, an unquoted string, a key written twice) means the file
has no front matter. Its note lacks its required fields, so it shows in
`invalid()` with its text and is fixed in the repair editor. A round merges
such a file as body, by Git's line merge.

**Epicenter normalizes another tool's YAML when it writes the note, or when a
person asks, never when it reads.** Normalize parses the header as YAML and
writes it in the grammar, and it applies only when that loses nothing: a
flat mapping whose values JSON can hold, read back equal. A field set on a
note outside the grammar normalizes it first when it can; when it cannot, it
keeps the text and adds the change beside it (ADR-0775). A person normalizes
from the repair editor, the library's list of what needs a look, or
`epicenter normalize`, each showing the change first (`--dry-run` writes
nothing). Nothing normalizes on a read, on a schedule, or in the background.
YAML is parsed only there, in TypeScript, and a page loads its parser only
when Normalize runs; the core never parses YAML.

**The body is the app's.** Epicenter reads nothing in it but conflict
markers, merges it by lines, and leaves its structure to the app.

**Every program edits the same way.**

| Operation | What changes in the file |
| --- | --- |
| read a field | nothing: the line `key:`, its value JSON |
| set a field | that line |
| add a field | one line before the closing fence |
| delete a field | that line goes |
| merge | front matter by key; body by lines; a file with no front matter by lines |

The `AGENTS.md` Epicenter writes says it in two lines: front matter is one
`key: JSON` per line; edit the body freely, and change a field by replacing
its line or with `epicenter set`.

## Consequences

- Reading front matter is splitting lines, identical in Rust and TypeScript,
  with no YAML library on the path of a read, a write, or a merge.
- ADR-0795's second merge rule for headers that do not split goes.
- A note another tool wrote in its own YAML, such as Obsidian's indented lists,
  stops reading in Epicenter until it is normalized, by a person or by the
  next write to it.
- A person typing a field by hand quotes its text, as JSON does.

## Considered alternatives

- **A value that is JSON or else the rest of the line as text:** friendlier to
  type, and some values (`yes`, a date) read differently in other YAML tools.
- **Normalizing a foreign header whenever Epicenter reads it:** no prompt, and
  Epicenter rewrites a file another tool wrote without being asked.
- **Reading any YAML (ADR-0796 as recorded):** another tool's notes keep
  reading, at the cost of a YAML library and a second merge rule in both
  languages.
