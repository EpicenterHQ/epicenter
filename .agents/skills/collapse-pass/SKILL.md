---
name: collapse-pass
description: Find a simpler design behind code complexity, carry it through its callers, and verify the result. Use when asked for a collapse pass, a refactoring or simplification pass, another pass, "simplify this", "conceptually collapse this", to clean up code, or to hunt for indirection, dead abstractions, and redundant subsystems. Also use for the one-sentence test: stating in one sentence what a surface or abstraction actually does, to find orphaned surfaces, duplicate verbs, and inert abstractions. Answer a plain code-comprehension question directly instead. Use control-flow for a request limited to one function's branching.
metadata:
  author: epicenter
  version: '2.0'
---

# Collapse pass

A collapse pass looks for a simpler way for the system to do its job.
Question the current concepts and promises as well as their implementation.

Try the plainest articulation of the design. Follow “it’s just plain X”
through a real use and see what work disappears.

Look for the choices that make the code do extra work. Several helpers,
checks, caches, and exceptions may all exist because of one earlier
decision. Ask what would let those pieces disappear together, then carry
the better design through the code that uses it.

For example, an editor might let a window switch between folders.
Switching requires coordinating open files, pending work, and cleanup.
If each window stayed with one folder, opening another folder could open
another window. The window would still need to know its folder, but the
work of switching a running editor could disappear. That changes the
experience too, so develop the choice with the user unless it is already
settled.

Count the coordination eliminated, not the collections deleted.

Scale investigation to the uncertainty; a local edit can be the right result of considering the whole.

## Understand the work

Start from what the person or caller needs to accomplish. Read the
relevant code and the code that uses it. Build on what the user has
already decided. Ask when an unresolved purpose or tradeoff would
change the work.

Begin with the named files or subsystem. With no named target, infer the
starting area from the conversation and current changes. Unrelated dirty
files are not permission to edit them.

A named transformation stays focused: perform and verify it without
turning it into an open-ended hunt. Reviews, plans, and proposals remain
read-only. Respect explicit file limits. Read callers outside those
limits to understand behavior, but defer a change that requires editing
them.

Follow connected evidence when it points to a shared cause. Explain the
connection before editing beyond the starting area.

For a PR or branch, establish the comparison base from PR metadata, the
upstream tracking branch, or `origin/main`. Start with changed files and
their callers. Use an isolated worktree when switching targets would
disturb the current checkout. Never reset the user's work. Report the
checkout path and any uncommitted edits at handoff.

## Find what makes the work necessary

Look for information kept in several places, repeated decisions,
forwarding layers, and rules that need another exception for each new
case. Include the fixes already made, including your own. A workaround
may reveal a better design even before the same problem recurs.

Searches for maps, registries, flags, caches, retries, adapters, and
compatibility paths can help you find these places. Use
[code-audit](../code-audit/SKILL.md) when one of its searches fits.
Treat matches as clues, not instructions to delete something.

When several pieces seem connected, investigate them together. What
choice makes them necessary? Who needs that choice: the person, an
actual caller, or only the current implementation?

Existing behavior alone does not establish that someone needs it.

Use [rethink](../rethink/SKILL.md) to consider how you would build this
today. Look beyond making the existing pieces tidier:

- Could readers ask the thing that already knows? A Map that copies
  connections a pool already tracks may disappear along with its updates.
- Could one part do the whole job instead of several parts keeping each
  other informed?
- Could choosing something once remove repeated choices and checks?
- Could related operations belong together so callers stop passing the
  same information through several layers?
- Could a different workflow make an entire subsystem unnecessary?

These are examples of questions to pursue, not a required checklist.

Develop the alternative far enough to show how it works. Use realistic
caller code, an interaction, or a data flow. Try it on the awkward cases
as well as the ordinary ones. Use the
[concept inventory](references/concept-inventory.md) when showing the
current and proposed parts would help someone judge the change.

If the alternative keeps needing exceptions, reconsider how you have
divided the work. Keep the current design when it handles real needs
more simply than the replacement.

## Keep what still has a job

Before removing state, find out what it remembers and who needs it.
Something that looks like a copy may preserve a different fact:
unfinished input, a submitted version, a choice someone made, or an
action whose outcome is still uncertain.

Establish that the replacement has the information whenever it is
needed. Before removing a check, understand what it protects and whether
the information it uses is still current.

Keep a boundary when it names non-obvious work, enforces a shared rule,
owns a lifecycle, isolates unsafe input, or makes a long phase
understandable. Caller count alone does not decide.

