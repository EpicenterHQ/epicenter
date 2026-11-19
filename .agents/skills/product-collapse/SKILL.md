---
name: product-collapse
description: Develop simpler product behavior with the person by questioning assumed requirements and working backward from what they need. Use when exploring simpler workflows, settings, modes, fidelity, or scope and the product direction needs judgment, or when judging asymmetric wins, meaning whether refusing a small promise would remove disproportionate complexity.
---

# Product collapse

Look for a simpler way for the product to do what the person needs.
Ask which requirements serve that purpose and which ones the current
design brought with it.

Use [dialectic](../dialectic/SKILL.md) to develop the direction together.
Offer something specific the person can recognize, correct, or extend.

Removing features, steps, or state is a consequence, not the goal. If the
proposed direction changes what the product is for, say so plainly.

## Imagine the experience afresh

Ask how you would design this today for that purpose. Look beyond
adjusting the existing screens and settings.

A recurring choice might be resolved once. A mode or degree of fidelity
might be unnecessary. Actions might belong together, or a combined action
might work better as separate decisions. Something the browser or
operating system already does may be enough.

Often a change only needs to take effect when something starts. An editor
window that can switch between folders has to close files, settle pending
work, and clean up. If each window stays with one folder, opening another
folder opens a new window, and all of that goes away. The same goes for
reloading a page after a setting changes instead of keeping a live
connection in step with it. The person waits a moment and may lose unsaved
work, so decide whether that is acceptable before the code goes.

For example, someone who wants to review their week might need one
useful report with a date-range choice. They may have no use for a report
builder with configurable columns, grouping, and saved layouts. That
simpler experience could make the builder unnecessary. But if exploring
the data is the job, the builder may earn its place.

## Show what changes

Show what the person does, what gets easier, what they give up, and
what still needs doing. Include interruptions and failures when they
would change the choice.

Account for work added as well as removed. An extra step may make the
whole experience simpler. Removing a step may leave the person with more
to remember, check, or repair later.

Keeping a capability is a good outcome when it is worth what it costs.

Agreement on a direction does not by itself authorize implementation. Use
[code-collapse](../code-collapse/SKILL.md) to carry an authorized change
through the code, and read its "Before you delete" section first. Use
disposable data for app experiments.

Read [the examples](references/examples.md) for illustrations of this
judgment.

## Asymmetric wins

Ask: what could we refuse? Could giving up 10 to 20 percent of the
features remove 80 to 90 percent of the complexity?

Look for one small promise that drags a lot of code along with it: a fast
path, an old format, a rare mode, a compatibility alias, a fallback parser,
exact reproduction. Write down what people lose and the deletion prize, the
code that goes away with it. Then check that the product still does what
it is for. A second way of doing something looks cheap to add, but
it has to be kept working forever.

Be careful with a promise that touches data already stored or an API other
people call. Dropping a reader for old data on disk, or a published export,
loses something people can't get back. Read
[durable contracts](../code-collapse/references/durable-contracts.md) first.

Choose the smallest loss that removes the second way, not simply the
biggest deletion.

For example, letting browser apps sign in with Google's one-tap costs a
second of speed, but it forces a separate sign-in path, helpers, an error
state, and two sets of docs and tests. Refusing it makes Google sign-in a
few seconds slower and leaves one path for every provider.
