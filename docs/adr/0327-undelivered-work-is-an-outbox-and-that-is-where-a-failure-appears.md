# 0327. Undelivered work is an outbox, and that is where a failure appears

- **Status:** Accepted
- **Date:** 2026-09-01
- **Built**, on a narrower premise than it was written on. Local Mail records every pass in `last_pass`, and its status bar opens the outbox over that plus the intent store, so a failure is still there after the window that saw it was closed and reopened. See "What a draining outbox turned out to mean" below.
- **Amended in build:** an assertion the provider refused individually is written down after all, on the last-pass row rather than in a table of its own. This record left it where `reconcile.ts` had put it, which was a return value announced in a toast, and a toast tells nobody who has stepped away. It inherits the row's lifetime, so the next pass replaces it and nothing accumulates; the dead-letter table both records refuse is still refused.
- **No longer amends [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md).** That record's host-side background half was not built and is not being built, so this one has nothing to amend in it. What survives from the amendment is the sentence that mattered on its own terms: a pass outcome lands in the application's own durable storage, which is true whatever runs the pass.
- **Relates:** [ADR-0318](0318-epicenter-data-is-what-epicenter-is-the-authority-for-and-a-foreign-write-is-a-command.md) (a write to a foreign authority is a command, and a command that cannot be sent yet is a row in a table the application owns), [ADR-0320](0320-removing-an-account-settles-what-it-owes-before-anything-is-deleted.md) (removal already asks a person about this same undelivered work), and [ADR-0244](0244-epicenter-speaks-of-apps-and-windows-not-surfaces.md) (the library states the failure and the application decides what a person is told)

## Context

An application that writes to a foreign authority records what a person did and
delivers it afterwards (ADR-0318). Between those two moments the work exists,
it is the person's own, and nothing in the interface is made of it. Local Mail
shows a number and an age.

Moving delivery into the host (ADR-0323) makes that gap serious rather than
untidy. The one failure a person must know about, a provider that has stopped
honouring the sign-in, is currently derived from the result of a pass the window
performed itself. Once the host performs the pass, that derivation has no
source, and a person's triage can stop reaching Gmail with nothing anywhere
saying so.

## Decision

**Undelivered work is an outbox: a list a person can open, in the place that
already shows how much of it there is.**

```txt
 ┌──────────────────────────────────────────────────────────────────┐
 │  ● ready   4,102 msgs · synced 2m ago          ⟳ 3 waiting       │
 └──────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────────┐
 │  Waiting for Gmail                              Retry now        │
 │  ───────────────────────────────────────────────────────────     │
 │  Archive          Re: budget review             2 min ago        │
 │  Archive          Standup notes 9/2             2 min ago        │
 │  Move to trash    Your receipt from Figma       11 min ago       │
 └──────────────────────────────────────────────────────────────────┘
```

**It drains itself while a person is here, and empty is the normal state.**
Delivery is eager within a session: a pass runs when the application opens, when
a person acts, and when they press Retry, so a row appears when they act and is
gone when the provider agrees. An outbox at zero is an application saying it is
finished, which is the sentence a person actually wants.

**A failure appears in the outbox, because that is where a person is already
looking when the number stops falling.** Not a separate error surface, not a
toast that scrolls away, and not a notification.

```txt
 │  Waiting for Gmail                              Sign in          │
 │  ⚠ Sign-in expired. Nothing can be delivered until you sign in.  │
```

**So every pass writes its outcome where the window reads it.** The application
records what happened, in its own durable storage, beside the work the outcome
is about. That is what makes a failure outlive the window that saw it, which is
the whole point: the last thing that happened is what a person comes back to.

**The only control is "try again now".** There is nothing per row, because
delivery is a pass rather than a queue of independent errands, and a person who
wants one row gone individually is asking to undo the act, which is the act's
own inverse and belongs in the message list.

**The outbox is the account in view. A stuck account says so in the switcher.**
The rest of the window is one account at a time and a cross-account outbox would
be a second concept for one idea. What a person needs instead is to not be
surprised, so an account whose work is blocked carries a mark where they choose
accounts.

**No notification, for now.** An interruption is a fourth capability with three
leaves and permission to speak while a person is doing something else. It may
be right later, and it is cheap to add once the outcome is already recorded,
which is the ordering this record chooses: make the state true first, and decide
about interrupting separately.

## What a draining outbox turned out to mean

This record was written expecting a background half to do the draining
(ADR-0323), and ADR-0328 leaned on that: "an outbox that drains only while
somebody watches it is not an outbox." That premise was withdrawn. Local Mail
reconciles in the foreground only: when the application opens, when a person
records triage, and when they press Retry. If nothing is open, owed work waits.

**The decision above survives the change, and one clause narrows.** Everything
that made this record worth writing was about the state, not the schedule: a
person can answer "did my triage go through" by looking, a failure is not a
toast, and the answer is the same after a reload. None of that needs a
background writer. What narrows is only how quickly the number falls, and the
answer is now "while you are here", which is honest and is what the panel says.

**Two things it made possible are no longer built.** There is no retry schedule,
because nothing is running to honour one, so `last_pass` carries the failure and
its kind and no `retry_after`. And there is no "Syncing" in the durable read: a
pass in flight is a fact about the surface running it, so that surface says so
beside the outbox rather than through it. The outbox became entirely durable as
a result, which is a simpler thing than it was going to be.

**A failure's kind still earns its keep**, because it decides what a person is
told about the one control: `retry` invites pressing it, `refused` says it will
not help, and `signin` replaces it with Sign in.

## Consequences

- The one failure a person must know about survives a window being closed, which
  is what ADR-0323 needs and did not provide.
- A person can answer "did my triage go through" by looking, rather than by
  trusting. That question is currently unanswerable except by opening Gmail.
- ADR-0320's removal dialog and the outbox now describe the same work in the
  same words. A person who has seen "3 waiting" understands "Gmail hasn't been
  told about 3 changes" without being taught twice.
- An application with no commands has no outbox, and nothing has to be built for
  it. This is a pattern for applications that write to a foreign authority, not
  a platform surface every application gets.
- The status bar gains a panel. That is the whole interface cost.

## Considered alternatives

- **A notification when a pass fails.** Rejected for now, not forever. It is a
  new capability, it needs its own reasoning about when an application may
  interrupt, and it is strictly easier to add on top of a recorded outcome than
  instead of one.
- **A toast when delivery fails.** Rejected. The failure persists and a toast
  does not, so a person who was away from the machine learns nothing.
- **A general "background activity" panel in Epicenter.** Rejected. A person does
  not want to watch timers; they want to know whether their own work landed, and
  that question belongs to the application that owes it.
- **Per-row retry and per-row dismissal.** Rejected. Delivery is a pass, so a row
  that failed did not fail alone, and dismissing one row means undoing an act
  rather than abandoning a delivery.
