# Example adversarial review workflow

This hypothetical example shows a response shape the user can judge. It is not
evidence about Epicenter's implementation, and its verification result is
imagined. Real reviews must establish facts from current callers and code. The
example does not require every review to find a reload, deletion, or multiple
viable options.

## The request

> **You:** Review this workspace-switching design. People must be able to switch
> workspaces without a page reload or losing pending edits. The proposal manually
> rebinds auth, sync, subscriptions, and caches.

## Initial accounts

Codex sends two fresh read-only Codex reviewers and a read-only Claude Opus
reviewer the outcome, explicit requirements, existing implementation, and actual
callers. It withholds the proposed rebinding design and its rationale until all
three have proposed their own strongest greenfield shape. The Codex reviewers
start from different questions about the organizing model and consequential
caller sequences. Claude independently challenges the premises shared by the
design and its obvious alternatives. Every reviewer can pursue another model
or establish why the current one earns its place. After their independent first
answers, Codex shares the proposal with each for comparison.

The Codex reviewers find that manual rebinding compensates for resources having
no single workspace owner. One proposes a keyed workspace boundary. The other
asks whether pending edits belong to that boundary or survive its disposal.
Claude challenges the assumption that one mutable active workspace is necessary
and identifies independently owned sessions as a possibility to investigate.
Codex inspects current code rather than assigning that check to the user.

## Working toward a direction

The coordinator shares all three accounts with the group. Reviewers exchange
messages directly where supported; the coordinator relays Claude's questions
and replies through resumed turns.

Codex reviewer two objects that a disposable keyed boundary could destroy an
edit still waiting to save. Reviewer one replies that pending edits could live
outside that boundary. Claude asks whether independently owned workspace
sessions would preserve those edits more naturally, and what resources an
inactive session would retain.

The group cannot settle that comparison from the initial accounts, so the
coordinator adds a fourth reviewer to trace two open sessions, an edit pending
in the inactive session, and closing that session. The new reviewer receives
the raw callers and the group's open questions, then joins the exchange.

In this hypothetical case, the trace establishes that pending edits can remain
with a durable owner outside the keyed boundary. The callers need one active
workspace and gain no useful behavior from retaining sessions. The fourth
reviewer explains that separate sessions would introduce concurrent resource
management without helping that use. Claude accepts that finding and supports
the keyed boundary. Reviewer two withdraws the disposal objection after seeing
the durable owner and recovery check; reviewer one revises the proposal to name
that owner explicitly. Every reviewer receives the deciding evidence.

All four explicitly support the same direction: a keyed workspace boundary owns
auth, sync, subscriptions, and caches; pending edits survive with their durable
owner outside that boundary. Switching preserves the no-reload requirement.
Their reasons differ, but the direction is shared. Another case could favor
sessions despite introducing a new abstraction.

## What the user receives

The coordinating agent presents the group's agreed direction and the evidence
behind it. The user does not have to reconstruct it from separate reports.

> **1. Replace the workspace boundary (recommended)**
>
> ```text
> switch workspace
>   |-- dispose old workspace boundary
>   `-- create new workspace boundary
>        |-- auth
>        |-- sync
>        |-- subscriptions
>        `-- caches
> ```
>
> This preserves switching without a page reload. The deletion prize is the
> four separate rebinding procedures: one boundary owns their lifetimes.
>
> **2. Save edits, then reload**
>
> ```text
> switch workspace
>   |-- persist pending edits
>   `-- reload into selected workspace
>        `-- normal startup creates its resources
> ```
>
> This deletes more lifecycle code. **Requirement warning:** it conflicts with
> the explicit no-reload requirement. It is an option only if you choose to
> change that requirement.
>
> Pending edits live outside the disposable workspace resources, and a focused
> recovery check establishes that they survive its disposal. All four reviewers
> support the first path with that owner made explicit.

The diagrams show the different mechanisms, while prose explains the deletion
prize and requirement cost. The final paragraph reports the deciding check and
the group's support, so the user can judge the direction without reconstructing
the discussion. A real review can use fewer sections, different headings, code,
bullets, or a table if those better expose its decision.

## After the check

The coordinator returns the check and final proposal to the whole group. All
four confirm support for the direction and its preservation of pending edits.
An existing implementation request authorizes carrying that direction through
implementation and verification. A review-only request returns the agreed
recommendation. Changing the explicit no-reload requirement remains a product
choice for the user.

If that product choice or inaccessible evidence prevents agreement, the
coordinator presents the specific blocker and alternatives rather than claiming
the review is complete.

## When the current design wins

In a separate hypothetical case, deletion markers prevent offline devices
from restoring deleted records. All three reviewers examine alternatives,
answer one another's objections, and explicitly support keeping the markers.
Codex verifies the finding and reports:

> **Keep the deletion markers.** Removing marker retention and cleanup is the
> deletion prize, but it would require rejecting old replicas or making people
> reset devices. Those costs outweigh the removed code for a product that
> promises an offline device can reconnect normally.

Agreement marks completion, not proof. The coordinator still verifies the
deciding claims. An unresolved objection returns to the group, which can grow
as questions or needed expertise demand.
