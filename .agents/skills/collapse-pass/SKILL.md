---
name: collapse-pass
description: Find and carry through worthwhile code simplifications across recent edits, named files, or a subsystem. Use when asked for a collapse pass, a refactoring pass, another simplification pass, "simplify this", to clean up code, or to hunt for indirection, dead abstractions, and redundant subsystems. Specific transformations, planning requests, review-only requests, and explicit file limits determine the work. Use control-flow for a request limited to one function's branching.
metadata:
  author: epicenter
  version: '1.0'
---

# Collapse pass

Start by establishing what the cleanup should make possible. Carry forward
agreed intent; clarify genuinely unresolved purposes and consequential tradeoffs.
Use that intent and actual use to identify the relevant system and develop a
coherent account of how it should work before choosing local transformations.

Be willing to reconsider current boundaries, ownership, and workflows. Trace
recurring complexity back to the choices that produced it, and consider whether
a different organizing idea would make several local fixes unnecessary. Use
[rethink](../rethink/SKILL.md) to develop that idea when needed. Let this
understanding determine the changes, then carry worthwhile simplifications
through implementation and verification. Scale investigation to the uncertainty;
a local edit can be the right result of considering the whole.

Read the relevant [refactoring methods](references/refactoring-methods.md)
for caller evidence, safe inlining, typed boundaries, or straggler cleanup.

## Start and expand the hunt

The requested outcome determines the work. A named transformation supplies the
candidate: perform and verify it without turning the request into an open-ended
hunt. Planning and proposal requests produce plans or proposals; review-only
requests produce findings without edits. A broad pass authorizes the hunt below.

Start with named files, recent edits, or the subsystem established in the
conversation. Treat that scope as a starting point unless the user explicitly
limits it. With no named target, infer the starting area from the conversation
and current changes; unrelated dirty files are not permission to edit them.

After implementation, inspect new helpers, components, callbacks, types, and
file splits as well as existing code. Trace actual callers, dependencies, and
neighboring implementations. Expand when those relationships reveal another
concrete opportunity, and explain the connection before editing beyond the
starting area. Respect instructions such as "only these files." Read external
callers to establish behavior, but defer a candidate if completing it requires
edits beyond that hard limit.

"Another pass" means pursue fresh candidates, including simplifications exposed
by the previous pass. Use prior findings and rejected candidates to choose new
searches rather than repeating the same diff review. Search for the same shape
in related code when an accepted simplification suggests a recurring pattern.
Revisit a rejected candidate when new evidence changes its justification. Move through the relevant subsystem
without requiring the user to nominate every next file.

An implementation pass authorizes routine simplifications within this scope.
Do not require a proposal approval for each edit. Stage, commit, push, or create
a PR only when authorized; when committing, keep each logical simplification
reviewable.

## PR and branch starting points

For a PR or branch, establish its comparison base from PR metadata, the upstream
tracking branch, or `origin/main`, then start with changed files and their callers.
Use an isolated worktree when switching targets would disturb the current
checkout. Never reset the user's active work. Report the checkout path and any
uncommitted edits at handoff. A request to review a PR remains read-only unless
implementation is authorized.

## Judge candidates by what disappears

For a broad pass, once you understand actual use, visibly inventory the nouns,
methods, properties, keys, and relationships someone must understand to use or
change the relevant system. Show where information lives, how responsibilities
connect, and which relationships require coordination. Ask which distinctions
carry independent information or behavior and whether the same job could use
fewer concepts or operations, including a different design that makes several
parts unnecessary together.
Name what flexibility a stronger ownership or lifetime rule removes and whether
actual users need it. Use the [concept inventory](references/concept-inventory.md)
to examine that surface through its owners and callers. A focused transformation
needs no subsystem inventory.

For expensive guarantees, establish who needs the promise and what would change
if it were narrowed, replaced, or removed. Verify how the replacement enforces
its rule for the actual writers, or name the overlap and loss it accepts. Show
the machinery eliminated and any user loss or obligation. Changes beyond
existing authorization remain proposals.

Look for forwarding layers, re-export chains, shallow aliases, shadow or
mirrored state, duplicated decisions, copied boundary shapes, derivable state,
dead exports, obsolete compatibility paths, and files that only pass work
elsewhere. These are candidates, not default fixes. Use
[code-audit](../code-audit/SKILL.md) when a proven search recipe fits.

Search the relevant subsystem literally for `registry`, `Map`, `Set`, `index`,
`flag`, `cache`, `pending`, and `retry`, including collection constructions and
named state. Treat these as symptoms to investigate. Establish what each
structure represents, then trace its writes, reads, and cleanup through actual
callers. Notice when each reader needs the answer and what it can observe
between updates.

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

