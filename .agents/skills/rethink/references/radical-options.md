# Radical options

Question the premise that makes the current choices seem exhaustive. Look
outward until you can see a different organizing idea, then follow that idea
far enough to show what it makes possible. A radical option may change the
product promise, the unit of ownership, or the need for an entire subsystem.

## Mental inlining

Mentally inline a suspicious helper, adapter, option, or service into its
consumers. Determine what remains after its name disappears. Keep a boundary
when it owns an invariant or lifetime, isolates unsafe input, expresses
non-obvious domain behavior, provides a stable package or runtime contract, or
simplifies real consumers. A forwarding layer
that only preserves an old split is a candidate for removal.

For example, repeated checks for whether a workspace is half torn down may
suggest that teardown needs one lifecycle owner. Adding another readiness flag
would preserve the problem. The alternative must still account for callers
that have work in flight; moving the flag out of sight is not a solution.

## Compare the consequences

Compare the inherited approach with the alternative organizing idea. Explain
the constraint being reconsidered and show the resulting consumer experience.
Do not manufacture several alternatives when one concrete contrast exposes the
decision.

Follow complexity to its new owner. Name the machinery removed and the state,
coordination, failure modes, or obligations introduced elsewhere. Removing a
local helper while adding central race handling can make the whole harder to
own. Trace what each affected consumer or person must now understand and do,
including what happens if they miss a required step. Judge the full bargain
against the experience the destination promises.

If a small promise keeps a second implementation family alive, assess refusing
that promise. Name both the user loss and the machinery removed. Use
[asymmetric-wins](../../asymmetric-wins/SKILL.md) when that tradeoff becomes the
center of the decision. Preserve the promise when its value warrants the
complexity.
