# 0268. A row exports as one Markdown file, and its codec is mandatory

- **Status:** Accepted
- **Amended by:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) at when these files are written: continuously, by the mirror, rather than on demand by an export a person invokes. Every rule about their content holds unchanged.
- **Date:** 2026-08-26
- **Superseded by:** ADR-0296 at the codec's signature and placement. Its content rules are retained.
- **Amends:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md) at the codec's shape and standing: `file` is mandatory within a `document` block, loses `extension`, and its `deserialize` writes into a fresh document rather than returning one.
- **Amends:** [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md) at the artifact layout: `tables/<table>.json` and `documents/<table>/<row>.<ext>` collapse into one Markdown file per row, and export saves before it reads.
- **Relates:** [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) (its row-as-markdown-with-frontmatter file shape returns here, as the export artifact rather than a continuously rendered folder), [ADR-0266](0266-definedata-compiles-once-and-holds-behaviors-beside-a-json-field-core.md) (behaviors ride beside the data core, which is what lets the parse tell an authored block from a serialized husk).

## Context

ADR-0267's artifact carried a row in two places: its scalar fields in `tables/<table>.json` and its document in `documents/<table>/<row>.<ext>`, correlated by coordinates across two trees. And the codec that carries the document was optional: the reference app declared `derive` with no `file`, so the one shipped app's export held titles and previews and no prose. The export is the escape hatch (export, purge, rebuild) and, since ADR-0267 amended ADR-0256, also the manual compaction path; an escape hatch that silently drops bodies fails at exactly the moment someone is trying to save their data.

## Decision

**One Markdown file per row.** The artifact is `kv.json` plus `<table>/<rowId>.md` for every row of every table: the raw scalar fields as YAML frontmatter, and, for a table with a `document` block, the codec's serialization as the body. A table without documents exports frontmatter-only files. `kv.json` stays JSON: one object, no body, nothing frontmatter would buy.

**The codec is mandatory wherever a document block exists.** `defineTable` requires `file` whenever `document` is declared, and `parseData` refuses an authored block without a whole codec. The enforcement point is the declaration, where the author can still fix it; there is no export-time sweep and no binary fallback format. A definition that arrived serialized carries its functions stripped (ADR-0266), so a block with no surviving function is an inert husk and compiles as no block at all.

**The codec is two functions and no extension.** `serialize: (doc) => string` produces the file's body; `deserialize: (text, doc) => void` writes the body back into a fresh document through the same root surface. Every row file is `.md`, so the extension field had nothing left to say. A future non-Markdown document format earns its own decision when it has a producer.

**Export reads one accepted instant, with no flush step.** The whole artifact comes from one read of the live state: everything the store has accepted, which is everything durable plus anything a blocked flush is still retaining. That is at least the "everything saved as of now" a person means by export, and strictly more in the one case that matters most: when storage is failing, the escape hatch still carries the work the disk could not take. Reading the durable record instead would have required a flush first and seen less.

**Frontmatter must round-trip exactly.** The artifact is deliberately lossy of Yjs identity and history (ADR-0267) and of whatever formatting a codec cannot express, but never of a scalar value: the emitter quotes every string, and import parses strictly, so `"007"` and `"no"` come back as the strings they are. A hand-edited file that no longer conforms imports as a nonconforming row, the ordinary err-toward-saving path, not a refusal and not silent repair.

## Consequences

- The reference app's export becomes a folder a person can open in any Markdown vault tool: one readable file per note, fields on top, prose underneath.
- The two-tree correlation deletes. Import consumes one file per row, atomically per file, instead of joining a JSON entry to a document file by coordinates.
- The address grammar already carries the layout: table names are bare identifiers, row ids are path-safe with no leading dot, field names are YAML-safe unquoted. Nothing new needs escaping.
- Honeycrisp owes a real codec, and now has one: body Markdown through the editor's own schema, so the exported prose matches what a person saw. Underline is the codec's one declared loss; Markdown has no underline, and the text survives.
- A table whose rows' documents are used without any `document` block still exports frontmatter-only files, and those bytes stay invisible to the artifact. Accepted knowingly: nothing in the tree does this, and the declaration rule covers every real case. If an app grows that pattern, this is the note to reread.

## Considered alternatives

- **Keep the codec optional and skip codec-less tables.** Rejected: it is the shipped bug this record exists to close; the walker's silent `continue` was indistinguishable from a complete export.
- **An export-time fail-closed sweep over stored chains.** Rejected as a second enforcement point. The declaration rule catches every real case with one rule in one place; the sweep guarded a pattern with no producer.
- **An opaque binary sidecar for documents without codecs.** Rejected: it creates a second artifact vocabulary and a file a person cannot read, in an artifact whose whole point is legibility.
- **Per-table JSON plus a documents tree (ADR-0267's layout).** Rejected for the correlation cost and because it kept the row's identity split across two files that could disagree.
