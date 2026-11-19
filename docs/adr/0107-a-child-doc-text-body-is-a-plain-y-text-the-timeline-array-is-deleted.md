# 0107. A child-doc text body is a plain `Y.Text`; the timeline array is deleted

- **Status:** Accepted
- **Date:** 2026-07-04
- **Amended by:** [ADR-0135](0135-row-documents-have-application-owned-roots.md) for the permanent row-document root model; the timeline deletion survives
- **Relates:** [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md) (refused the polymorphic timeline and gated this step-3 storage change), ADR-0005 (child docs are bound through the workspace)

## Context

ADR-0106 refused the polymorphic (text/rich-text/sheet) timeline body and trimmed `attachTimeline` to a single text path, but deliberately **froze the durable storage**: a file body stayed a `Y.Array('timeline')` holding one text entry (`Y.Map` with `type`/`content`/`createdAt`). It sequenced the storage change as a separate step-3 requiring its own ADR, because changing a durable synced format needs an explicit decision.

After the step-2 trim and its collapse follow-ups, the timeline handle is a single-text-body API (`read`/`write`/`appendText`/`asText`/`observe`) whose only remaining oddity is internal: it stores text as an append-only array of one entry, under a slot named `timeline`, through a bespoke module. The workspace already ships the ideal primitive for this shape, `attachPlainText` (a `Y.Text` at `getText('content')`), used by `@epicenter/skills` and honeycrisp. The only consumer of `attachTimeline` is opensidian's file body (through `@epicenter/filesystem`), which is a CodeMirror **Markdown-source** editor: the body is plain text, so a plain `Y.Text` is its exact type, not a compromise.

The one thing that kept the array was compatibility: existing opensidian file bodies are stored as timeline arrays, and this is a local-first CRDT, so there is **no conflict-free way to destructively migrate** that data across replicas without a guaranteed single writer (which local-only docs lack). That constraint is real, but it only bites if there are existing bodies to preserve. This decision is taken under an explicit greenfield release of that pressure: **treat the store as having no users to protect, and take the clean break.**

## Decision

**A child-doc text body is a plain `Y.Text` at `getText('content')`. `attachTimeline` and the `timeline` slot are deleted; the file body layout becomes `attachPlainText`.**

- `@epicenter/filesystem`'s `filesTable` binds `content: attachPlainText` (was `attachTimeline`). File bodies are stored at `getText('content')`, not `getArray('timeline')`.
- `attachTimeline` and its `attach-timeline` module are removed from the published `@epicenter/workspace` API.
- `attachPlainText` gains an `appendText(text)` method, earned by two concrete operations: POSIX `appendFile` in filesystem and opensidian's append-to-body calls. It sits beside `read`/`write` as the third natural verb on a text handle; editors keep binding `binding` directly.
- opensidian's editor binds `handle.binding` instead of `handle.asText()`. Because `getText('content')` presents a valid (possibly empty) `Y.Text` with no structural write, the empty-doc seed that `asText()` performed is gone, and with it the mutation hazard the editor's hydration gate guarded against.

**This is a durable-format break with no migration reader.** It is taken deliberately under a greenfield, zero-users assumption. Any file body written by the old timeline layout (a `Y.Array('timeline')`) will read back empty under the new layout, because the reader now looks at `getText('content')`. No code preserves or converts the old bytes. If real user data existed, this break would require the migration this ADR instead refuses to write; the greenfield assumption is the whole reason it is safe.

## Consequences

- **The bespoke body primitive disappears.** `attachTimeline`, its module, its test, and the `timeline` slot name are deleted. One child-doc text body now means one `Y.Text`, through the same `attachPlainText` every other text body already uses. Go-to-definition from a file body lands on the shared primitive, not a bespoke wrapper.
- **`attachPlainText` grows one earned verb.** `appendText` is general (append to a text body), not filesystem-specific, and has live callers. `read`/`write`/`appendText` are the text handle's verbs; `binding` is the editor target.
- **opensidian loses a hazard, not just a call.** The `asText()`-seeds-on-empty behavior and the load gate that existed to survive it are removed; binding a `getText` slot before local hydration is safe because it never mutates.
- **Old on-disk bodies are abandoned, by decision.** Under the greenfield assumption there are none to lose. This is the break ADR-0106 gated and this ADR accepts; it is explicitly not a silent format drift.
- **A future rich-text file body is still a separate primitive.** If opensidian ever ships WYSIWYG, that body is `attachRichText` (a `Y.XmlFragment`), a different single-layout primitive, not a mode of this one. ADR-0106's one-body-one-layout rule still holds.

## Considered alternatives

- **Keep the frozen timeline array (ADR-0106 step-2 end state).** Rejected under greenfield: the array-of-one-entry and the `timeline` name only survived to avoid a migration that a zero-users assumption makes unnecessary. Keeping it is legacy-avoidance, not design.
- **Write-forward with a permanent read-fallback adapter.** A composable `withTimelineFallback(attachPlainText)` that writes new bodies to `Y.Text` and reads old ones from the array. Rejected: it buys the same end shape but keeps a dual-read path that can never be retired (a local-only legacy doc may surface at any time), and the seed-on-first-open still races across replicas. It is the right answer only if existing data must be preserved; greenfield removes that requirement.
- **A coordinated one-shot migration (server-side or CLI).** Rejected: it cannot cover local-only, never-synced docs, and it is unnecessary work once the data is assumed absent.
- **Add a bespoke `attachFileBody` primitive (timeline without the array).** Rejected: it reintroduces a one-consumer wrapper when `attachPlainText` already is that primitive. Reuse over a parallel shape.
