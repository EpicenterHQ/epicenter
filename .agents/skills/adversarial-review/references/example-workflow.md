# Example adversarial review workflow

These hypothetical examples capture the response style accepted by the user.
They are not evidence about Epicenter's implementation, and the verification
results below are imagined. Real reviews must establish those facts
from the implementation. The example illustrates judgment and presentation;
it does not require every review to find a reload, deletion, or agreement.

## The request

> **You:** Review this account-switching design. It keeps the app open while
> subscriptions, caches, and pending saves move to the new account.

## Independent review

Three reviewers inspect the same evidence independently: two fresh Codex
subagents and a Claude Opus reviewer.

Codex reviewer one asks:

> From the desired experience and actual use, what should this system be? Develop
> your own account of its natural operations and responsibilities, then compare
> it with the design under review. Which problems disappear under that account,
> and what work, guarantees, or costs remain?

It proposes reloading on account change: one page lifetime belongs to one account.

Codex reviewer two asks:

> Follow actual or intended users through the work this system must support.
> Read existing callers as evidence of need rather than of the right operations.
> Develop your own account of what belongs together and what its operations
> mean. Test that account and the design under review against consequential
> sequences. Which requirements reflect necessary outcomes, and which reflect
> an assumed solution? Show the bargain behind your recommendation.

It identifies pending edits as the guarantee that matters. Rebinding every
subscription may be unnecessary, but preserving someone's work is essential.

The Claude reviewer asks:

> Find the premises the design under review shares with its obvious
> alternatives: about ownership, lifetime, representation, or what is promised
> to people. Which premise accounts for the most machinery, and what would you
> build if it were false? Develop your own account and test it against the
> strongest case for the current design. If the evidence points to a better
> question, pursue that instead.

It challenges the premise that a pending save belongs to whichever account is
current. If each edit records its owning account when it is created, a reload
cannot send it to the wrong account.

## What the user receives

The coordinating agent checks the findings against the code and presents one
recommendation. The user does not have to reconstruct it from the three reports.

> The strongest simplification is to replace the current account-switching
> machinery with a page reload. One page lifetime belongs to one account.
>
> The deletion prize is the account-switching machinery: subscription rebinding,
> cache replacement, and intermediate switching states.
>
> The cost is losing unsaved work. Flushing pending saves before reloading could
> preserve it, but some transition coordination would remain.
>
> I recommend exploring the reload approach. The deciding question is whether
> existing persistence already records each pending edit under its account;
> that determines how much machinery we can actually remove.

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

No additional reviewer is needed here: the focused persistence trace settled
the deciding question. Had it instead shown that edits are stored without their
account, choosing between tagging edits and keeping the switching machinery
would be a distinct design question. The coordinator would add a reviewer
focused on it without waiting for the user to ask.

## When the current design wins

In this separate hypothetical case, the system already uses deletion markers to
prevent offline devices from restoring deleted records. All three reviewers
examine alternatives and recommend retaining that mechanism. The coordinator
verifies their findings and gives the user the result:

> All three reviewers recommend leaving the current design in place, including
> its deletion markers.
>
> The deletion prize would be removing marker retention and cleanup, but getting
> it requires either rejecting old replicas or making you reset devices.
>
> That's a poor bargain for a system where an offline device should reconnect
> normally. I'd keep the current design.

The opening makes retention explicit. The rejected alternatives appear only to
explain the cost of the deletion prize, so the user can judge why the current
design wins. Attribute agreement to the reviewers only when they actually agree;
the coordinator still checks the evidence rather than treating agreement as proof.

## When a new concept wins

In another hypothetical case, checkout, cart, and admin flows each implement
their own checks and timers to keep two people from buying the same seat.
A reviewer proposes one reservation authority through which every flow claims
a seat for a bounded time. The coordinator presents the model:

> I recommend making a reservation own the claim and its expiry. Checkout,
> cart, and admin would use the same acquisition and release operations.
> This introduces a shared concept and preserves the exclusivity people need.
>
> The deciding check is whether acquisition can be atomic across every writer,
> including admin overrides. A concurrent acquisition check must establish that
> only one claim succeeds before we can say the design prevents double-booking.

The useful change is a coherent model for necessary coordination. The new
abstraction earns its place through the behavior it owns. These are a proposal
and a proposed check; the example does not report an implementation result.