When the same coordination recurs across owners, or a local fix only moves it
elsewhere, investigate the design choice producing it. Mentally inline the
affected layers and reconsider the system from its intended use. Use
[rethink](../rethink/SKILL.md) to develop the organizing model and derive its
concepts, operations, ownership, and guarantees. Trace callers and stored data
to establish the consequences and transition.

Search the affected path for `fallback`, `adapter`, `legacy`, `migration`, and
`compatibility`. A matching adapter or fallback may still own active recovery;
trace its consumers and stored data before removal. Applied migrations are
durable history, not disposable compatibility code. Keep a temporary
compatibility path only for a named consumer or migration, with a retirement
condition. Use
[clean breaks](../rethink/references/clean-breaks.md) to carry an authorized
replacement through its callers.

For Svelte surfaces, hunt custom binding protocols and mirrored input state. Use
[function bindings](../svelte/references/component-ui-patterns.md#function-bindings-for-transformed-values)
for wrapper boundaries and [input ownership](../svelte/references/input-ownership.md)
for drafts and submission. Trace the current owner before removing state or
guards.

**Look for opportunities to recompose capabilities, not only inline them.**
Trace how method namespaces, resources, and context are passed between layers.
Could binding context once, regrouping operations, or composing a focused adapter
remove repeated wiring or duplicated decisions? Show the resulting caller code
and where state, rules, and lifecycle would live.

For a local inlining, preserve the existing semantics. When redesigning the
model, make changed semantics explicit and verify the resulting caller
experience.

Keep a boundary when it names non-obvious work, enforces a shared rule, owns a
lifecycle, isolates unsafe input, or makes a long phase understandable. Caller
count alone does not decide.
A local that preserves type narrowing inside a deferred callback can earn its place even when it only reads a property; inspect its consumers before inlining it.
Use [one-sentence-test](../one-sentence-test/SKILL.md) when a file's purpose is
unclear, rather than forcing the exercise on every small change.

Every accepted change should remove an unnecessary concept, exported surface,
file, navigation hop, duplicated decision, or maintenance burden. Fewer lines
alone are insufficient. Do not manufacture changes to make a pass look productive.
If an edit fails this test on rereading, undo only that edit while preserving
unrelated and unsaved work.

Use [asymmetric-wins](../asymmetric-wins/SKILL.md) to develop the
tradeoff when refusing a small promise could delete a disproportionate code
family.

## Carry each finding through

Establish the starting state of target files so your changes remain
distinguishable from existing edits. Before editing, briefly name the unnecessary
complexity, why the proposed shape is better, and any material tradeoff. A routine
finding needs a short progress update, not a mandatory transcript template or
proposed diff.

Apply the change, inspect its callers, and run checks appropriate to the affected
behavior. Verify external library behavior against official docs or installed
types when correctness depends on it. When a simplification would reshape or
reimplement a library's public surface, read
[library refusal](references/library-refusal.md) first. Re-search removed or renamed symbols and
clean up stale imports, exports, comments, tests, and documentation as part of
the same logical change. Preserve coverage for behavior that remains; redundant
tests can be removed when retained coverage protects the same contract. Then use
what the change revealed to select the next candidate.

Finish with [post-implementation-review](../post-implementation-review/SKILL.md)
on the cumulative affected system. Verification failures must be resolved or
reported with evidence; do not attribute them to the baseline without checking.

## Protect load-bearing information

Read [durable contracts](references/durable-contracts.md) before editing affected
storage, sync, auth, or public-contract code, and verify its claims against
current source. Preserve stored data, unsaved input, and real consumer contracts.

Surface consequential changes that exceed the authorized outcome: product
behavior, durable formats, externally consumed contracts, or unresolved
ownership decisions. Existing authorization may already settle the decision;
do not ask again merely because files merge or an internal signature changes.
Preserve documented invariants when moving code instead of treating the presence
of JSDoc as a reason to pause.

## Finish a useful pass

Continue while grounded opportunities remain in the relevant subsystem. Stop
when further exploration yields no convincing simplifications, remaining changes
need a consequential decision from the user, or an explicit budget is reached.
A few unproductive files are evidence to change the search; they are not an
automatic stopping rule unless the user chose one. Resolve regressions introduced
by the pass before proceeding to unrelated candidates.

Report each logical simplification and its files, why it helped, what was
verified, and any meaningful remaining decision. For a broad pass, show the
inventory before and after, what disappeared, and why the remaining distinctions
matter. A review-only pass shows the proposed change. Mention important rejected
candidates when they prevent repeat work. Use
[report guidance](references/report-format.md) for a longer campaign; routine
passes need a concise result.

A plain "collapse pass" needs no goal, checkpoint count, or scope form. For a
sustained campaign, honor any explicit budget or commit preference. Use
[agent-goal](../agent-goal/SKILL.md) when asked to draft a goal.
