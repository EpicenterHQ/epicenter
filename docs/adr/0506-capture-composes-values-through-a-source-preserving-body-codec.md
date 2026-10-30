# 0506. Capture composes values through a source-preserving body codec

- **Status:** Proposed
- **Date:** 2026-10-06
- **Relates:** [ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md), the row edit session Capture edits through, and [ADR-0432](0432-captures-hold-ordered-thoughts-beneath-a-dated-timeline.md), Capture's text and ordered thoughts.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

Capture switched between Source and interpreted controls for one open file.
Capture's earlier operations produced a whole file that the draft framed
again to extract a body. That crossed
Folder's frontmatter boundary twice.

Capture needs to edit text and ordered thoughts while preserving surrounding
Markdown. Exact formatting continuity for individual thoughts adds provenance
metadata and several input shapes. That promise does not help a person select
and edit the entry they clicked: its position already identifies it in the
current list.

## Decision

Capture exposes a fallible body codec named `captureBody`. `decode(body)` reads
`{ text: string, thoughts: string[] }` and view metadata. `encode(value,
currentBody)` reconstructs and verifies a body against its current source.
Encoding never reads a file or owns a save queue.

Callers compose a complete value. Edit and delete select by array position;
addition appends a string; movement reorders the array. Equal strings need no
identity or provenance. The codec preserves surrounding Markdown and writes a
changed Thoughts list as consistent `-` bullets with two-space continuation
indentation and the body's line ending. An unchanged list keeps its bytes.

```ts
const { data: body, error } = captureBody.encode({
  text: currentCapture.text,
  thoughts: currentCapture.thoughts.map((text, i) => i === index ? input : text),
}, session.draft.body);
if (error !== null) {
  // Show the refusal; immediate controls return to accepted content.
  // An explicit Save form retains its unsubmitted input.
  return;
}
session.edit((row) => {
  row.body = body;
});
```

`session` is the open capture's row edit session (`RowSession` from
`@epicenter/svelte/edit-session`), and `306962b70694:apps/capture/src/lib/capture-form.svelte.ts`
is the form over it. Editing the draft in place leaves its other fields
unchanged, and each edit saves at once. Folder owns frontmatter, validation,
and the guarded save ([ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md), [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md)). A change the
body cannot hold is refused before it reaches the draft, its reason is shown,
and the control returns to the draft's text. A new thought or a thought edit
stays in its form until it is added or saved; a draft whose save fails stays
on screen.

A thought edit holds its index and the thought it started from, and saves only
while that thought is still at that index; otherwise it is refused and its text
stays in the form. Delete and reorder name the list they were shown and are
refused when the draft's list has changed since: decoding produces a new list
each time the draft's body changes, including after Reload theirs. Each thought
edit has its own identity, so input meant for an earlier edit cannot reach a
later one. These are interaction rules; the codec knows no sessions.

Encoding verifies that the resulting Markdown reads as the intended text and
thoughts. For a body without a Thoughts section, appending one preserves the
existing text bytes and consumes its trailing separator lines. Decode reports
that text without those separators, matching the existing append behavior.

Capture has no Source tab and no Files workspace. When the codec cannot decode
the draft's body, the capture view shows the reason and offers **Edit as text**,
which opens the complete file, frontmatter included, in a text session;
**Open as capture** returns once the text reads as a capture.

## Consequences

Capture's structured write path uses only the row edit session and its guarded
autosave.
The codec needs source spans only to locate regions; thoughts are plain strings.
It holds no provenance map, original item identity, or thought input union.

Editing a list may normalize bullet markers, indentation, and spacing throughout
that list. Surrounding Markdown stays intact. Empty items remain readable and
representable; the app asks for text when adding or saving a thought.

## Considered alternatives

- `{ text, origin? }` thoughts that retain original source spans. This preserves
  each item's formatting through movement, but enlarges the value and the
  encoder for a promise Capture does not need.
- Existing handles, strings, and `{ from, text }` replacements. A union makes
  callers learn operation-shaped inputs instead of composing ordinary values.
- Persistent thought IDs. Thoughts belong to a Markdown list, and a current
  position plus an editing-session check identifies the intended entry.
- Giving a structured view and a text view independent active save queues for
  the same file. One item is open at a time, and leaving it waits for its
  saves and releases its session (ADR-0523), so the structured and text
  sessions never save the same file at once.
