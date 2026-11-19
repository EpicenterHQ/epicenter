# 0106. A child-doc body owns one layout; the polymorphic timeline is refused until a product earns it

- **Status:** Accepted
- **Date:** 2026-07-03
- **Amended by:** [ADR-0135](0135-row-documents-have-application-owned-roots.md) for the row-document layout; the refusal of runtime body modes survives
- **Relates:** ADR-0046 (the earned `attachRecords` body layout, the model this follows), ADR-0005 (child docs are bound through the workspace)

## Context

A workspace child-doc body is opened by one `attach*` helper that reserves one Yjs slot and hands back one typed handle. Three helpers hold that shape: `attachRecords` (a keyed LWW JSON bag over `getArray('entries')`, earned by ADR-0046), `attachPlainText` (a `Y.Text` at `getText('content')`), and `attachRichText` (a `Y.XmlFragment` at `getXmlFragment('content')`). Each has a shipped owner (agent transcripts, `@epicenter/skills`, honeycrisp notes).

`attachTimeline` breaks the shape. It reserves `getArray('timeline')` as an append-only log of typed entries and exposes runtime mode-switching between three body shapes: text, rich text, and a spreadsheet (`asText` / `asRichText` / `asSheet`, plus `currentType` and `restoreFromSnapshot`). One child doc, three layouts, switchable at runtime. Its only shipped consumer is opensidian (through `@epicenter/filesystem`), and a monorepo trace shows opensidian exercises **only** the text path (`asText()` and `appendText()`). `asSheet`, `asRichText`, `currentType`, `restoreFromSnapshot`, and the `TextEntry | RichTextEntry | SheetEntry` union have zero production callers. The polymorphism was backed by no ADR, only two `Draft` specs (`sheet-timeline-entry` and `flatten-timeline-into-handle`, both deleted on acceptance; git keeps the bodies recoverable). Meanwhile the `timeline` `Y.Array` of typed `Y.Map` entries is a durable, synced format: every existing opensidian file body is stored that way, so its shape cannot be changed without an explicit migration.

## Decision

**A workspace child-doc body owns exactly one layout. A mode-switching body (a document that can become text, rich text, or a spreadsheet at runtime) is refused as a shipped capability until a real product names the user operation that needs it.** Building the multi-mode primitive before a spreadsheet surface exists is the speculative shape this decision rejects; the ideal home for opensidian's file body is a single-layout text or rich-text body.

This is a decision about the published TypeScript API and product direction, not a change to stored data. The durable `timeline` slot name (`'timeline'`), its entry `Y.Map` keys (`type`, `content`, `createdAt`, `frontmatter`, `columns`, `rows`), and its blob layout are **frozen** and untouched by this ADR. Any collapse of the timeline body to a single-layout body is a separate migration that requires explicit approval before it is written.

The work is sequenced so the durable format is never touched implicitly:

1. **Now (this ADR):** record the refusal. No code change to stored data.
2. **Next, once accepted:** trim the published `attachTimeline` API down to the text path (drop `asSheet`, `asRichText`, `currentType`, `restoreFromSnapshot`, and the entry-type union from the handle). Existing data stays valid: every stored entry is already a text entry, so the reader is unaffected. This is a pre-1.0 breaking type change with a changeset, no data migration. The same trim collapses the now-dead sheet and rich-text machinery, which a first attempt (PR #2344, closed) surfaced as tangled and worth doing here in one motion rather than grooming separately:
   - Delete the workspace timeline's `sheet.ts` and `richtext.ts` helpers once the modes are gone; this removes `generateInitialOrders`, which has no other consumer.
   - Remove the leaky `./document/attach-timeline` package export. Its only external importer was `@epicenter/filesystem`, and only for two ordering helpers, not for `attachTimeline` (which ships from the package root) or the sheet serializers.
   - Rehome `computeMidpoint` by inlining it into `@epicenter/filesystem`'s `formats/sheet.ts`, its sole consumer, and delete filesystem's dead re-export of the ordering helpers (nothing imports them from filesystem). There is no shared helper to preserve: `computeMidpoint` is filesystem-only and `generateInitialOrders` is workspace-internal.
   - Caveat for whoever inlines it: `computeMidpoint` is float bisection with jitter and loses precision after ~50 inserts between the same neighbors (duplicate order values). It is deletion-bound today because filesystem's sheet reorder has no non-test consumer, so do not invest in it. If a real sheet surface ever ships, replace it with a string-keyed fractional index rather than porting this.
3. **Separately, if pursued:** plan the storage migration that replaces the `timeline` `Y.Array` with a single-layout body (`attachPlainText` or `attachRichText`). This is a durable-format change and gets its own ADR and migration reader.

## Consequences

- **The polymorphic surface becomes deletable.** `asSheet`, `asRichText`, `currentType`, `restoreFromSnapshot`, and the `TextEntry | RichTextEntry | SheetEntry` union have no production consumer, so removing them from the published API loses no shipped capability. That trim is the immediate follow-up (step 2), landed on its own.
- **opensidian keeps working unchanged.** It reads and writes text entries today and continues to; the durable format is frozen, so no user's file body is at risk from this decision.
- **The two `Draft` timeline specs are refused, not parked.** `sheet-timeline-entry` and `flatten-timeline-into-handle` describe a capability no product has earned. They are deleted rather than left standing (done in the step-2 trim PR, alongside this acceptance), and the `Active` `unify-document-content-model` spec is revised so content unifies onto single-layout bodies, not a mode-switching one.
- **The trim discards working, tested code.** The refused surface is not dead-on-arrival: the mode-switch machine, CSV round-trip, and `restoreFromSnapshot` carry real, passing coverage (`timeline.test.ts` is ~600 lines). Refusing the capability throws that away and accepts a rebuild-with-migration cost if a sheet product ever arrives. We take that cost deliberately: the code sits on a durable, synced format that no product exercises, so every day it stays is a latent three-shape reader obligation with no offsetting user value.
- **This forecloses shipping a spreadsheet-morphing document body cheaply later.** If a real sheet product arrives, the primitive is rebuilt then, deliberately, with a migration, in exchange for a smaller, honest API today where one child doc means one body layout.

## Considered alternatives

- **Keep the polymorphic timeline as-is.** Rejected: it maintains a text/rich-text/sheet mode machine, CSV round-tripping, and snapshot restore that no shipped surface exercises, backed by no ADR. It is speculative capability sitting on a durable format.
- **Collapse the timeline to a plain-text body now, in one move.** Rejected as premature: it changes a durable, synced data format and would need a migration reader written before the product question is even settled. The API trim (step 2) captures the win without touching stored data; the format migration is a later, separately-approved step.
- **Trim the API silently as a refactor, no ADR.** Rejected: refusing a capability a live `Draft` spec still wants is a product decision, not a mechanical cleanup, and durable-format implications mean it must be recorded and sequenced, not merged quietly.
