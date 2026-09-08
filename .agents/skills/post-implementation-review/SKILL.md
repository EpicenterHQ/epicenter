---
name: post-implementation-review
description: Review cumulative implementation for structural collapse, invariant ownership, and correctness. Use for adversarial checkpoint reviews, reviewing work after implementation, doing a second pass, or performing a final sweep.
metadata:
  author: epicenter
  version: '1.0'
---

# Post Implementation Review

Implementation reveals relationships that a plan could only predict. Review the
whole affected system to find the owner or invariant that makes several local
repairs unnecessary. Then check the resulting shape for correctness and clarity.
A collection of individually reasonable helpers can still form the wrong design.

Do not silently fix structural concerns. First name what is wrong and why it
matters, then fix it when it clears the evidence bar below.

## Lane, Evidence, Limits

The user's request sets the lane. Evidence can widen the lane. Explicit user
limits close it.

```txt
Fix now:
  grounded correctness, invariant, public API, verification,
  and serious clarity issues on the touched path

Report:
  speculative cleanup, cosmetic cleanup, taste-only cleanup,
  and issues with weak evidence

Pause:
  explicit user limits, product direction, destructive actions,
  reshaping beyond the authorized outcome, or unresolved product ownership
```

Two things never move when the lane widens:

- The lane never widens silently. Every expanded edit is still flagged first,
  and stays easy to review, with a separate commit when commits are being made.
- The evidence bar never drops. "Within reason" still means grounded in
  caller counts, a real invariant, or a named smell, never a hunch. A user
  signal widens what you may touch; it does not lower the bar for why.

Authorship is not the gate. A smell the review uncovered can belong in the lane
when it is clear, important, and grounded, even if an earlier commit introduced
it. Explicit user limits still win.

## Related Skills

This skill is a hub for broad second reads. Focused requests can start from a
focused skill first, then escalate here when the work needs a full final pass.

Load only the skills that match the touched surface:

```txt
collapse-pass            continuous deletion of unearned indirection
greenfield-clean-breaks    public API, package boundary, config, lifecycle, naming, ownership, greenfield, or clean-break decision
asymmetric-wins          refuse a feature to collapse a disproportionate code family
refactoring              caller counts, inlining, dead exports, stale imports, straggler sweep
code-audit               recurring repo smells and grep-based checks
one-sentence-test        new abstraction, wrapper, option, endpoint, command, or module
testing                  test files or changed behavior that needs coverage
typescript               type organization, inference, runtime schema, type tests
svelte                   Svelte components, stores, runes, query usage, UI state
yjs                      CRDT documents, shared types, transactions, conflict behavior
```

## Independent checkpoint review

[spec-execution](../spec-execution/SKILL.md) owns the between-wave cadence and
model selection. This section owns the reviewer's evidence and judgment. It
also applies when the user requests an adversarial checkpoint without a spec.
Ordinary final reviews need not launch another agent automatically.

Use a read-only reviewer that did not implement the wave. Supply the accepted
outcome and explicit constraints, the task-start baseline and cumulative diff
including task-owned uncommitted and untracked work, the touched-file inventory,
relevant consumers and tests, verification results, newly discovered facts, and
remaining waves. Distinguish task changes from unrelated work already present. Give raw artifacts and open
questions, not the implementer's preferred conclusion. A summary alone is not
sufficient evidence.

The reviewer traces the affected boundary across files and consumers before
judging individual helpers. Its central question is:

> Given what implementation has revealed, what stronger invariant or different
> ownership boundary would eliminate the most complexity, and how should that
> change the remaining plan?

Apply the ownership, invariant, and mental inlining passes below to that
cumulative view. Load `greenfield-clean-breaks` for ownership or boundary
redesign, and `collapse-pass` when the finding calls for a continuous collapse
pass; do not duplicate their procedures here. Include new abstractions and
previous waves. Expand beyond touched files only to establish the relevant
owner, callers, or consequences, rather than starting a repository-wide audit.

Return the strongest grounded structural opportunity, or explain why the
current boundaries earn their place. Show the current and proposed shape,
concrete file or caller evidence, the behavior that must survive, complexity
removed and introduced, and which remaining tasks should change or disappear.
Report correctness blockers separately so an attractive collapse cannot hide a
regression. Name the verification that would distinguish an improvement from
moving complexity elsewhere. No finding quota: keeping the design is valid.

The reviewer does not edit the live checkout or launch child agents.
The primary agent owns adjudication, edits, verification, plan updates, and
launching any additional reviewers.
Additional reviewers need distinct unresolved questions; splitting the holistic
review into file lanes would recreate the blind spot this checkpoint addresses.

## Review Order

1. Identify the cumulative changed behavior or API and trace its owners,
   callers, lifecycle, and invariants across the affected system.
2. Inventory the touched files and read them in that context, including relevant
   unchanged consumers and tests.
3. List every file read as an ASCII tree before analysis.
4. Run the first-read pass.
5. Run the mental inlining pass.
6. Run the ownership and collapse check.
7. Run the smell and invariant checks.
8. Review API shape, naming, and file organization.
9. Run diagnostics and tests appropriate to the changed lane. Compare failures
   against the task-start baseline for cumulative reviews, or the agreed review
   baseline otherwise, using a separate checkout when reproduction is needed.
   Current HEAD may already contain earlier waves; reproducing there does not
   establish that a failure predates the task. Report unverified attribution as
   uncertain rather than calling it pre-existing.
10. Report findings before making cleanup edits unless the issue is a direct
    compile or test failure.

The ASCII tree is not decoration. It forces the review to show its evidence.

