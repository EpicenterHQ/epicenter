# Capture file model

A capture is one Markdown file, `captures/<stem>.md`, in a folder opened with
`@epicenter/folder`. The file's bytes are the saved data. There is no Yjs
document, no thought rows, and no IDs for thoughts.

`captureDefinition` is declared with `defineFolder` from `@epicenter/folder`
and the `defineTable` and `field` vocabulary of `@epicenter/definition`. This
package opens nothing and names no folder; an application passes the
definition and the folder's ID to an opener.

```markdown
---
capturedAt: 2026-10-01T10:30:00+08:00
---

The original capture text.

## Thoughts

- First thought.
- Another thought.
  It can continue across multiple lines.
```

`captureDefinition` declares the one table, `captures`, with one field:
`capturedAt`, an RFC 3339 datetime. A UTC time and a time with an offset are
both valid, so order captures by the parsed instant, never by the string.
Unknown frontmatter keys are kept.

## Reading a capture

The captures table reads a file as a row: its `fields` and its Markdown
`body`. `captureBody.decode(row.body)` reads the body as the capture text and
its ordered thoughts. markdown-it decides what the blocks are and which lines each owns;
this package maps those ranges to offsets in the source.

| Part | Rule |
| --- | --- |
| Capture text | Everything in the body before the one root-level `## Thoughts` heading, less one blank separator line on each side. With no such heading, the whole body. |
| Thoughts | The items of the one bullet list directly under that heading. An item owns what Markdown gives it: continuation lines, later paragraphs, nested lists, code. |
| Everything else | Blocks after that list, and everything from the next root-level heading on, are kept and never read as thoughts. `hasOtherContent` says they exist. |

A line reading `## Thoughts` inside a code fence, an HTML block, a block
quote, or a list item is not the heading.

A body is refused, with the refusal saying why, when its layout is
ambiguous. Its text and thoughts are then not offered, and the file stays
editable as text. A file whose frontmatter does not parse, or whose
`capturedAt` is not valid, is not a row at all: the table reports it as
`InvalidRow` with its issues, and `parseRow(captureDefinition.tables.captures,
text)` reads typed text the same way.

| `refusal.code` | Cause |
| --- | --- |
| `duplicate-heading` | More than one root-level heading reads "Thoughts". |
| `heading-form` | The Thoughts heading is not `## Thoughts` at the start of a line. |
| `section-shape` | Something other than a bullet list comes first under the heading, or the section holds a second bullet list. |

## Changing a capture

An app holds the open row and saves it; this package owns only the body.
Decode the row's body, compose the complete desired value, encode it over the
current body, and save the row with that body. The folder formats the
frontmatter and keeps keys Capture does not declare.

```text
row.body -> decode -> { text, thoughts }
                        | compose the desired value
row.body <- encode(desired, row.body)
```

Both codec operations return Wellcrafted Results. Decoding reports ambiguous
Thoughts layouts. Encoding verifies that the body reads back as the intended
text and thoughts before returning anything to save.

Thoughts are `string[]`, selected by position. Callers compose a complete value:

```ts
const current = expectOk(captureBody.decode(body));

// Edit the capture text.
captureBody.encode({ ...current, text: input }, body);

// Edit the thought at the selected position.
captureBody.encode({
  text: current.text,
  thoughts: current.thoughts.map((text, i) => i === index ? input : text),
}, body);

// Add a thought. Delete and move with ordinary array operations.
captureBody.encode({ ...current, thoughts: [...current.thoughts, input] }, body);
```

A changed list uses consistent `-` bullets, two-space continuation indentation,
and the body's line ending. An item that is indented code (five or more
columns after its marker) reads as a thought whose first line keeps the
code's indentation, so it is written back as code. Deleting the last thought
is refused, with why, while other Markdown follows the list under the
heading: without a list, that Markdown would read as the start of the
section. An unchanged list retains its original bytes.
Encoding preserves surrounding body content and verifies the resulting text and
thoughts.

Positions go stale when the body changes under them, so an app checks that a
delayed edit's starting list, or the thought an edit started from, is still
current before it encodes. The codec needs no thought IDs.

`excerpt(text)` shortens capture text for a list.

`fromTextarea(original, value, newline)` carries a textarea's value (always
LF) back into source that may use CRLF, rewriting only the changed middle.
`composeBody(text, thoughts?)` builds a new capture's body: the text exactly
as given, then the `## Thoughts` section. A capture is the same when reopened
as when created:

| Text | Body | Reads as |
| --- | --- | --- |
| Ordinary | text, then the section | That text and those thoughts. |
| Has its own "Thoughts" heading | text, then the section | Two headings: refused as `duplicate-heading`, so the pasted list is never the app's thoughts. |
| Leaves a code fence or HTML block open | text, then the section | The section is absorbed (`absorbed: true`). No thoughts until the text above is closed. |
| Has its own Thoughts list, then an open fence | one empty `## Thoughts` heading, then the text, then the section | Two visible headings: refused as `duplicate-heading`. |

The last row is the only case that writes anything before the text. Without
it the fence would absorb the second heading and the text's own list would
read as thoughts. The text's bytes are whole and in order in every row.

## Checks

```sh
bun test packages/capture
bun run --cwd packages/capture typecheck
```

The document tests compare every operation's output with literal expected
bytes.
