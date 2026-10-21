# 0666. A source replacement decides local content and still merges on save

- **Status:** Proposed
- **Date:** 2026-10-21
- **Unbuilt:** Ordered local edit reduction and exact submitted-prefix acknowledgment across source and structured saves.

## Context

One `FileEdit` owns accepted input for a path. Forms call `change({ fields?,
body? })`; source views call `replaceText(text)`. Current pending input has
document and text variants, with handoffs between them. A named assignment
made after source input can be lost when serialized into a text diff, including
when its value equals the earlier source value. Source views also autosave
ordinary typing. Their saves currently merge independent outside changes,
as ADR-0622 promises.

## Decision

**One path owner applies accepted local commands in order.** A `change()`
field is an assignment to a named field, including when the assigned value
equals the source value. A body change retains the body it was accepted over.
`replaceText(text)` makes the supplied text authoritative for the local
projection: an earlier unsaved command cannot impose a value that conflicts
with it. Earlier commands are no longer independent pending work, but their
effects remain as merge context where the replacement still expresses them.
For example, a held title assignment remains in the source unless the source
replacement changes that title. Later `change()` commands apply to the
replacement and retain their named assignments and body witnesses through
every guarded storage retry. Reading or switching views
changes no input. `FileEdit`, its path, `getText()`, `getMarkdown()`, and the
Svelte `.text` and `.markdown` projections remain the public editing surface.

**A local source replacement keeps the Folder's merge rule for outside writers.**
Saving `replaceText()` uses its retained source witness and ADR-0622's
whole-file content merge. Independent outside fields and body regions survive;
the acting save wins competing units. The same merge runs when a guarded
storage attempt must retry. `replaceText()` by itself is not an unconditional
storage overwrite. A force-replace operation, if ever needed, requires a
separate explicit decision and user action; ordinary Source typing never
selects it implicitly.

**A save acknowledges exactly the accepted input it submitted.** It freezes a
submitted prefix while later typing continues. When storage succeeds, its
actual stored result becomes the new witness and only that prefix is cleared.
Later fields apply as named assignments to the stored result; later body or
source changes retain what the person edited over, so a concurrent independent
change and an intentional revert both survive. For example, Source changing a
held title from `Mine` back to `Old` remains a revert even if `Old` was the
value before the held title assignment. If the attempt fails, the
submitted input and later input stay pending with a truthful failure status.
An older save receipt cannot clear or silently rebase away a newer accepted
`replaceText()`.

**Input that cannot appear in the current Markdown projection stays recoverable.**
An outside malformed header does not make accepted field or body input vanish.
`getMarkdown()` describes only the source that can be shown; `getPending()`
keeps unapplied input and its failure. A later accepted whole-source replacement
may explicitly supersede that input, but a view must expose it for recovery
before enabling a source action that would do so. Opening Source alone never
discards input. Storage still checks field interpretability and body boundaries
inside every guarded attempt.

## Consequences

- Local command precedence no longer depends on whether the owner currently
  stores a document-shaped or text-shaped pending value. An implementation may
  compact ordered commands, including repeated source keystrokes, but must
  preserve the effects and witnesses needed to merge the final local source,
  named assignments, submitted prefixes, and failed input. A single
  `{ base, draftText }` pair cannot do so.
- Source autosave continues to preserve independent edits from another tab,
  agent, or sync. A source replacement may still override a competing line or
  field under the existing merge rule.
- Pending recovery must make superseded, unrepresentable structured input an
  intentional user action. A source command accepted while an older save runs
  cannot undo that submitted write; its witness must account for the result so
  an intentional revert is still effective.

## Considered alternatives

- **Whole-file overwrite for `replaceText()`.** It saves little merge code,
  since structured saves and sync still need that code, but an autosaving Source
  textarea would erase unrelated outside changes and reverse ADR-0622.
- **Only a source draft with conditional save.** It removes named intent and
  handoffs, but every outside edit to a file stops autosave and needs conflict
  resolution, including independent fields.
- **Only a source draft with content merge.** It cannot preserve an explicit
  field assignment equal to its earlier source value or show untouched outside
  fields during held input without reintroducing semantic intent.

## Open alternative: explicit outside-change conflicts

The current proposal retains automatic merging of independent outside changes.
A source-only draft that refuses its save whenever stored source differs from
its starting source is also under discussion. That could remove semantic
intent tracking, but an unrelated outside paragraph would then pause a title
save and require a compare, copy, reapply or explicit-replacement interaction.
The accepted draft would remain available; the earlier editing command would
not retroactively fail.

This alternative is not selected or implemented. Choosing it would replace
part of the current merge promise and require its recovery UI. Until then,
this ADR remains Proposed and current source keeps its existing merge rules.
