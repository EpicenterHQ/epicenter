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

The pass simplifies the system's model by finding and removing complexity that
does not earn its place. Question the current concepts and promises as well as
their implementation.

## Understand the work

Start from what the person or caller needs to accomplish. Read the relevant
code and follow its callers to understand where the work has become difficult.
Use intent already settled in the conversation; ask when an unresolved purpose
or tradeoff would change the work.

Begin with the named files or subsystem. Follow connected evidence when it
points to a shared cause, and explain the connection before editing beyond the
starting area. Respect explicit file limits and preserve unrelated work. A named
transformation stays focused; review and proposal requests remain read-only.

With no named target, infer the starting area from the conversation and current
changes; unrelated dirty files are not permission to edit them. A named
transformation supplies the candidate: perform and verify it without turning
the request into an open-ended hunt. Planning and proposal requests produce
plans or proposals.

Read external callers to establish behavior, but defer a candidate if completing
it requires edits beyond an explicit file limit.

## PR and branch starting points

For a PR or branch, establish its comparison base from PR metadata, the upstream
tracking branch, or `origin/main`, then start with changed files and their
callers. Use an isolated worktree when switching targets would disturb the
current checkout. Never reset the user's active work. Report the checkout path
and any uncommitted edits at handoff. A request to review a PR remains read-only
unless implementation is authorized.

## Hunt for concrete symptoms

Hunt for synchronization obligations.

Search the relevant subsystem literally for `registry`, `Map`, `Set`, `index`,
`flag`, `cache`, `pending`, and `retry`, including collection constructions and
named state. Treat these as symptoms to investigate. Establish what each
structure represents, then trace its writes, reads, and cleanup through actual
callers. Notice when each reader needs the answer and what it can observe
between updates.

Trace when readers need each value and how long it must remain available. Keep
historical decisions and uncertain outcomes when current state cannot
reconstruct them. Before removing a guard or relying on it, establish what it
compares and whether that information is current, cached, or authoritative.

When an owner hand-builds a transition loop, search its distinctive state and
operation names in related owners. A computed key alone does not make
membership, authorization, selection, in-flight work, or unsaved input derivable.

Also look for forwarding layers, re-export chains, shallow aliases, mirrored
state, duplicated decisions, copied boundary shapes, dead exports, and rules
that acquire another exception for each new case. Search for `fallback`,
`adapter`, `legacy`, `migration`, and `compatibility`. Use
[code-audit](../code-audit/SKILL.md) when a proven search recipe fits.

