---
name: post-implementation-review
description: Reflect on what implementation revealed and carry a simpler design through the affected code. Use when finishing substantial implementation or refactoring, reviewing changes across callers or public APIs, after several implementation waves, or when asked for a second pass or final sweep. Independent review belongs to adversarial-review.
metadata:
  author: epicenter
  version: '2.0'
---

# Post-implementation review

After execution, reflect on what the implementation taught us. Knowing what we
know now, how would we shape the affected code if we were starting this work
again? Carry that understanding into the implementation.

Implementation proceeds through local decisions. Once the pieces work
together, we can see which decisions still earn their place and which created
work that can now disappear. Implementation can reveal an owner or invariant
that makes several local repairs unnecessary.

Start with the recent changes and examine the combined result of the task,
including earlier implementation waves. Follow affected callers and existing
boundaries when they help explain a simpler shape. Earlier implementation
choices, including your own, remain open to question.

Scale the reflection to the work. A small correction may need only a brief
reconsideration. A structural change deserves examination of the
responsibilities it brought together or divided. Keep the current shape when
its parts have clear jobs and the alternative introduces more work.

The current agent performs this review. It does not launch another agent
automatically. Use
[adversarial-review](../adversarial-review/SKILL.md) when independent judgment is
requested or a selected workflow calls for it. If you are already a delegated
reviewer, apply these checks yourself and return findings without launching
more reviewers.

## Reflect on the implemented result

Revisit the requested outcome, the task-start baseline, and the cumulative
changes. Read the affected entrypoints, owners, callers, and relevant tests.
Load the focused skill for the touched surface, such as `testing`,
`typescript`, or `svelte`.

Look at the decisions made during execution. What became clearer about where
information belongs, when work happens, and which parts need to know about
each other? A workaround or repeated repair may expose a division of
responsibility worth changing.

For example, a rename feature might accumulate a saved name, a sidebar copy,
and a callback keeping them synchronized. The sidebar can read the saved name
directly. The edit field still needs its unfinished draft. The collapse
removes coordination while preserving the two responsibilities: saved
information and unfinished input.

Use observations from the code and callers to distinguish a discovered
constraint from an assumption made during implementation. Follow connected
evidence beyond the edited code when it reveals a shared cause. Respect
explicit file limits and keep the investigation connected to the task.

## Develop the simpler shape

Ask what earlier choice makes several pieces necessary, and what would let
them collapse together. Look for duplicated state and its synchronization,
repeated decisions, forwarding layers, and rules checked downstream that an
earlier owner could guarantee once. Consider the fixes already made as part
of the design being reconsidered.

Develop the alternative through actual callers. Establish who owns runtime
lifetime, durable state, unfinished input, and user-visible state. Before
removing an owner or protection, name who preserves the information and
guarantees it carried. Distinguish a wrong name, a wrong owner, and an
unnecessary boundary; they call for different repairs.

Mentally inline helpers, wrappers, components, and aliases where that makes
their responsibilities visible. Keep a boundary when it names non-obvious
work, enforces a shared rule, owns a lifecycle, isolates unsafe input,
preserves a consumer contract, or explains a long phase. Caller count and
line count alone do not decide. Use
[refactoring methods](../collapse-pass/references/refactoring-methods.md)
for caller evidence and safe inlining.

When an ownership, lifecycle, API, or package-boundary question remains
unresolved, or several repairs look like patches on one underlying problem,
reason through it with [rethink](../rethink/SKILL.md). Use the
[concept inventory](../collapse-pass/references/concept-inventory.md) when
listing the current and proposed concepts would help judge the structure.
A question the implementation already settles soundly needs no separate pass.

Judge the complete arrangement, including any work moved into callers. Keep
necessary parsing and validation, real consumer contracts, and repetition
that costs less than the abstraction replacing it. Fewer lines alone do not
justify an edit.

## Carry the collapse through

Carry grounded simplifications through the affected code and callers within
the authorized outcome. Explain consequential structural changes and their
consequences before editing, then proceed within existing authorization.
Summarize routine corrections afterward. Fix correctness and invariant issues
revealed by the review too. Authorship alone does not decide scope.

Explain the caller evidence connecting a change beyond the starting files to
the task before editing. Respect explicit file limits. Report speculative,
cosmetic, or taste-only cleanup rather than widening the task for it. Bring
changes to product direction, destructive actions, and unresolved ownership
or contract decisions beyond existing authorization back to the user before
proceeding with them.

Remove superseded exports, forwarding paths, comments, tests, and
documentation with their replacement. For an authorized clean break, update
callers and examples to the new API. Retire an old API or compatibility path
only after tracing active callers and stored data and establishing that the
replacement preserves them or includes their migration.

Preserve unrelated edits, stored data, unfinished input, and coverage for
behavior that remains. A review-only request returns findings and proposed
repairs without edits.

## Verify the result

Trace behavior from the affected entrypoints through actual callers. Check
the requested outcome and look for regressions, changed evaluation timing,
receiver binding, caching, and snapshot semantics. Run checks appropriate to
the changed behavior.

Read the resulting API and file layout from a caller's perspective. Names
should describe current behavior, and Go to Definition should lead to the
source of truth; see [typescript](../typescript/SKILL.md) for navigation
guidance. Search for removed or renamed symbols and stale imports, exports,
tests, and documentation.

For a change people see or use, check it running as
[ui-design's verification reference](../ui-design/references/verification.md)
describes; desktop-targeted behavior is checked in the native desktop app. A
backend-only change needs its behavioral checks, not screenshots.

Use the task-start baseline or an agreed review baseline to investigate
failures. Current HEAD may already include earlier task changes, so reproducing
there does not establish that a failure predates the task. Use a separate
checkout when needed to reproduce without disturbing the user's work. Report
unverified attribution as uncertain.

After repairs, reread the combined result and its callers. Would you choose
these parts and this division of responsibility knowing what you know now?
Follow a further grounded collapse when the repair reveals one. Repeat
checks when a new edit, failure, or unresolved concern warrants it; do not
repeat completed checks merely to complete another named pass.

Finish when no convincing collapse or grounded issue remains within scope,
or when the remaining work needs a consequential decision from the user.

## Explain what changed

For a meaningful collapse, explain what the implementation revealed, what
became unnecessary, and how the resulting arrangement carries the work. Show
an API example or before-and-after ownership or file layout when it helps
the user judge the change. No formal lesson or fixed report layout is required.

For findings, identify the file and line, observable consequence, and proposed
repair. For completed repairs, explain what verified them. Include a short
scope statement and place material limitations or unresolved decisions beside
the claims they affect, even when no issues were found.

If the review finds no useful collapse or grounded issue, say so without
manufacturing cleanup.
