# 0264. A table declares its row document's derivation and file codec, and the store runs the derivation

- **Status:** Accepted
- **Amended by:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md), which takes the branch this record left open: the `file` codec's output goes to a continuously rendered folder as well as to an export.
- **Date:** 2026-08-26
- **Supersedes:** ADR-0128 — it removed the table-level document-edit touch policy "until a production workflow establishes one runtime owner"; this record establishes that owner and reintroduces the policy as a pure derivation.
- **Amends:** [ADR-0135](0135-row-documents-have-application-owned-roots.md) at "there is no document declaration on `defineTable`" only; roots stay application-owned and Epicenter still never interprets their contents.
- **Amends:** [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) at "a row document is never rendered" and its rejection of "app-supplied render and parse functions on a table definition"; an application may now supply a document codec, because the definition ships as an imported module rather than a serialized JSON artifact (ADR-0266).
- **Amended by:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at the codec's shape and standing: `file` is mandatory within a `document` block, loses `extension`, and its `deserialize` writes into a fresh document rather than returning one.
- **Relates:** ADR-0248 (the row document and its derived address), [ADR-0258](0258-row-documents-are-opened-through-their-owning-table.md) (documents open through the owning table), [ADR-0253](0253-schema-lenses-interpret-stored-json-on-read-and-writes-admit-storage-valid-facts.md) (scalar writes admit storage-valid JSON).

## Context

A row owns one independent Yjs document (ADR-0248), but a list or a search reads only the always-loaded scalar index and never opens a document. So any part of a document a surface must show without opening it, a note's title or a preview, has to be carried on the row as a scalar. Today each application re-implements that carry inside its editor view: honeycrisp derives `{ title, preview }` in a ProseMirror transaction handler, re-implements the "is this a local edit" gate the store already knows authoritatively, and calls `update`. ADR-0128 removed a declared touch policy because no runtime owned the observation, the locality gate, and the atomic record patch; that owner now exists.

## Decision

A table declares its row document's behavior in a `document` block on `defineData`:

- **`derive: (doc) => Partial<fields>`** is a pure function of the document that returns scalar row fields. The store runs it at the document-commit choke point, on local commits only, and writes the returned fields as a store-driven follow-up commit. That commit is its own durable batch, deliberately not merged with the body append: the derived fields are a lossy, self-healing shadow, so a crash between the body append and the shadow write can leave the shadow one edit stale until the next edit re-derives it, which does not warrant the cross-plane reentrancy an atomic merge would cost. It is authoring-device-only; the derived scalars sync to other replicas as ordinary fields, so a replica that never opens the document still renders it.
- **`file: { extension, serialize: (doc) => string, deserialize: (text) => Y.Doc }`** is the application's bidirectional codec between the document and a text file. Epicenter never interprets the document; the application owns the format, exactly as it owns the roots (ADR-0135).

The store is the single runtime owner ADR-0128 required. It owns the observation (the document's `updateV2` listener), the locality gate (`transaction.local`, which is authoritative where the editor's meta-key heuristic only guessed), and the write (an ordinary store commit that reuses the existing invalidation and flush machinery). Unlike row deletion's retire, this write is deliberately not merged into the body-append batch: a stale shadow after a crash self-heals on the next edit, so it does not earn the atomicity a leaked live document would. `derive` stays pure: it receives the document and nothing else. Event facts such as `updatedAt` are store-owned system fields (ADR-0265), not derivations, so no clock or context is threaded through `derive`.

## Consequences

- The per-application document-edit to row-update chain deletes. Honeycrisp's `extractNoteMetadata` becomes the `derive` declaration; the editor's `onContentChange` prop, its hand-rolled sync-origin heuristic, the body-pane wiring, and the app's `updateContent` all collapse.
- The locality gate stops being a view-layer guess and becomes the store's `transaction.local` truth, in one place, for every application.
- `derive` is unit-testable with no store, because it is pure, the property honeycrisp's `extractNoteMetadata` test already relies on.
- A table now carries a document declaration, which ADR-0135 and ADR-0207 excluded. The exclusions' reasons do not return: Epicenter still never reads inside a document, because the codec is the application's; and the definition is an imported module rather than a serialized artifact, so a function crosses no JSON boundary (ADR-0266).
- The `file` codec is only established here; where its output goes, an export or a rendered folder, is a later record's decision (ADR-0267).

## Considered alternatives

- **Keep the derivation in each application's editor view.** Rejected: it re-implements the locality gate the store owns, scatters the write across every edit surface, and forecloses showing a document without opening it. This is the ADR-0128 status quo, kept only because no runtime owned the patch, which is no longer true.
- **`derive: (doc, ctx)` with an injected clock.** Rejected: it exists only to let `derive` return `updatedAt`, which is an event fact, not a content derivation. Store-owned timestamp fields (ADR-0265) keep `derive` a pure function of the document.
- **A document-blind store that renders documents itself.** Rejected: it would require Epicenter to interpret document roots and conform every application to one schema, the coupling ADR-0135 and ADR-0207 refused. The application-supplied codec keeps interpretation in the application.
