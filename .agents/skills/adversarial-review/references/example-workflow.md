# Example adversarial review workflow

These hypothetical examples capture the response style accepted by the user.
They are not evidence about Epicenter's implementation, and the verification
results below are imagined. Real reviews must establish those facts
from the implementation. The example illustrates judgment and presentation;
it does not require every review to find a reload or deletion.

## The request

> **You:** Review this account-switching design. It keeps the app open while
> subscriptions, caches, and pending saves move to the new account.

## Initial accounts

In this example, the person has settled the intent: change accounts without
losing their work. Keeping the app open is part of the proposed vision, which
the reviewers can reconsider.

Three fresh reviewers inspect that intent, the request, and the same evidence:
two Sol subagents and an Opus 5.5 reviewer, all at high effort. Each receives the
shared challenge from
[the coordinator protocol](coordinator.md#staff-and-brief-the-reviewers)
and forms its account before seeing the others. In this example, two reviewers
use the optional starting angles.

Reviewer one, asked what the system should be from the desired experience,
proposes reloading on account change: one page lifetime belongs to one account.

Reviewer two follows people through their work and identifies pending
edits as the guarantee that matters. Rebinding every subscription may be
unnecessary, but preserving someone's work is essential.

Reviewer three, looking for premises the design shares with its obvious
alternatives, challenges the premise that a pending save belongs to whichever
account is current. If each edit records its owning account when it is created,
a reload cannot send it to the wrong account.

## Working toward a direction

The coordinator works through the three accounts and identifies pending edits
as the deciding question. Reviewer two objects that a reload would lose
an edit still waiting in the upload queue. The coordinator resumes reviewer three
with that objection and asks what evidence could settle it. Reviewer three asks
whether pending edits are persisted under their owning account before entering
the queue.

The coordinator traces persistence and runs a focused recovery check. In this
imagined case, edits are persisted locally under their original account, and
the check passes after a reload, including offline. The coordinator gives the
trace and result to reviewer two, who withdraws its objection.

The trace also shows that a second tab can stay open on the old account. The
coordinator develops a revised proposal: broadcast the account change so every
tab reloads. It asks reviewer two to test that against an upload in progress in
the second tab. Because the edit is persisted under its account, the upload
resumes after the reload.

The coordinator sends the complete revised proposal and the evidence to all
three reviewers. Each examines reloading every tab and uploading each persisted
edit under its original account. In this hypothetical case, all three explicitly
support that same design, including the checks for pending edits and other tabs.

## What the user receives

The coordinating agent presents the developed direction, its deciding evidence,
and the scope of support. The user does not have to reconstruct them from three
reports and their exchange.

> I recommend replacing the account-switching machinery with a reload of every
> open tab. One page lifetime belongs to one account.
>
> The deletion prize is subscription rebinding, cache replacement, intermediate
> switching states, and moving pending saves to the new account.
>
> The guarantee survives: edits are already persisted locally under their
> original account, and a recovery check passes after a reload, including
> offline. The remaining cost is that switching accounts reloads the page.
>
> All three reviewers examined and support this revised design.

> **You:** Go ahead.

This request began as a review, so implementation follows the user's
instruction. Repairs within an existing implementation request's authorization
can proceed without a separate approval step.

If accepting a reload on every switch remains an unsettled product choice,
the coordinator brings that question to the person with the alternatives and
their consequences. Agreement among reviewers cannot settle that preference.

## When reframing clarifies a disagreement without settling it

Reviewers disagree over how re-importing a project file should update a live
workspace. One proposes merging fields, another asks the person about each
conflict, and a third protects locally deleted records. Testing the proposals
adds exceptions for renamed folders and attachments still uploading.

The group notices that every proposal assumes import must change the current
workspace in place. They return to the outcome: the person should be able to
inspect imported content without losing their edits. They test importing into
a separate workspace to remove merge rules and partial rollback. Before
supporting it, they check whether links or other devices depend on the current
workspace identity, and whether keeping two copies is acceptable. If that
check defeats the new process, they return to the merge dispute with its cause
and cost understood.

In this hypothetical case, the new workspace preserves both sets of edits,
but existing links and offline devices still refer to the original workspace.
A read-only preview helps someone inspect the import; it does not decide
which workspace should become their continuing copy.

One reviewer supports preserving the original identity and accepting merge
rules. Another supports a new workspace with explicit provenance and the cost
of updating links and devices. They examine an alias between the two and find
that it restores the identity coordination they hoped to remove. The evidence
clarifies the bargain but cannot establish which experience the person wants.

The coordinator gives the group's developed account:

> Importing separately removes merge and rollback machinery, but moves the
> decision to which workspace you continue using. Preserving the original
> identity keeps links and devices working and retains the merge problem.
>
> We tested a preview and an identity alias. The preview makes inspection
> easier; the alias brings back coordination. Neither settles whether keeping
> the current workspace identity is worth the merge rules. That is the choice
> we need you to make before pursuing either replacement. The group has not
> converged on which behavior to pursue.

The review ends with a clearer decision, not manufactured assent. The
coordinator does not report agreement on the design or implement the disputed
replacement. Further work can resume from this shared understanding.

## When the current design wins

In this separate hypothetical case, the system already uses deletion markers to
prevent offline devices from restoring deleted records. All three reviewers
examine alternatives, test one another's objections, and each explicitly
supports retaining that mechanism. The coordinator verifies the deciding claims
and gives the user the result:

> I recommend leaving the current design in place, including its deletion
> markers.
>
> The deletion prize would be removing marker retention and cleanup, but getting
> it requires either rejecting old replicas or making you reset devices.
>
> That's a poor bargain for a system where an offline device should reconnect
> normally. All three reviewers support retaining it.

The opening makes retention explicit. The rejected alternatives appear only to
explain the cost of the deletion prize, so the user can judge why the current
design wins. Attribute agreement to the reviewers only when they actually agree;
the coordinator still checks the evidence rather than treating agreement as proof.

## When a new concept wins

In another hypothetical case, checkout, cart, and admin flows each implement
their own checks and timers to keep two people from buying the same seat.
A reviewer proposes one reservation authority through which every flow claims
a seat for a bounded time. The others test it against admin overrides and
support pursuing it, conditional on atomic acquisition. The coordinator presents
the conditional recommendation:

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
