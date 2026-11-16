# Collection files, reference checks, and Vault adoption

**Date**: 2026-11-16
**Status**: Draft
**Owner**: Braden

The remaining work is missing-reference diagnostics, collection-owned files,
and adopting collection records in the Vault's publishing model. Runtime 0.4.0 already implements
selection by key, lists and references, record checks, literal front matter,
JSON command input, Result-returning methods, and run replay. Their decisions
live in ADR-0918, ADR-0920, ADR-0921, and ADR-0923 through ADR-0926. Git retains
the earlier implementation waves and rollout notes.

## Decisions still proposed

- [ADR-0919](../docs/adr/0919-a-collection-declares-its-files-beside-its-fields-and-they-rest-in-the-folder-named-by-its-key.md) proposes named file slots owned by a collection record.
- [ADR-0922](../docs/adr/0922-a-file-reaches-an-action-as-its-own-input-beside-input-and-only-a-page-sends-one.md) proposes declaring file inputs separately from JSON input.

Both records remain Proposed. The current temporary upload API is
`field.file()`; it does not implement collection-owned files.

## Missing-reference diagnostics

- [ ] Extend `epicenter check` to report reference keys whose targets are
  absent, as planned in ADR-0921. The current check validates each file;
  `add` and plain-data `set` validate only the references they write.

## Collection-owned files

- [ ] Settle ADR-0919 and ADR-0922 before implementing their public APIs.
- [ ] Declare file inputs separately on actions and replace the existing
  `field.file()` scans on the accepted terms.
- [ ] Settle temporary input retention for the new declaration. The current
  run host retains failed-run input until its existing expiry.
- [ ] Add collection file slots, the record's directory, `dirOf`, and a way
  to move received bytes into that directory.
- [ ] Decide how an app serves kept media to its page.
- [ ] Exercise the result with an app that owns an uploaded recording.

The existing page-run transport already carries temporary uploads. The new
work concerns declaration and durable file ownership.

## Vault adoption

The Vault owns its authored pages and existing publishing tools. A separate
Vault change must decide how they adopt the current collection API.

- [ ] Identify every reader and writer of authored front matter before
  converting it to the line grammar in ADR-0924.
- [ ] Declare pages, journal, and collections using the current key and
  reference APIs.
- [ ] Decide the authored-file layout together with file ownership. A layout
  such as `data/pages/<page>/page.md` moves existing files and requires
  rewriting their links. Preserve authored content and recovery history.

## Boundaries to preserve

An action's app lock currently closes the read/rename gap in folder updates,
protects create-only behavior, and lets callers distinguish a live writer
from a dead one. Changing that ownership needs its own decision and caller
evidence. This plan supplies no replacement lock protocol.

The first file-slot proposal leaves a record's directory after deleting its
Markdown file. Settle deletion behavior with the first real owner. Typed
keys, self-references, cyclic references, and record moves remain deferred
until a caller needs them.

## Completion evidence

- A page uploads and reads back a file owned by its record.
- Reads, checks, and deletion behavior agree on missing or malformed file
  slots and preserve files the operation does not own.
- A Vault adoption rehearsal preserves authored content, rewrites links,
  and retains a usable recovery copy before changing the live home.
