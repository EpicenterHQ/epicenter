---
name: greenfield-clean-breaks
description: Reconsider a system from a clean-slate target and identify legacy or compatibility paths to delete. Use when evaluating a greenfield redesign, clean break, no users, or removal of old behavior.
---

# Greenfield Clean Breaks

Use this skill as an operating mode, not a cleanup checklist. Start with the uncompromised greenfield vision, then work backward to the deletion waves, owner changes, and verification needed to make that vision real. The current software is evidence, not a constraint. Previously resolved decisions can be reopened when they make the final system harder to explain, own, test, or delete.

When the desired direction is still unsettled, use
[dialectic](../dialectic/SKILL.md) to work it through. Understanding how the
current system works does not itself settle a decision to redesign it. Once
the user has settled the desired behavior, start there; no formal destination
artifact or additional interview is required. This skill owns planning backward
from that direction and carrying out authorized changes. Implementation
difficulty does not reopen the direction. If a new fact changes what is
possible or what the user wants, bring that question back to the conversation.

Two pillars:

```txt
Greenfield  Any software decision can be revised, including APIs, package
            boundaries, storage shapes, UI flows, names, dependencies, and
            prior architecture decisions.

Clean break Old callers, old shapes, old names, and old branches are deleted by
            default. Compatibility, aliases, fallback readers, and migration
            bridges are not design inputs unless the user explicitly stops the
            break.
```

The job:

```txt
State the uncompromised product sentence.
Describe the final shape as if there were no inherited constraints.
Work backward from that vision to deletion waves, owner changes, and blockers.
Reopen inherited decisions that do not serve the final shape.
Gather enough context to challenge the boundary.
Trace definitions and callers upward.
Mentally inline suspicious abstractions.
Find the small refusals that delete large code families.
Move each invariant to one owner.
Replace old paths cleanly.
Prove the new path before deleting the old one.
```

## References

Load on demand:

- If planning a **multi-wave replacement, rollback point, or old-path deletion**, read [references/wave-ordering.md](references/wave-ordering.md).
- If drafting a **`/goal` for a greenfield or no-compatibility pass**, read [references/goal-template.md](references/goal-template.md).

## Operating Stance

Be direct about weak architecture. Do not preserve a shape because it already exists, because tests encode it, because a helper hides it, or because a prior spec once chose it.

Treat ADRs, specs, docs, and existing code as context with different weights:

```txt
ADR or durable doc    strong evidence; may still be challenged explicitly
current code          evidence of behavior and coupling
tests                 evidence of expected behavior, not proof of good shape
spec                  in-flight scaffold, not current truth
helper abstraction    a hypothesis about ownership, not a fact
```

If the greenfield answer conflicts with an ADR or public promise, surface that as a decision to amend, not as a reason to stop thinking.

Uncompromising does not mean careless. Hold the ideal shape steady while you work backward through reality. If a durable public or data promise appears, stop and ask instead of quietly designing around the old shape.

## Context Gathering

Before proposing a clean break, gather enough context to make the refusal defensible.

Run this before editing:

```txt
1. Read the narrow target.
2. Trace definitions upward: who calls it, exports it, wraps it, configures it,
   persists it, or documents it?
3. Trace values downward: who creates, mutates, repairs, caches, serializes, or
   interprets each important value?
4. Count callers and imports with rg.
5. Read the nearest tests, examples, docs, ADRs, and specs that claim the
   boundary.
6. Use subagents when available for independent context questions, especially
   caller maps, ownership maps, stale-decision searches, and forward-tests of a
   proposed clean break. Keep each subagent question bounded and pass raw
   artifacts, not conclusions.
7. If subagents are unavailable, simulate the same separation locally: write the
   question, read only the needed files, and report the evidence.
```

Evidence should name files or symbols. "Seems internal" is not evidence; caller counts, exports, routes, schema files, docs, tests, and persisted or wire shapes are evidence.

Do not let context gathering become permission seeking. The goal is to find where to break cleanly, not to rationalize every existing branch.

## Greenfield Vision First

Do not begin by patching the current shape. First describe the system you would build if the old API, files, tests, names, and migration paths did not exist. That vision is the anchor; implementation planning works backward from it.

If the conversation already settled the direction, adopt it rather than
repeating discovery. Clarify implementation details within that direction;
surface a material change instead of quietly replacing the user's decision.

Begin with its accepted destination sentence. If none was supplied, write the
ideal sentence first:

```txt
<noun> owns <boundary>; <caller> enters through <single path>; <runtime> does <one job>.
```

Then write the model in plain terms:

```txt
Uncompromised vision:
  What would the final system look like with no inherited constraints?

Product promise:
  What must remain true for the user?

Backward path:
  What must be deleted, moved, renamed, replaced, or verified to reach the vision?

Single owner:
  Which layer owns the value, invariant, or lifecycle?

Single entry:
  Where does the caller enter?

Single representation:
  What is the canonical shape on disk, on wire, or in memory?

Deletion prize:
  What code disappears if this model wins?

Recognition test:
  What observable facts would prove this destination exists, and what would
  clearly violate it?
```

If the sentence needs "or", "also", "legacy", "fallback", "compat", "unless", or "for old callers", the design is probably keeping two systems alive.

## Trace And Inline Pass

Mentally inline suspicious boundaries before accepting them.

```txt
For each wrapper/helper/service/type:
  What exact work does it do?
  What would the caller look like if this were inlined?
  Does its name still describe a real product concept?
  Does it own lifecycle, state, IO, policy, or invariants?
  Does it only preserve an old shape, smooth over bad naming, or delay a hard
  product decision?
```

Trace upward until you hit the product boundary:

```txt
local helper -> exported function -> package API -> app route/component ->
user-visible workflow -> product boundary
```

