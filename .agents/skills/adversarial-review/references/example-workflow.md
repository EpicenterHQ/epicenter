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

## Independent review

Codex sends one fresh Astra reviewer and one read-only Opus reviewer the outcome,
explicit requirements, existing implementation, and actual callers. It withholds
the proposed rebinding design and its rationale until both have proposed their
own simplest viable shape. The reviewers have complementary starting questions
but both must search for the deletion prize and test the guarantees. After their
independent first answers, Codex shares the proposal with each and asks for a
challenge against it.

Both find that the manual rebinding procedures compensate for resources having
no single workspace owner. One proposes a keyed workspace boundary. The other
asks whether pending edits belong to that boundary or survive its disposal.
Codex inspects the current code rather than assigning that check to the user.

## What the user receives

The coordinating agent checks the findings against the code and gives one
recommendation. The user does not have to reconstruct it from two reports.

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
> I expect pending edits to live outside the disposable workspace resources,
> but the current code has not established that. I will trace their owner and
> run a focused recovery check before implementing the first path.

The diagrams show the different mechanisms, while prose explains the deletion
prize and requirement cost. The final paragraph is the agent's own follow-up,
not homework for the user. A real review can use fewer sections, different
headings, code, bullets, or a table if those better expose its decision.

## After the check

In this imagined case, Codex establishes that pending edits are persisted
outside the workspace boundary and survive its disposal. The agent can then
implement the compliant path within an existing implementation request. If the
request was review-only, it reports the confirmed recommendation and waits for
an implementation request. The user need only decide whether to change the
explicit no-reload requirement if they prefer the larger deletion prize.

## When the current design wins

In a separate hypothetical case, deletion markers prevent offline devices
from restoring deleted records. Both reviewers examine alternatives and
recommend keeping the markers. Codex verifies the finding and reports:

> **Keep the deletion markers.** Removing marker retention and cleanup is the
> deletion prize, but it would require rejecting old replicas or making people
> reset devices. Those costs outweigh the removed code for a product that
> promises an offline device can reconnect normally.

Agreement is not proof. The coordinator still verifies the deciding claims,
and a further reviewer needs a named unresolved assumption rather than a wish
for consensus.
