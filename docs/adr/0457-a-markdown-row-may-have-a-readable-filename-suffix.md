# 0457. A Markdown row may have a readable filename suffix

- **Status:** Proposed
- **Date:** 2026-09-29
- **Amends:** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) at its exact `<id>` filename requirement.
- **Unbuilt:** optional readable filename suffixes and row lookup by the ID before the suffix.

## Context

[ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) gives a row the path `<id>.md` and at most one same-stem attachment. That makes ownership visible, but a directory full of opaque IDs is hard for a person or coding agent to browse. A title in frontmatter helps after opening a file; it does not help when scanning filenames or writing a Markdown link.

The current row ID grammar permits hyphens, including `--`. Parsing `r123--interview.md` at the first `--` would therefore change the meaning of an existing ID. A suffix needs a boundary outside the ID grammar.

## Decision

**A row filename is either `<id>.md` or `<id>~<suffix>.md`.** The ID remains the row identity. The optional suffix is a readable filename label; it is not a second ID and is not copied into frontmatter as an identity field. `~` separates it from the ID and stays excluded from the row ID grammar. The suffix contains lowercase ASCII letters, digits, and hyphens, begins and ends with a letter or digit, and is not empty. An app refuses a complete filename that the destination filesystem cannot store.

**An owned attachment uses the Markdown file's entire stem.** The extension and one-attachment rules of ADR-0456 still apply.

```text
so.epicenter.whispering/
  recordings/
    r123~2026-09-29-interview.md
    r123~2026-09-29-interview.opus
    r124.md
```

`r123~2026-09-29-interview.md` and `r123.md` would name the same row ID if placed in one table directory. The app reports that duplicate and refuses to select one for ID-addressed reads, updates, renames, or deletes until the duplicate is resolved. Both source files remain readable by path. A title or date field changing does not rename either file.

**An app may explicitly rename the suffix but never changes the ID prefix of an existing row.** A suffix rename moves the Markdown file and its attachment, if present. If a filesystem edit replaces the ID prefix, the old row has disappeared and a new row has appeared; the app does not infer that one identity became the other.

This decision does not require an app to offer suffix renaming or define a shared rename API. An app that offers it must detect an interrupted move of the pair and cannot claim to have repaired links in unopened folders. A coding agent editing files directly can update links as part of its edit. Either way, an ordinary relative Markdown link names a path, so changing that path requires its references to change.

## Consequences

- People and coding agents can recognize rows from a directory listing and write readable relative links. Apps can still use `<id>.md` when a label adds nothing.
- A date in the suffix is descriptive text. Sorting this directory by filename sorts first by ID, not by that date.
- An explicit suffix rename moves up to two files and may require rewriting links in other Markdown files. A title edit alone has no path or link repair cost. No app operation rekeys a row ID.
- A table directory can contain at most one Markdown filename for each parsed ID. Duplicate IDs and filename collisions are errors to report, including collisions on case-insensitive filesystems.

## Considered alternatives

- Require `<id>.md` for every row. This keeps the filename fixed but makes directory listings and links harder to read.
- Use `<id>--<suffix>.md`. Existing row IDs can contain `--`, so the ID boundary would be ambiguous without restricting the current ID grammar or consulting an external index.
- Derive the suffix from the title on every save. A title edit would become a file rename and require link repair even when the writer only meant to change text.
