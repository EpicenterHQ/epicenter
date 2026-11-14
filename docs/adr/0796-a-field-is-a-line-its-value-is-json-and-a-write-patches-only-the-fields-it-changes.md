# 0796. A field is a line, its value is JSON, and a write patches only the fields it changes

- **Status:** Superseded
- **Date:** 2026-11-05
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at "Whatever an Epicenter tool writes is in house style: schema keys first, then sorted, block YAML": a tool writes only the fields it changes, each value as JSON; [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) at "Block style stays the house style" and at comparing a key's text: a field's value is JSON, and the merge compares values; [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at a write formatting the note it writes: a write patches the lines of the fields it changes.
- **Relates:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (speak the standard), [ADR-0727](0727-json-schema-is-the-field-language.md) (fields are JSON Schema), [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) (one primitive in each language under one fixture).
- **Amended by:** [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) at reading any YAML: Epicenter reads only its grammar, and a file outside it is all body.
- **Unbuilt:** all of it: the front-matter primitive (split into fields, patch a field, read a value) in TypeScript and Rust under the fixture of ADR-0795; writes patching fields in `packages/folder/src/note-codec.ts`; the merge comparing JSON values; deleting the whole-note formatter in `packages/definition/src/note/canonical.ts`, the contract key order passed to writes and merges, and `epicenter format` with `formatNotes`.

## Context

ADR-0795 merges a note's front matter by key and has a write rewrite only the
keys it changes. That leaves one thing formatted: a value. Today a whole note
is formatted on every write, in contract key order, as block YAML whose
scalars are plain where YAML 1.1 and 1.2 readers agree and quoted elsewhere
(`canonical.ts`). A merge that compares a key's text counts a value an
editor only re-quoted as changed, so that side can win over a real edit made
on another device; comparing values instead needs one value form both
languages read the same way.

## Decision

**A field Epicenter writes is one line at the first column, `key: value`,
and its value is JSON**, which YAML 1.2 reads as YAML. There is no
exception: a string spanning lines is written with its newlines escaped.
Epicenter reads any YAML a person or another tool writes, a value indented
over several lines included, and leaves a field it does not change as it was
written.

```yaml
---
title: "Call dentist"
done: false
tags: ["health", "admin"]
---
```

**Prose belongs in the body.** A field is a value; text people read or edit
is a note's body. A contract that keeps multi-line text in a field, such as
Whispering's runs keeping the prompt and input they sent, gets it escaped on
one line.

**A write patches only the fields it changes.** It reads the file, replaces
the lines of each field it sets, removes the lines of each field it deletes,
and adds each new field at the end of the front matter, before the closing
fence; it writes over exactly what it read, and when the file moved, it reads
and patches again (ADR-0774). Nothing formats a whole note.

**The merge compares values.** A field is unchanged on a side when its value
equals the base's, whatever its text; fields both sides added go at the end in
name order. Reading a field, patching it, and merging by field are one
primitive, written once in TypeScript and once in Rust and held to one
fixture.

## Consequences

- Values are written and compared identically in both languages, with no
  YAML 1.1 and 1.2 quoting rules.
- A note written by a person or an agent is never reformatted by a save, and
  an editor that re-quotes a value does not win a merge it did not change.
- Contract key order no longer shapes a file, so no write or merge takes it.
- The whole-note formatter and `epicenter format` go; `epicenter check` stays.
- Strings Epicenter writes carry quotes, and its lists sit on one line.
- Whispering's run notes show their prompt and input as one escaped line.

## Considered alternatives

- **Readable block YAML for written values (ADR-0795 as recorded):** keeps the
  quoting rules, and the merge compares text, so a re-quote counts as a
  change.
- **JSON, with multi-line strings as literal blocks:** readable prose, at the
  price of YAML's block rules (`|`, `|-`, `|+`, an indentation indicator) kept
  byte-identical in two languages, and an exception that invites more.
- **New fields at their contract position:** reshuffles what is around them,
  and needs the contract's order in every write and merge.
