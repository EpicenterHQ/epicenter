# Bounded edit intent across save outcomes

Date: 2026-10-21. Runtime: Bun 1.4.3.

This records the first, semantic-only experiment. The subsequent
[exact-source and storage comparison](STORAGE-RESULTS.md) extends it and describes
the bounded representation applied to production.

The bounded model matched a retained-command-history oracle in **733,102
comparisons**, including successful saves, failed saves, repeated failures,
and a second save with new source/form input. This supports a bounded semantic
reducer; it does not establish a complete replacement for `edit-owner.ts`.

## What was compared

The candidate incrementally keeps one entry per touched field and one body
witness. Each field entry retains its initial value, final value, whether it is
a named assignment, and its last assignment occurrence. Body edits retain the
first editing witness and the final body. Source actions update changed units,
retaining earlier effects where the supplied source still expresses them.

During a save, it maintains two bounded continuations: all unacknowledged input
if the save fails, and only later input if it succeeds. Receipt handling selects
the appropriate continuation. A frozen submission remains available separately.
The candidate retains no command list.

The oracle keeps accepted commands with their before/after values and explicit
assignment keys. For each unit it retrospectively finds the first affecting
command, last affecting command, and assignment authority. It then removes the
exact submitted command prefix on success, or retains it on failure. Its history
queries do not call the candidate's incremental reducer.

Both models share the semantic merge specification. They use the production
line-region merger for bodies. This checks compaction against that specification,
not whether the specification captures every Markdown editing requirement.

## Inputs and results

- Ten actions: title assignments, same-value assignments, field removal,
  body replacements and reversions, and whole-source edits to fields and body.
- Every two-command prefix and every zero-to-three-command tail, under both
  save outcomes: 222,200 first-outcome schedules. Each also checks submission
  compaction; failed schedules additionally check retry without acknowledgment.
- 177,600 second-outcome comparisons cover new input after the first result,
  source/form crossings in both orders, and both second-save outcomes.
- Two additional comparisons retain a 20,000-command in-flight tail under
  success and failure. Candidate state stays at at most two field entries and
  one body witness per continuation. Text sizes and the number of distinct
  touched fields remain part of the memory cost.
- No mismatches. Both deliberately broken negative controls were detected:
  value-based field acknowledgment and unconditional replacement of an editing
  witness by the actual stored result.

The title-revert sequence exposes why the continuations differ. Start at `Old`,
submit `Mine`, then type source containing `Old` and a local body addition while
an outside writer changes independent content. If submission succeeds, `Old`
is a revert from `Mine`. If submission fails, the unsaved source change returns
to its original `Old`, so it need not undo an outside title. Both outcomes retain
the independent outside body changes and local addition. The concrete values
are in [results.json](results.json).

## Production repair and validation

The current document-input acknowledgment cleared a field whenever its value
equaled the submitted value, including a later accepted assignment. It now
compares per-field assignment revisions and clears only submitted occurrences.
The revision map is pruned as assignments are acknowledged. Existing body and
source witnesses and storage validation remain in place.

Two new real-browser-storage regressions delay a successful receipt, allow an
outside write, and accept a later equal assignment. They cover setting a title
and removing it. Each failed before the repair and passed afterward. They also
check that a different field, not assigned again, is not written again.

The complete Folder suite passed: 752 tests, 3,149 assertions. Package type
checking passed. At this first stage, no bounded-reducer rewrite was applied to
production.

## Limits of this first stage

The generated model covers valid document values with string fields and known
bodies. It does not model exact source presentation, YAML comments or aliases,
BOM/newline preservation, malformed or binary source, schema failures,
unrepresentable pending input, or guarded storage retries and read ordering.
The production regressions cross the actual IndexedDB/handle boundary; the
generated schedules simulate persistence and receipt outcomes in memory.

Keep ADR-0666's behavioral requirements. A bounded reducer is a supported
implementation direction in this domain, provided it retains assignment
occurrences and outcome-dependent witnesses. The subsequent comparison covers
the omitted source/recovery cases and actual storage boundary for a fixed corpus.
Passing these generated traces is not a proof of closure for arbitrary Markdown.

## Reproduce

The throwaway source is archived as [source.ts.gz](source.ts.gz), with the runnable
prototype removed from `src`. From `packages/folder`, using Bun:

```sh
gzip -dc evidence/edit-reducer/source.ts.gz > src/edit-reducer.prototype.ts
bun src/edit-reducer.prototype.ts
rm src/edit-reducer.prototype.ts
```