Stop early only when the owner is obvious and the deletion is local. Otherwise, keep walking. The cleanest break is often one level above the file that first looked wrong.

## Asymmetric Wins Pass

Before implementing, ask what can be refused.

```txt
What 10-20 percent of promised behavior creates 80 percent of the code,
testing, state, branching, compatibility, or naming complexity?

Could we refuse:
  rare modes
  fallback parsers
  provider-specific branches
  compatibility aliases
  dual readers or dual writers
  exact reproduction requirements
  optional config shapes
  second transports
  repair code in read paths
  UI affordances for invalid states
```

For each candidate refusal:

```txt
Refusal:
  ...

User loss:
  ...

Complexity deleted:
  files, branches, states, tests, docs, public names

Why this is asymmetric:
  small product loss, large implementation collapse
```

Load [asymmetric-wins](../asymmetric-wins/SKILL.md) when the refusal becomes the center of the decision.

## Smell Catalog

Look for:

```txt
two ways to do the same thing
two owners for the same value
fallbacks beside the canonical path
repair code in read paths
optional fields preserving old shapes
compatibility aliases
dual readers or dual writers
placeholder tables or services
default rows created for hypothetical future use
public types with no real consumer
helpers that only hide product decisions
test fixtures that preserve obsolete behavior
state copied across layers for convenience
branches that exist because an invariant is checked too late
adapters that exist only because the wrong layer owns data
types that encode framework plumbing instead of product language
docs that explain two paths where one path should exist
tests that require fake lifecycle because production ownership is split
```

These are not automatically wrong. Keep one only when you can name the concrete product behavior it owns in the final shape.

## Ownership Pass

Name one owner for every important value and invariant.

```txt
auth session       signed-in identity
route params       selected resource
database row       durable product fact
UI state           navigation choice
config file        project declaration
runtime actor      live coordination
sync engine        protocol bytes
```

Treat a value as important when it is persisted, exported, user-visible, security-sensitive, cross-process, generated, or shared by multiple layers.

If two layers can create, repair, reinterpret, or cache the same value, choose one owner and delete the other path.

Ownership decisions should be boring after the pass. A new caller should not need to know history to find the right place.

## Execution Loop

When editing, keep the break clean:

```txt
1. State the uncompromised vision, product sentence, and clean-break decision.
2. Work backward to deletion waves, owner changes, blockers, and verification.
3. Name the owner of each important value and invariant in the final shape.
4. List branches, options, fallbacks, aliases, helpers, files, tests, and docs
   that only preserve the old shape.
5. Decide for each: delete, replace, defer, or stop and ask.
6. Build the new path.
7. Stop importing the old path while leaving it on disk.
8. Verify with targeted tests, typecheck, and relevant smoke coverage.
9. Delete the old path, aliases, fixtures, examples, and docs.
10. Re-run rg for stale names, imports, and compatibility terms.
```

Read [references/wave-ordering.md](references/wave-ordering.md) for any multi-wave replacement.

## Close Against The Destination

After verification and old-path deletion, compare the resulting system with
the accepted destination:

```txt
Satisfied:
  The evidence that its recognition test is now true.

Drift:
  Any difference from the accepted model, including a newly discovered
  external constraint or desired outcome.
```

Do not normalize consequential drift as implementation detail. Return to
Dialectic when drift materially changes the destination; otherwise record the
comparison and finish.

## Related Moves

- Use [asymmetric-wins](../asymmetric-wins/SKILL.md) when one small refusal may delete a large code family.
- Use [radical-options](../radical-options/SKILL.md) when the local fix is trapped inside a bad abstraction.
- Use [refactoring](../refactoring/SKILL.md) for caller counts, inlining mechanics, and straggler sweeps.
- Use [typescript](../typescript/SKILL.md) "Go-to-Definition Awareness" when the clean break changes TypeScript exports, aliases, wrappers, or public navigation across packages.

## Finding Format

```txt
Uncompromised vision:
  ...

Product sentence:
  ...

Recognition test:
  observable proof of the destination and its clear violations

Backward path:
  deletion waves, owner changes, blockers, and verification

Evidence read:
  files, symbols, callers, tests, docs, ADRs, specs, schemas, routes

Value owners:
  ...

Trace upward:
  definitions, callers, exports, docs, tests, durable shapes

Reopened decisions:
  ...

Drift:
  ...

Asymmetric refusals:
  ...

Refused promise:
  ...

Clean break:
  ...

Collapse target:
  old path, alias, fallback, option, fixture, docs, tests

Deletion prize:
  ...

User loss:
  affected users, data, workflows, commands, or package consumers

Decision:
  delete / replace / defer / stop and ask because ...
```

## Stop And Ask

Pause before:

```txt
changing durable strings
deleting a published package API
changing auth or session schema
removing migration readers for existing on-disk user data
changing encryption or sync wire format
amending an ADR
deleting behavior from a published package or deployed endpoint with plausible users
deleting behavior when clean-break scope or blast radius is ambiguous
```

Greenfield pressure does not authorize silent data loss, security changes, or breaking published surfaces when scope is ambiguous. Stop and ask; do not build a hidden compatibility layer.

## Final Check

Ask:

```txt
Can I explain the new API without saying "or"?
Does one layer own each invariant?
Would a new caller find only one obvious path?
Are examples free of compatibility shapes?
Did I trace high enough to challenge the owner, not just the local helper?
Did I name at least one asymmetric refusal or explain why none exists?
Did I stop importing the old path before deleting it?
Did verification pass before deletion?
Did I delete stale names instead of leaving aliases?
Did docs, tests, and examples stop teaching the old shape?
Does the result satisfy the accepted destination, and did I name any drift?
```
