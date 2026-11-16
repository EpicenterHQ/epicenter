# 0924. Front matter is `key: <JSON>` lines, each read on its own, and no YAML is read

- **Status:** Proposed
- **Date:** 2026-11-15
- **Relates:** [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md), the retired product's record of the same grammar; [ADR-0918](0918-a-collection-selects-a-record-by-its-keys-and-a-file-that-is-not-there-reads-as-absent.md) (front matter that cannot be read); [ADR-0923](0923-a-read-gives-only-what-the-file-holds-and-no-field-has-a-default.md) (a value that does not fit).
- **Unbuilt:** all of it. `split` in `packages/app/src/front-matter.ts` gives up on a block at its first line that is not `key: <JSON>`, `readMarkdown` then reads the block with `Bun.YAML`, and `withFields` rewrites such a block whole.

## Context

A file's front matter belongs to the app and to agents: they write it, and a
person reads it. The body is the person's text. The app already writes each
field as one `key: <JSON>` line and, in a block made only of such lines,
replaces only the lines of the keys a write names.

A block with any other line is read as YAML, and the first write that changes
a field rewrites the whole block. That rewrite changes values no caller
named. Observed on 2026-11-15:

| The file held | After a write to another key |
| --- | --- |
| `id: 12345678901234567890` | `id: 12345678901234567000` |
| `version: 1.10` | `version: 1.1` |
| `zip: 01234` | `zip: 1234` |
| a comment line | gone |

Reading YAML without rewriting it also gives the app values the file does not
hold: `n: 007` reads as `7`, and `title: 1984` reads as a number.

Counts taken on 2026-11-15, without reading any value:

- The apps' collections hold 554 front matter lines in 111 files. Every line
  is `key: <JSON>`.
- One large folder that will adopt collections has 3,329 pages with front
  matter. None is made only of `key: <JSON>` lines: 7,707 lines hold a bare
  value, and 12,634 lines in 2,461 files are not `key: value` at all.
- That folder holds no notes tool's settings, and its owner treats its front
  matter as written by agents and scripts.

## Decision

**The app writes `key: <JSON>` lines, and a write replaces only the lines of the keys it names.**

Every other line stays as it is, byte for byte, including a key no field
declares.

**Each line is read on its own, and no YAML is read.**

| A line | Reads as |
| --- | --- |
| `key: <text>`, and the text is JSON | that key's value |
| `key: <text>`, and the text is not JSON | that key is absent, with a problem that gives the line number and the JSON to write |
| anything else, or a key a second time | the front matter cannot be read ([ADR-0918](0918-a-collection-selects-a-record-by-its-keys-and-a-file-that-is-not-there-reads-as-absent.md)) |

A line whose text is not JSON is kept until a write names its key. Plain data
given for that key replaces the line, which is how it is repaired. A change
computed by a function may not write it
([ADR-0923](0923-a-read-gives-only-what-the-file-holds-and-no-field-has-a-default.md)).

**A folder of YAML is converted once, by a script in that folder's own code, before it adopts collections.**

The script is not part of the command. It works line by line, directed by
each declared field, and never takes a value from a YAML parse. It refuses
and lists any block with a comment or a value it cannot carry, reads every
file back and compares, and lands as one named commit.

## Consequences

- A person who types `due: 2026-11-20` by hand loses nothing. `due` reads as
  absent, `epicenter check` lists the line with the fix, and every other key
  in the file reads and writes as before.
- `title: 1984` reads as the number, which does not fit a text field, so it
  is reported, not guessed.
- A tool that saves the whole block as YAML makes the record unreadable until
  its lines are fixed. No such tool is used on these folders today. If one is
  adopted, this record is decided again.
- A number written with more digits than a JSON reader keeps, such as
  `12345678901234567890` or `1.10`, still reads as the nearer number. Its
  line changes only when a write names that key.
- The `Bun.YAML` branch of `readMarkdown` and the whole-block rewrite in
  `withFields` are deleted. `split` stops giving up at the first line that is
  not JSON.
- A row of objects on one line, such as a page's `posts`, is hard to read in
  a diff. Rows like that belong in the body or in their own collection.

## Considered alternatives

- **Read YAML, and replace only the lines of the keys a write changes.** The
  earlier draft of this record. Hand-written YAML keeps working, and files
  become a mix of both. It needs a YAML reader, a finder for each key's
  lines, and refusals for anchors and aliases, and a read still gives values
  the file does not hold.
- **Rewrite the block whole.** It changed values, as observed above.
- **Read a block list under its key as that key's problem.** It would keep a
  record readable after a tool rewrote it as YAML. It needs the same finder
  for a key's lines, for a tool nobody uses here.
- **Make the conversion a command.** One folder needs it once.
