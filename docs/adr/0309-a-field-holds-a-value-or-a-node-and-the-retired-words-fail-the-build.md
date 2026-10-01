# 0309. A field holds a value or a node, and the retired words fail the build

- **Status:** Accepted
- **Date:** 2026-08-31
- **Amended by:** [ADR-0431](0431-rows-return-values-and-own-a-separate-body.md) separates body access from value snapshots and stores the body as the row's sole sequence child, removing the reserved field name.
- **Supersedes:** [ADR-0299](0299-a-row-is-its-scalars-and-one-content-node.md). The shape it decided is unchanged and restated here in the settled words. Its context, its four refusals, and its per-row byte measurements stand and are not repeated.
- **Relates:** [ADR-0228](0228-a-field-is-one-value-and-a-collection-several-devices-append-to-is-a-table.md) (the merge law this names), [ADR-0244](0244-epicenter-speaks-of-apps-and-windows-not-surfaces.md) (the prior vocabulary decision, and the one this record fixes a gap in), [ADR-0296](0296-rich-content-is-a-declared-field-and-a-table-owns-its-file-codec.md) (settled "rich fields" the same way and swept only itself)

## Context

A row's fields divide by one property: whether a write replaces the value or
edits inside it. Two devices that write the same `title` offline resolve to a
winner. Two devices that type into the same `content` offline both keep every
keystroke.

The repository named that division after the *shape* of the two things rather
than after that property, and both names were wrong in opposite directions.
"Scalar" claimed the replaced side is small and simple, but `tags` is an array
and behaves identically to `title`, and the same word also appears meaning
"single" (one document) and meaning "a kind that forbids `enum`". "Prose"
claimed the edited side is writing, which is the one fact the store promises
never to know: `packages/chat` keeps a message map in one, and a table's
declared codec is the only thing that reads inside.

Neither word is an identifier. `scalars` as a declaration key was deleted, and
`field.prose()` was refused in ADR-0296. They survive only in comments, test
names, and prose, where nothing checks them. ADR-0244 made the same kind of
decision, shipped no check, and needed a hand-run campaign afterwards that is
still an open spec in the tree.

## Decision

**A row is its `id`, its values, and exactly one node at the reserved key
`content`.**

A **value** is replaced whole. A write hands over a new one and the old one is
gone, so two devices converge on a winner (ADR-0228). It is JSON, it compares
by equality, it sorts a list without opening anything, and it is written to the
file's frontmatter under its own field name. A string, a boolean, and a tag
array are the same kind of thing, because being replaced whole is what they
share.

A **node** is edited in place. It is a Yjs shared type, `Y.Type` in v14, one
class carrying a sequence and attributes at once. Concurrent edits inside one
node all survive. Epicenter never reads inside; the table's declared codec is
the only thing that turns one into the text below the fence.

Say **shared type** only when the sentence is about Yjs itself. Say **node**
everywhere the sentence is about a row.

`scalar` and `prose` are retired from the store's vocabulary as of this record.
So is `column`, which has had no referent since ADR-0269 deleted the SQL
projection, though only the first two are machine-checked: Drizzle schemas,
table UI, the append-only log's one real SQLite column, and two app-owned
mirrors all have real columns, so a ban would be mostly exceptions.

**`bun run check` fails on a retired word.** `scripts/check-vocabulary.ts` runs
inside `check:structure`, so the check is added in `package.json` and nowhere
else. `scalar` is refused nearly everywhere; `prose` is an ordinary English word
and is refused only where the store's vocabulary lives, which the script lists.
A naming decision is landed when that check passes, not when this record is
written.

## Consequences

**Records are not swept.** `docs/adr/` and `specs/` are outside the check. An
ADR is a dated record of what was decided in the words it was decided in, and
rewriting one falsifies it. Accepted records that predate this one keep
`scalar` and `prose`; this record is the current statement of the row's shape,
which is why it supersedes ADR-0299 rather than amending it. No ADR filename is
renamed, following ADR-0296: the vocabulary moves, the record's name does not.

**Matter is outside the check.** `packages/matter-core` and `apps/matter` own
their own copy of the field palette, depend on nothing in the store, and speak
their own words. The check is scoped by directory, not by a per-file exception.

**`scalar` leaves the field palette too**, where it was decoration. The palette
calls a meta "closed" when it sets `additionalProperties: false`, which is what
makes `recognize` unambiguous; every kind but `json` is closed. The sentence
that says so does not need a second adjective.

What this costs: the two copies of the palette now differ in their comments,
and nothing compares them. That is the arrangement this record inherits and does
not try to fix, because the copies exist so the two systems can diverge.

What it forecloses: a future in which Matter opens a store export. That would
require the two palettes to agree on what `field.date()` writes, and no test
would fail if they stopped. Reopen this if that product decision arrives.
