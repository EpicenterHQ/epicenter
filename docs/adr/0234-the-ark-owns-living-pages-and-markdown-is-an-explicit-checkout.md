# 0234. The Ark owns living pages, and Markdown is an explicit checkout

> **2026-08-29 — Amended by [ADR-0291](0291-the-ark-is-the-public-home-of-an-epicenter.md) at the product boundary.** The Ark is now the public home of an Epicenter rather than a second authored universe. The page and checkout mechanics below remain provisional until their ownership boundary is reconciled with that decision.

- **Status:** Proposed
- **Date:** 2026-08-10
- **Amends:** [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) at the Ark page checkout: it replaces continuous field rendering, field-only prose, and conflict-free push with an explicit checkout of a page row and its prose document; [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md) at the application model: `so.theark` is a Lens whose page rows own the authored page attributes and prose document.
- **Relates:** ADR-0215, [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md)

## Context

The Vault currently owns an editable Markdown page and the metadata beside it.
That makes ordinary text editing pleasant, but it leaves no one local-first page
model from which an Ark can derive its library, collections, and release work.
Copying the page between Markdown and a workspace would create two writers for
the same title, tags, resonance, and prose.

Lens already supplies the needed source shape: one namespace names one Yjs
document, rows carry typed attributes, and every row owns a prose document.
SQLite is rebuilt from that document at bind time, so it is not another source
to synchronize.

## Decision

The Ark Lens, `so.theark`, owns living pages. A `pages` row owns the page's
structured attributes and its living prose document. Markdown is an editable,
diffable checkout of that row, not a competing source of truth.

Ark enters the generic Epicenter API through its Lens and workspace document:

```ts
const ark = await open(arkLens, {
  document: 'workspace',
  principalId,
});

ark.tables.pages.create({ ... });
ark.tables.collections.create({ ... });
```

Epicenter owns the Lens, Yjs document, projection, and read-only SQL surface.
Ark alone owns the meaning of pages, collections, Markdown checkout, and
publishing. No generic Epicenter collection abstraction is introduced.

`ark.lens.json` is a local Lens artifact. The Ark validates a saved change,
keeps the last valid Lens active on an error, and rebuilds its SQLite projection
from the existing Yjs document after a valid rebind. A namespace and table name
are durable addresses, so changing either is not a live rename.

The Markdown checkout has one local base record per materialized page. The
surface is:

- `ark status` reports local Markdown changes, newer Ark changes, and conflicts.
- `ark diff` shows the structured and prose difference from the last checkout.
- `ark push` imports a Markdown change as a patch against that base; it never
  force-overwrites newer Ark work.
- `ark pull` materializes Ark work into Markdown and refuses to overwrite local
  changes.
- `ark sync` composes a successful push with a pull. It owns no separate merge
  behavior.

An import compares the last exported page, the local Markdown checkout, and the
current Ark page. It applies a safe patch or stops with an intelligible conflict.

## Consequences

- Markdown, Git diffs, and external editors remain first-class writing surfaces,
  but saving a file is local until `ark push` imports it.
- SQLite is queryable only as a projection. Direct SQLite writes never create
  Ark state.
- The Vault's current Markdown-first ownership and its frontmatter write path
  must retire in one clean migration. There is no bidirectional background sync.
- The local checkout manifest is machine state. It maps a materialized Markdown
  path to its Ark page and exported base; it is not authored metadata.
- A later migration must give every existing Vault page an Ark row, preserve its
  prose and declared fields, export the first checkout, then delete the old
  Markdown-as-source path.

## Considered alternatives

- **Markdown remains the source and Ark indexes it.** Refused: collections and
  releases would derive from a second system rather than from the page model
  that owns them.
- **Background bidirectional sync.** Refused: it hides conflicts and creates two
  writers for every authored field.
- **Force push Markdown into Ark.** Refused: a local file may not silently erase
  newer work from another Ark replica.
