---
name: collapse-pass
description: Investigate concrete complexity, rethink the design producing it, and carry coherent simplifications through implementation and verification. Use when asked for a collapse pass, a refactoring or simplification pass, another pass, "simplify this", to clean up code, or to hunt for indirection, dead abstractions, and redundant subsystems. Specific transformations, planning requests, review-only requests, and explicit file limits determine the work. Use control-flow for a request limited to one function's branching.
metadata:
  author: epicenter
  version: '2.0'
---

# Collapse pass

A collapse pass looks for a simpler way for the system to do its job. Use
redundant state, repeated subsystems, exceptions, and workarounds to find the
design choices creating unnecessary work. Ask what would let that machinery
disappear, then carry the better design through its callers.

## Understand the work

Read the relevant code and follow its callers to understand what the person or
caller needs to do, where the work has become difficult, and which parts of the
current arrangement cause that difficulty. Use intent already settled in the
conversation; ask when an unresolved purpose or tradeoff would change the work.

Begin with the named files or subsystem. Follow connected evidence when it
points to a shared cause, and explain the connection before editing beyond the
starting area. Respect explicit file limits and preserve unrelated work. A named
transformation stays focused; review and proposal requests remain read-only.

## Hunt for concrete symptoms

Search the relevant subsystem literally for `registry`, `Map`, `Set`, `index`,
`flag`, `cache`, `pending`, and `retry`, including collection constructions and
named state. Treat these as symptoms to investigate. Establish what each
structure represents, then trace its writes, reads, and cleanup through actual
callers. Notice when each reader needs the answer and what it can observe
between updates.

Also look for forwarding layers, re-export chains, shallow aliases, mirrored
state, duplicated decisions, copied boundary shapes, dead exports, and rules
that acquire another exception for each new case. Search for `fallback`,
`adapter`, `legacy`, `migration`, and `compatibility`. Use
[code-audit](../code-audit/SKILL.md) when a proven search recipe fits.

Include the fixes already made. A new helper, branch, or recovery path may
solve the immediate problem while exposing a problem in the larger design.
One revealing workaround can justify zooming out; recurrence supplies more
evidence.

Group related symptoms around the responsibility or decision producing them.
A broad pass investigates those connections before treating every occurrence
as a separate cleanup.

## Rethink the design producing them

Use [rethink](../rethink/SKILL.md) to develop the system from its intended use.
Treat existing APIs, boundaries, ownership, and workflows as choices to
reconsider. Trace each mechanism to the requirement, assumption, or promise
that makes it necessary.

Ask whether readers could get the answer from an existing owner when they need
it. If a Map mirrors connections a pool already tracks, reading the pool may
remove the Map and its add/delete bookkeeping together. If the Map records a
selection someone made, it may already be the owner of that information. Keep
state that carries an independent fact.

Then consider whether a different owner or lifetime would make the coordination
unnecessary. Develop that alternative far enough to show what disappears and
how the remaining owners preserve the required behavior. Count the coordination
eliminated, not the collections deleted. Search related code for the same
pattern.

Look beyond relocating state. A rule might be declared directly at the boundary
that knows it instead of inferred elsewhere. Responsibilities might be grouped
around the work people do. A simpler workflow might eliminate an entire draft
or recovery subsystem. Search for what would let each mechanism disappear,
then compare the complete result.

Ask which complexity is inherited from an earlier version of the idea.
Establish what still depends on it today. Removing machinery whose purpose and
consumers have disappeared need not sacrifice capability. Refusing a live
promise is a different decision: name what the person loses and use
[asymmetric-wins](../asymmetric-wins/SKILL.md) when a small refusal could remove
a disproportionate code family.

Show the proposed model through realistic caller code, an interaction, or a
data flow. Use the [concept inventory](references/concept-inventory.md) when
making the current and proposed responsibilities visible helps judge the
change. Explain where information lives, which rules the owners enforce, and
what coordination disappears.

Take the model back to the cases that produced it, including awkward and
materially different uses. When exceptions keep accumulating, reconsider the
organizing distinction. Preserve differences that carry real information or
behavior. Keeping the current design is a valid outcome when its boundaries
earn their cost.

## Carry the replacement through and verify it

Establish the starting state so the work remains distinguishable from existing
edits. Briefly explain the cause, the replacement, what becomes unnecessary,
and any material tradeoff.

Implement the connected change through its consumers. Moving a guarantee must
not leave an old path that silently loses it. Use
[clean breaks](../rethink/references/clean-breaks.md) to retire superseded
paths. Keep temporary compatibility only for a named consumer or migration,
with a retirement condition.

Preserve stored data, unfinished input, unrelated work, and real consumer
contracts. Applied migrations remain durable history. Read
[durable contracts](references/durable-contracts.md) when the change touches
storage, sync, auth, or public contracts, and verify its claims against current
source.

Use [refactoring methods](references/refactoring-methods.md) for local
mechanics and straggler cleanup. Verify external library behavior against
official documentation or installed types when correctness depends on it.
Read [library refusal](references/library-refusal.md) before reshaping or
reimplementing a library's public surface.

Run checks appropriate to the changed behavior. Remove obsolete references,
exports, comments, tests, and documentation with the replacement. Preserve
coverage for behavior that remains. Review the cumulative result with
[post-implementation-review](../post-implementation-review/SKILL.md).

After a fix works, reconsider the owning unit as if the latest constraint had
been known from the beginning. Check that the resulting design is one we would
choose today. If implementation introduces more coordination or exceptions,
use that evidence to revisit the model.

Continue while grounded opportunities remain in the relevant subsystem.
"Another pass" pursues fresh evidence, including what the previous replacement
exposed. Stop when further investigation yields no convincing simplification,
remaining work needs a consequential decision, or an explicit budget is reached.
Do not manufacture changes to make a pass look productive.

Report the cause, the replacement, what disappeared, what was verified, and
remaining decisions. Use [report guidance](references/report-format.md) for a
longer campaign. Stage, commit, push, or create a PR only when authorized.