```txt
Files read
packages/foo/
|-- src/
|   |-- create-foo.ts
|   |-- foo-options.ts
|   `-- index.ts
`-- package.json
```

## First-Read Pass

Read the change as a smart but newly onboarded TypeScript developer would.
Start from the entrypoint a caller reaches first and trace the minimum path
needed to understand the behavior, rather than reading in the order the diff
happens to present.

Count the hops. A new developer's first read of a foreign symbol is
Go-to-Definition, so pressing it from a call site should land on the real source
of truth in as few jumps as possible. Each hop has to earn its keep: a layer
that does not own an invariant, name non-obvious domain behavior, or isolate
unsafe input costs a jump and returns nothing. What bloats the count, meaning
re-export chains, destructure-re-exports, no-op adapters, and identity-obscuring
annotations, is cataloged in [typescript](../typescript/SKILL.md)
"Go-to-Definition Awareness".

Mark each abstraction as one of: earns its keep, probably inlineable, wrong
ownership boundary, misleading name, or type-system workaround. The mark decides
the repair, because a misleading name wants a rename and a wrong owner wants a
move; collapsing both into "delete it" loses the difference and usually picks
the wrong one.

Do not fix a real parse boundary at a JSON, file, or network edge, runtime
validation over unsafe input, a contract that genuinely belongs in one place, or
repetition that is cheaper than the abstraction replacing it. Those read as
friction on a first pass and are load-bearing on the second.

The pass is done when a new teammate could say which file owns a concept and
which type is a real contract rather than library glue, without reverse
engineering either from naming accidents.

## Mental Inlining Pass

Mentally inline every helper, wrapper, component, prop bundle, adapter, file,
factory, compartment, and extracted function back into its call sites, then keep
a layer only when it earns its place.

For the full ask-block and the keep-vs-inline criteria, use
[radical-options](../radical-options/SKILL.md) "Mental Inlining Pass". The
ownership check below applies the same test to runtime, durable, and
user-visible state.

## Ownership And Collapse Check

Before accepting the final shape, replay the change as if designing it from
scratch:

```txt
What object owns the runtime lifetime?
What object owns the durable state?
What object owns the user-visible state?
Which props exist only because of a stale file split?
Which calls need `untrack`, and would moving ownership remove that need?
```

Count callers for every new or changed helper, component, factory, wrapper, and
export. A one-caller boundary is guilty until it proves it owns one of these:

```txt
a lifecycle that must be isolated from parent rerenders
an unsafe parse, network, storage, or external-library boundary
a repeated domain operation with several real callers
a public contract that downstream code imports
a long imperative block whose helper name explains the phase
```

If a boundary only passes a stable handle, callback, or raw library object to
another one-call wrapper, collapse it. In particular, treat `untrack` inside an
imperative widget setup as a design prompt: sometimes it is the right tool for a
stable callback, but it can also reveal that the prop should not be reactive or
should not cross the component boundary at all.

## Smell Check

Look for:

```txt
dead exports, dead methods, dead config hooks
stale imports and stale JSDoc
redundant work after ownership moved earlier
identity wrappers and pass-through modules
unnecessary casts or duck-typing inside typed code
fallback parsers for old shapes
callbacks that mirror internal implementation steps
decision callbacks that could be caller-owned composition
single-file directories and pointless barrels
near-identical sibling files or types (judge: cheap independence or latent coupling)
```

If a smell is repo-recurring, use `code-audit` for the relevant grep pattern. If
the smell came from the refactor itself, use `refactoring` for the straggler
sweep.

## Invariant Audit

Name the layer that owns each important rule.

```txt
Invariant                         Owner
config shape is valid              config loader
route names are unique             defineConfig validation
document id is parsed once          document cache
runtime socket opens once           daemon startup
cleanup policy is app-owned         injected lifecycle callback
```

If an invariant is checked repeatedly downstream, move it earlier: construction,
validation, or the type signature. If a later layer no longer needs a safety
check because setup guarantees it, delete the redundant check and name the setup
guarantee in the review.

## API Shape

Read the public surface as if designing it today.

Ask:

```txt
Is there one obvious call site?
Do option names describe domain policy instead of implementation steps?
Did the change leave both old and new shapes alive?
Can TypeScript prevent the common misuse?
Does the lifecycle name match when side effects happen?
```

For clean breaks, compatibility is a feature only when explicitly requested.
Otherwise, delete old public names and update all examples to the new shape.

## Naming And Files

Names should match what the code does now, not what it used to do.

Check:

```txt
Does foo-manager.ts still manage anything?
Does create* construct, define* return inert definitions, start* begin runtime work?
Does a type name describe a real contract or a library workaround?
Does each file have one reason to exist for a new reader?
```

When file organization is part of the finding, show both trees before editing.

```txt
Current
packages/foo/src/
|-- lifecycle.ts
|-- lifecycle-options.ts
|-- cleanup.ts
`-- index.ts

Proposed
packages/foo/src/
|-- lifecycle.ts
`-- index.ts
```

## Output Shape

For a review-only pass, report:

```txt
Files read
[ASCII tree]

Findings
1. [severity] [file:line] What is wrong and why.

Would change
[Specific edits worth making]

Would leave alone
[Indirection or duplication that earns its keep]

Verification
[Commands run and result, or why not run. For any failure, note whether it
 reproduces at the review baseline, or whether attribution remains uncertain.]
```

For an implementation pass, make the cleanup edits after reporting the issue in
the working notes. Keep the final answer short: what changed, what was left
alone, and what verified it.
