# 0464. File table updates conditionally replace the captured whole file

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** the file-backed `update` and `writeSource` methods and their shared conditional publisher.

## Context

The file-foundation prototype at `60dd4e8f92` has `library.edit`, raw path
writes, and a separate generated-body edit. Its source-edit path validates
frontmatter before saving, so temporarily invalid YAML cannot be saved through
the editor. The explored typed-edit contract compares selected fields and
retries against newer source, while the complete-source editor compares the
whole file. Those are different conflict policies for the same saved path.

Notes need a concise rename operation, combined body and derived-title changes,
and complete-source repair. Callers should supply those intentions without
splicing YAML, encoding text, or pairing a source read with a later version.

## Decision

**`table.update(entry, change)` and `table.writeSource(entry, source)` use one
strict whole-file conditional publication rule.** The entry contains its
literal path, exact source, and the content version captured from the same
bytes. Neither operation changes the row ID or moves its filename.

| Method | Preparation before publication |
| --- | --- |
| `update(entry, { fields?, body? })` | Patch the captured source, validate supplied field values, and preserve unrelated source. Fields and a Markdown body may change together. |
| `writeSource(entry, source)` | Encode the supplied complete UTF-8 Markdown source. Invalid frontmatter is saved and reported through the resulting entry's issues. |

Both methods call one publisher that checks the current row file against the
captured version and replaces it only when they match. It checks any admitted
domain requirements at that publication point. Success returns an entry for
the exact accepted bytes, not a later reread. A pre-publication conflict writes
nothing and does not mutate the supplied entry or discard caller input. A
failure after publication starts retains an incomplete operation; it cannot be
reported as that same no-write conflict or silently retried.

The publisher never substitutes a freshly read baseline, merges selected
fields, retries against a new version, or treats a stale request as successful
merely because its desired value is already present. An unchanged write still
checks its preconditions. No `wrote: false` shortcut bypasses them.

`update` refuses source it cannot patch safely without writing. Validation of
one supplied field does not require unrelated stored fields to conform. A
field-only change does not reserialize the body. Source preparation preserves
unknown keys, comments, ordering, byte-order marks, and untouched newline spans.
Complete-source replacement preserves the supplied text; an editor adapter
owns any necessary mapping from its widget to that text.

**The file boundary enforces the same byte-version condition for raw writes.**
Browser managed writers compare and publish transactionally. A native host
serializes participating writers and detects other writers on a best-effort
basis. A hash check followed by rename is not an operating-system-wide
compare-and-swap against arbitrary external programs.

The folder publisher records the accepted bytes in completed Git history before
acknowledging a save. Callers do not stage or commit separately. Changed saves
append one revision; unchanged saves still check their conditions and retain
the accepted bytes. The publisher retains pending evidence for ordinary native
saves as well as row/attachment operations. Remote sync is separate from local
completion. This does not introduce a public general transaction API.

## Consequences

- An external title change conflicts with a pending body save, even when their
  intended edits concern different parts. The app keeps the input for review.
- Named-part freshness comparisons, raw-span freshness comparisons, semantic
  retries, and `EditConflict.parts` have no role in ordinary file-table saves.
- Patching and encoding remain library work. The two methods differ in source
  preparation, not concurrency policy or lifecycle ownership.
- An entry captured when a rename dialog opens remains that action's baseline.
  Fetching again on submit must not silently overwrite an intervening edit.

## Considered alternatives

- A single `save` with exclusive structured/source variants. It can enforce the
  same rule, but the union and runtime exclusivity check remove no machinery.
  Separate verbs state whether source interpretation is required.
- Merge independently edited fields automatically. It adds a second freshness
  policy and retry path; callers instead receive a whole-file refusal.
- Put write methods on every entry. It attaches folder capabilities to captured
  data and complicates sidecar serialization without changing publication.