Include shadow or mirrored state, derivable state, obsolete compatibility
paths, and files that only pass work elsewhere. These are candidates, not
default fixes. For Svelte surfaces, hunt custom binding protocols and mirrored
input state; use [function bindings](../svelte/references/component-ui-patterns.md#function-bindings-for-transformed-values)
and [input ownership](../svelte/references/input-ownership.md) to trace their
actual owners before removing state or guards.

Include the fixes already made. A new helper, branch, or recovery path may
solve the immediate problem while exposing a problem in the larger design.
One revealing workaround can justify zooming out; recurrence supplies more
evidence.

Group related symptoms around the responsibility or decision producing them.
A broad pass investigates those connections before treating every occurrence
as a separate cleanup.

## Rethink the design producing the work

Trace each mechanism to the requirement, assumption, or promise that makes it
necessary. Check which requirements come from the person or actual consumers,
and which arose from the implementation. Existing behavior alone does not
establish that someone needs it.

Use [rethink](../rethink/SKILL.md) to consider how we would build this today for
its intended uses. Treat existing APIs, boundaries, ownership, and workflows
as choices to reconsider. Ask what would let the machinery disappear.

Mentally inline the affected layers and reconsider the resulting flow from
scratch. When should work happen? Who should own its lifetime? Are caching,
snapshots, callbacks, or repeated checks still necessary, or could different
ownership make them disappear together?

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
or recovery subsystem. Follow the alternative far enough to show how it handles
the actual uses and what becomes unnecessary, then compare the complete result.

Look for opportunities to recompose capabilities, not only inline them. Trace
how method namespaces, resources, and context are passed between layers. Could
binding context once, regrouping operations, or composing a focused adapter
remove repeated wiring or duplicated decisions? Show the resulting caller code
and where state, rules, and lifecycle would live.

Use [product-collapse](../product-collapse/SKILL.md) when simpler product behavior
could make machinery unnecessary and the experience needs the person's judgment.

Ask which complexity is inherited from an earlier version of the idea.
Establish what still depends on it today. Removing machinery whose purpose and
consumers have disappeared need not sacrifice capability. Refusing a live
promise is a different decision: name what the person loses and use
[asymmetric-wins](../asymmetric-wins/SKILL.md) when a small refusal could remove
a disproportionate code family.

For expensive guarantees, establish who needs the promise and what would change
if it were narrowed, replaced, or removed. Verify how the replacement enforces
its rule for the actual writers, or name the overlap and loss it accepts.
Changes beyond existing authorization remain proposals.

Show the proposed model through realistic caller code, an interaction, or a
data flow. Use the [concept inventory](references/concept-inventory.md) when
making the current and proposed responsibilities visible helps judge the
change. Explain where information lives, which rules the owners enforce, and
what coordination disappears.

Take the model back to the cases that produced it, including awkward and
materially different uses. When exceptions keep accumulating, reconsider the
organizing distinction. Preserve differences that carry real information or
behavior. A local correction is sufficient when the surrounding model earns
its complexity; a broader redesign needs evidence that it better fulfills
the intent.

Scale investigation to the uncertainty; a local edit can be the right result
of considering the whole.

Keep a boundary when it names non-obvious work, enforces a shared rule, owns a
lifecycle, isolates unsafe input, or makes a long phase understandable. Caller
count alone does not decide. A local that preserves type narrowing inside a
deferred callback can earn its place even when it only reads a property; inspect
its consumers before inlining it. See the [Svelte template-local examples](../svelte/references/component-ui-patterns.md#template-locals-narrow-reactive-values-before-use).
Use [one-sentence-test](../one-sentence-test/SKILL.md) when a file's purpose is
unclear, rather than forcing the exercise on every small change.

For a local inlining, preserve the existing semantics. When redesigning the
model, make changed semantics explicit and verify the resulting caller
experience.

Every accepted change should remove unnecessary complexity or put a
responsibility with an owner that can enforce its rule or manage its lifetime.
Name the gain: a concept, exported surface, file, navigation hop, duplicated
decision, or maintenance burden disappears, or the new owner can enforce a
rule or manage a lifetime directly. Fewer lines alone are insufficient.
Account for obligations introduced as well as removed:
deleting a file does not simplify the system if its responsibility is now
distributed across callers. If an edit fails this test on rereading, undo only
that edit while preserving unrelated and unsaved work.

## Carry the replacement through and verify it

Establish the starting state so the work remains distinguishable from existing
edits. Briefly explain the cause, the replacement, what becomes unnecessary,
and any material tradeoff.

An implementation pass authorizes routine simplifications within this scope.
Do not require a proposal approval for each edit. A routine finding needs a
short progress update, not a mandatory transcript template or proposed diff.

Surface consequential changes that exceed the authorized outcome: product
behavior, durable formats, externally consumed contracts, or unresolved
ownership decisions. Existing authorization may already settle the decision;
do not ask again merely because files merge or an internal signature changes.
Preserve documented invariants when moving code instead of treating the
presence of JSDoc as a reason to pause.

Implement the connected change through its consumers. Moving a guarantee must
not leave an old path that silently loses it. Use
[clean breaks](../rethink/references/clean-breaks.md) to retire superseded
paths. Keep temporary compatibility only for a named consumer or migration,
with a retirement condition.

A matching adapter or fallback may still own active recovery; trace its
consumers and stored data before removal.

Preserve stored data, unfinished input, unrelated work, and real consumer
contracts. Applied migrations remain durable history. Read
[durable contracts](references/durable-contracts.md) when the change touches
storage, sync, auth, or public contracts, and verify its claims against current
source.

Applied migrations are durable history, not disposable compatibility code.

Use [refactoring methods](references/refactoring-methods.md) for local
mechanics and straggler cleanup. Verify external library behavior against
official documentation or installed types when correctness depends on it.
Read [library refusal](references/library-refusal.md) before reshaping or
reimplementing a library's public surface.

Run checks appropriate to the changed behavior. Remove obsolete references,
exports, comments, tests, and documentation with the replacement. Preserve
coverage for behavior that remains. Review the cumulative result with
[post-implementation-review](../post-implementation-review/SKILL.md).

Redundant tests can be removed when retained coverage protects the same
contract. Verification failures must be resolved or reported with evidence;
do not attribute them to the baseline without checking. Resolve regressions
introduced by the pass before proceeding to unrelated candidates.

After a fix works, reconsider the cumulative design as if the latest constraints
had been known from the beginning. Check whether we would choose its boundaries
and responsibilities today, including those introduced by previous fixes.
"Another pass" starts from that reassessment: earlier implementation decisions
remain open to question, while settled user intent carries forward. Use fresh
evidence, including new coordination or exceptions, to revisit the model.

Use prior findings and rejected candidates to choose new searches rather than
repeating the same diff review. Revisit a rejected candidate when new evidence
changes its justification. Move through the relevant subsystem without
requiring the user to nominate every next file.

Continue while grounded opportunities remain in the relevant subsystem. Stop
when further investigation yields no convincing simplification, remaining work
needs a consequential decision, or an explicit budget is reached. Do not
manufacture changes to make a pass look productive.

A few unproductive files are evidence to change the search; they are not an
automatic stopping rule unless the user chose one.

Report the cause, the replacement, what disappeared, what was verified, and
remaining decisions. Use [report guidance](references/report-format.md) for a
longer campaign. Stage, commit, push, or create a PR only when authorized.

A plain "collapse pass" needs no goal, checkpoint count, or scope form. For a
sustained campaign, honor any explicit budget or commit preference. Use
[agent-goal](../agent-goal/SKILL.md) when asked to draft a goal. Routine passes
need a concise result that shows the concrete simplifications, their purpose,
verification, and any remaining consequential decision.
