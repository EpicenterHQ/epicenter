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

Three fresh reviewers inspect the same evidence: two Codex subagents and a
Claude Opus reviewer. Each uses a distinct starting question from
[the skill](../SKILL.md#establish-independence) and forms its account before
seeing the others.

Codex reviewer one, asked what the system should be from the desired
experience, proposes reloading on account change: one page lifetime belongs to
one account.

Codex reviewer two follows people through their work and identifies pending
edits as the guarantee that matters. Rebinding every subscription may be
unnecessary, but preserving someone's work is essential.

The Claude reviewer, looking for premises the design shares with its obvious
alternatives, challenges the premise that a pending save belongs to whichever
account is current. If each edit records its owning account when it is created,
a reload cannot send it to the wrong account.

## Working toward a direction

The coordinator shares the three accounts with every reviewer and relays their
replies; Claude receives each exchange in a resumed turn.

Codex reviewer two objects to the reload: an edit still waiting in the upload
queue would be lost. Claude asks whether pending edits are already persisted
under their owning account before they enter the queue. The three agree that
this fact decides whether a reload loses them.

The coordinator traces persistence and runs a focused recovery check. In this
imagined case, edits are persisted locally under their original account, and
the check passes after a reload, including offline. Every reviewer receives the
trace and result, and reviewer two withdraws its objection.

The trace also shows that a second tab can stay open on the old account. How
tabs share an account lifetime is a question none of the initial accounts
addressed, so the coordinator adds a fourth reviewer focused on it. That
reviewer forms its own account from the evidence before reading the group's
direction, then proposes broadcasting the account change so every tab reloads.
The others test that against an upload in progress in the second tab. Because
the edit is persisted under its account, the upload resumes after the reload.

Each of the four reviewers then states support for the same direction: reload
every tab on account change, and upload each persisted edit under the account
that created it. Their reasons differ; the direction is shared.

## What the user receives

The coordinating agent presents the agreed direction. The user does not have to
reconstruct it from four reports and their exchange.

> All four reviewers support replacing the account-switching machinery with a
> reload of every open tab. One page lifetime belongs to one account.
>
> The deletion prize is subscription rebinding, cache replacement, intermediate
> switching states, and moving pending saves to the new account.
>
> The guarantee survives: edits are already persisted locally under their
> original account, and a recovery check passes after a reload, including
> offline. The remaining cost is that switching accounts reloads the page.
>
> I recommend implementing it.

> **You:** Go ahead.

This request began as a review, so implementation follows the user's
instruction. An existing implementation request would already authorize repairs
within its accepted outcome; this exchange is not a mandatory approval sequence.

Had the reviewers divided over whether reloading on every switch is acceptable
to the people using the app, the evidence could not settle it. The coordinator
would bring that product question to the user with both options rather than
report an agreed direction.

## When disagreement points to inherited work

Reviewers disagree over how re-importing a project file should update a live
workspace. One proposes merging fields, another asks the person about each
conflict, and a third protects locally deleted records. Testing the proposals
adds exceptions for renamed folders and attachments still uploading.

The group notices that every proposal assumes import must change the current
workspace in place. They return to the outcome: the person should be able to
inspect imported content without losing their edits. Importing into a separate
workspace could remove the merge rules and partial rollback. Before supporting
it, the reviewers check whether links or other devices depend on the current
workspace identity, and whether keeping two copies is acceptable. If that
check defeats the new process, they return to the merge dispute with its cause
and cost understood.

## When the current design wins

In this separate hypothetical case, the system already uses deletion markers to
prevent offline devices from restoring deleted records. All three reviewers
examine alternatives, test one another's objections, and each explicitly
supports retaining that mechanism. The coordinator verifies the deciding claims
and gives the user the result:

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
a seat for a bounded time. The others test it against admin overrides and
agree to pursue it, conditional on atomic acquisition. The coordinator presents
the agreed direction:

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
