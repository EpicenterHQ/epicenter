---
name: collapse-pass
description: Find and carry through worthwhile code simplifications across recent edits, named files, or a subsystem. Use for a collapse pass, a refactoring pass, another simplification pass, "simplify this", clean up code, or a hunt for indirection and dead abstractions. Specific transformations, planning requests, review-only requests, and explicit file limits determine the work. Use control-flow for a request limited to one function's branching.
metadata:
  author: epicenter
  version: '1.0'
---

# Collapse pass

A collapse pass actively finds and removes complexity that does not earn its
place. Ask whether the system could do the same job with a simpler model, then
carry worthwhile changes through implementation and verification. Read the
relevant [refactoring methods](references/refactoring-methods.md)
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

For a broad pass, once you understand actual use, visibly list and explain the
methods, concepts, and relationships someone must understand. Ask whether the
same job could be done with fewer concepts, including a different design that
makes several parts unnecessary together. Replace unnecessary flexibility with
stronger invariants: ask whether ownership and lifetime can determine
relationships the code currently has to coordinate. Use the
[concept inventory](references/concept-inventory.md) to examine the nouns and
their relationships. A focused transformation needs no subsystem inventory.

Look for forwarding layers, re-export chains, shallow aliases, shadow or
mirrored state, duplicated decisions, copied boundary shapes, derivable state,
dead exports, obsolete compatibility paths, and files that only pass work
elsewhere. These are candidates, not default fixes. Use
[code-audit](../code-audit/SKILL.md) when a proven search recipe fits.

Hunt for synchronization obligations. Within the relevant subsystem, search
literally for `registry`, `Map`, `Set`, `index`, `flag`, `cache`, `pending`, and
`retry`, including collection constructions and named state. Trace their writes,
reads, cleanup, and any observable gap between updates. Ask whether readers can
derive the answer from another source or ask its owner directly. When an owner
hand-builds a transition loop, search its distinctive state and operation names
in related owners. Count the coordination or repeated decisions eliminated,
not the collections deleted. A computed key alone does not make membership,
authorization, selection, in-flight work, or unsaved input derivable.

When replacement is within scope, prefer a clean break: move callers to one
current path and delete the superseded one. Search the affected path for
`fallback`, `adapter`, `legacy`, `migration`, and `compatibility`. A matching
adapter or fallback may still own active recovery; trace its consumers and
stored data before removal. Applied migrations are durable history, not
disposable compatibility code. Keep a temporary compatibility path only for a
named consumer or migration, with a retirement condition. Use
[clean breaks](../rethink/references/clean-breaks.md) to carry an authorized
replacement through its callers.

For Svelte input wrappers, hunt paired `read`/`write`, `getValue`/`setValue`,
and forwarding value-change props that recreate the binding protocol. Use
[Svelte function bindings](../svelte/references/component-ui-patterns.md#function-bindings-for-transformed-values)
when one bindable value removes that custom API. Trace transformations and
lifecycle guards before collapsing them; commands and draft ownership may earn
their boundaries.

For input consumers, distinguish
[immediate editing from explicit submission](../svelte/references/input-ownership.md).
Immediate controls read the current editor and submit replacements. Explicit
forms own unfinished input, preferably one replace-only raw draft object for
fields submitted together. Single values and intentionally mutable proxied forms are
valid when they fit the interaction; rune count is not the target. Hunt mirrored
editor values, effect-driven synchronization, parallel draft/payload copies,
unnecessary snapshot or clone layers, raw-state property mutation, and late
results that erase newer typing. Classify search matches before changing them.

For file editor consumers, selection determines purpose: Files edits full text,
product lists edit structured records, and invalid files have a repair route.
Hunt per-record Source tabs, raw-mode admission, duplicated selection and
selected-tab conditions inside shared `Tabs.Content`. Follow
[the Svelte editor ownership patterns](../svelte/references/component-ui-patterns.md#file-editor-views).
Use shared `Input` and `Textarea` retirement rather than forwarding wrappers.
Keep genuine unfinished forms, accepted-content owners, path-operation facts,
edit identities and rich-widget history. Remove an owner only after naming who
will preserve its information.

Trace callers and mentally inline the candidate. Preserve evaluation timing,
receiver binding, caching, and snapshot semantics when inlining. Keep a boundary when it names
non-obvious work, enforces a shared rule, owns a lifecycle, isolates unsafe input,
or makes a long phase understandable. Caller count alone does not decide.
Use [one-sentence-test](../one-sentence-test/SKILL.md) when a file's purpose is
unclear, rather than forcing the exercise on every small change.

Every accepted change should remove an unnecessary concept, exported surface,
file, navigation hop, duplicated decision, or maintenance burden. Fewer lines
alone are insufficient. Do not manufacture changes to make a pass look productive.
If an edit fails this test on rereading, undo only that edit while preserving
unrelated and unsaved work.

When a library refuses the proposed model, treat that as evidence about the
model. Do not reimplement its public surface to make the simplification work.
Read [library refusal](references/library-refusal.md) for this situation.
Use [rethink](../rethink/SKILL.md) for ownership, lifecycle, API, or package-boundary
decisions. Use [asymmetric-wins](../asymmetric-wins/SKILL.md) when refusing a small
promise would delete a disproportionate code family; name the promise and
establish whether the user's authorization covers changing it.

## Carry each finding through

Establish the starting state of target files so your changes remain
distinguishable from existing edits. Before editing, briefly name the unnecessary
complexity, why the proposed shape is better, and any material tradeoff. A routine
finding needs a short progress update, not a mandatory transcript template or
proposed diff.

Apply the change, inspect its callers, and run checks appropriate to the affected
behavior. Verify external library behavior against official docs or installed
types when correctness depends on it. Re-search removed or renamed symbols and
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
For file-authoritative recovery or consistency machinery, establish the visible
repair path using [repairability](../rethink/references/repairability.md) before
removing a protection.

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
methods, concepts, and relationships before and after, what disappeared, and
why the remaining distinctions matter. A review-only pass shows the proposed
change. Mention important rejected candidates when they prevent repeat work. Use
[report guidance](references/report-format.md) for a longer campaign; routine
passes need a concise result.

A plain "collapse pass" needs no goal, checkpoint count, or scope form. For a
sustained campaign, honor any explicit budget or commit preference. Use
[agent-goal](../agent-goal/SKILL.md) when asked to draft a goal.
