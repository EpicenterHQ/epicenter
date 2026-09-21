# Example adversarial review workflow

This hypothetical interaction captures the response style accepted by the user.
It is not evidence about Epicenter's account switching or persistence, and the
verification results below are imagined. Real reviews must establish those facts
from the implementation. The example illustrates judgment and presentation;
it does not require every review to find a reload, deletion, or agreement.

## The request

> **You:** Review this account-switching design. It keeps the app open while
> subscriptions, caches, and pending saves move to the new account.

## Independent review

Two fresh Codex reviewers inspect the same evidence independently.

Reviewer one asks:

> Where is the strongest simplification? What stronger invariant, different owner,
> or smaller promise would let us delete a family of code or planned work? Name
> the deletion prize and its cost.

It proposes reloading on account change: one page lifetime belongs to one account.

Reviewer two asks:

> What would the simpler design have to preserve to be worth adopting? Trace
> concrete callers and lifecycle sequences to find the guarantees the current
> complexity provides. Which guarantees matter to the user, and which are
> inherited assumptions? Show where simplification would break a necessary
> guarantee or move the burden onto someone else.

It identifies pending edits as the guarantee that matters. Rebinding every
subscription may be unnecessary, but preserving someone's work is essential.

## What the user receives

The coordinating agent checks the findings against the code and presents one
recommendation. The user does not have to reconstruct it from the two reports.

> The strongest simplification is to reload the page when the account changes.
> One page lifetime belongs to one account.
>
> The deletion prize is the account-switching machinery: subscription rebinding,
> cache replacement, and intermediate switching states.
>
> The cost is losing unsaved work. Flushing pending saves before reloading could
> preserve it, but some transition coordination would remain.
>
> I recommend exploring the reload approach. The deciding question is whether
> existing persistence already protects pending edits; that determines how much
> machinery we can actually remove.

## Resolving the deciding question

> **You:** Check the persistence. I like the reload approach if we can preserve
> edits.

The agent traces persistence and runs a focused recovery check. In this imagined
case, it establishes that edits survive the reload under the original account.

> **Agent:** Edits are already persisted locally under the original account before
> entering the upload queue. The recovery check passes after a reload, including
> offline.
>
> That makes the deletion prize larger: we can remove subscription rebinding,
> cache replacement, and the save-before-switch transition. The remaining cost
> is that switching accounts reloads the page.
>
> I recommend implementing it.

> **You:** Go ahead.

This request began as a review, so implementation follows the user's instruction.
An existing implementation request would already authorize repairs within its
accepted outcome; this exchange is not a mandatory approval sequence.

No third reviewer is needed here. One would be brought in only if the coordinator
identified a consequential unresolved question, such as an assumption both
reviews accepted without establishing it.