For Svelte inputs, use
[input ownership](../svelte/references/input-ownership.md) to distinguish
unnecessary copies from unfinished work. Check the
[template-local examples](../svelte/references/component-ui-patterns.md#template-locals-narrow-reactive-values-before-use)
before inlining locals that preserve type narrowing.

Judge the complete result. Fewer lines alone are insufficient. Deleting
a file does not simplify the system if its job is now spread across
callers. Name what becomes easier to understand or maintain, and account
for any new work the replacement introduces.

## State it in one sentence

To audit a design, surface, or abstraction, write one concrete sentence
about it in your response: objects, verbs, and scope, with no "flexibly
handles" or "unified experience". The value is the visible gap between what
the prose claims and what the code does. If the sentence keeps drifting,
the design is not coherent yet; name that before continuing.

**A design or set of surfaces** (commands, endpoints, options). The
sentence is the thesis. Ask of each surface: does it serve the sentence,
would the sentence survive its removal, is there a verb with no surface,
do two surfaces serve one verb? A convenience feature that forces a second
sentence belongs to another product. This is also where an asymmetric win
shows up: remove the feature that forces the most extra surface from the
sentence, and if the sentence still describes a useful product, take it to
the asymmetric wins section of [product-collapse](../product-collapse/SKILL.md).

**A wrapper, flag, or utility.** Reduce it three times, in order:

```txt
1. Strip the docs. Ignore the name and JSDoc, read the body:
   "This function dedups by id, refcounts open/close, and destroys on
   idle timeout."
2. Specialize to the defaults in use:
   "With gcTime: Infinity, it dedups by id. Docs live forever." The
   refcount is inert.
3. Ask what the caller needs. A singleton caller has one id and one
   lifetime, so dedup is a no-op: the wrapper adds nothing. Delete it.
```

Stopping at step 1 sounds useful until the defaults turn the feature off.

Watch for the usual reveals: inert knobs, singleton wrappers around a
dedup or cache, "lifecycle management" that reduces to "call close when
done", docs that describe what the code could do under other configs,
surfaces that map to no verb in the thesis, and a thesis you cannot finish
without contradicting yourself.

A worked cohesion audit. A notification API has `send`, `schedule`,
`batch`, `digest`, `preferences`, `channels.register`, and `history`.
"A notification system" is too vague. "Send messages to users across
channels" misses `preferences` and `history`. "Deliver a message to a user
on their preferred channel, honoring their quiet hours, and remember we
sent it" fits five of them. `schedule`, `batch`, and `digest` are not in
the sentence: they are a sibling product. A good sentence is concrete
enough to make a surface worth questioning; "a CLI for managing your
workspace" audits nothing.

The test passes when you can say what the subject is, or what it buys this
caller, in one concrete sentence. If the honest sentence is "nothing,
really", it does not earn its keep.

## Carry the change through

Establish the starting state so your changes remain distinguishable from
existing edits.

An implementation pass authorizes routine simplifications within its
scope. Make those changes without asking about each one. Give short
updates explaining meaningful findings and changes in direction.

When a simpler design would change a product promise, use
[product-collapse](../product-collapse/SKILL.md) to develop the experience
with the user; its asymmetric wins section covers judging whether giving
up one small promise would remove much larger complexity.

Carry settled decisions forward. Bring back consequential choices that
exceed existing authorization, including changes to stored formats or
externally consumed contracts. Do not ask again merely because files
merge or an internal signature changes.

Implement the connected change through its affected callers. Moving a
guarantee must not leave an old path that silently loses it. Use
[clean breaks](../rethink/references/clean-breaks.md) to retire superseded
paths. Keep temporary compatibility only for a named consumer or
migration, with a retirement condition.

Preserve stored data, unfinished input, unrelated work, and real consumer
contracts. Applied migrations are durable history. Read
[durable contracts](references/durable-contracts.md) when changing storage,
sync, auth, or public contracts.

Verify external library behavior against official documentation or
installed types when correctness depends on it. Read
[library refusal](references/library-refusal.md) before reshaping or
reimplementing a library's public surface.

Use [refactoring methods](references/refactoring-methods.md) for local
techniques and leftover-reference cleanup. Remove obsolete exports,
comments, tests, and documentation with the replacement. Preserve
coverage for behavior that remains.

Run checks appropriate to the changed behavior. Resolve failures or
report them with evidence; do not blame the baseline without checking.
Fix regressions introduced by the pass before moving to unrelated work.
Review the cumulative result with
[post-implementation-review](../post-implementation-review/SKILL.md).

If a change no longer earns its place when reread, undo only that change
while preserving unrelated and unsaved work.

## Look again, then stop

After a fix works, consider the whole again. Knowing what you know now,
would you choose these parts and this division of work?

“Another pass” starts from that reassessment. The user's settled intent
carries forward; earlier implementation choices remain open to question.
Use previous findings and rejected ideas to choose new places to look.
Revisit a rejected idea when new evidence changes its justification.

Continue through the relevant subsystem while convincing opportunities
remain. A few unproductive files are a reason to change the search, not
an automatic stopping rule.

Stop when further investigation yields no convincing simplification,
the remaining work needs a consequential decision, or an explicit budget
is reached. Do not manufacture changes to make a pass look productive.

Report what caused the extra work, what replaced it, what disappeared,
what was verified, and any remaining decisions. Use
[report guidance](references/report-format.md) for a longer campaign.

A plain “collapse pass” needs no goal, checkpoint count, or scope form.
Honor explicit budgets and commit preferences. Use
[agent-goal](../agent-goal/SKILL.md) when asked to draft a goal. Stage,
commit, push, or create a PR only when authorized.
