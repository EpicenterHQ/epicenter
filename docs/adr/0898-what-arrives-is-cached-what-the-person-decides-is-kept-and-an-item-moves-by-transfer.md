# 0898. What arrives is cached, what the person decides is kept, and an item moves by transfer

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Amends:** [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md) at "Forms compose", which did not say what happens to an item at its source; at rule 4's "written only by the app's own pull", which a file syncer bringing Whispering's recordings home does not fit; and at "Not yet", which filed refusals beside things that wait.
- **Relates:** [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (a world verb is safe to repeat), [ADR-0882](0882-mail-leaves-mail-in-gmail-and-agents-change-it-through-proposals-the-person-applies.md) (Mail: proposals kept, the person applies).
- **Unbuilt:** an `add` that answers done for the same id and content (`packages/app/src/collection.ts:725` refuses an existing path), and files beside a record (`packages/app/src/path.ts:79` takes `.md` only).

## Context

The owner asked how tasks from Todoist or a phone could be pulled into
Epicenter, moved into Tasks by an agent, "and they keep in sync over time".
Three reviewers, asked for the most cohesive long-term direction, each found
that phrase to be the one arrangement ADR-0896 must refuse: two writable lists
kept in step by an agent is reconciliation.

They also found that Mail already built the pattern every source-facing app
will need. Gmail's mailbox is cached; an agent writes `proposals/`, keyed by
Gmail's ids, which are kept; the person runs `apply`, which changes Gmail and
pulls.

## Decision

**What arrives from elsewhere is cached or live. What the person decides about
it is kept, keyed by the source's id. Changing the source is an action. An item
moves into a kept collection by transfer: it is written there, then closed at
its source. Nothing is ever kept in step with a copy.**

| Verb | What it does | Example |
| --- | --- | --- |
| pull | copies a source's items inward; never writes the source | Gmail, a Todoist inbox, Whispering's folder |
| move | writes the kept item carrying `from: <source>/<id>`, then closes the item at the source | a Todoist item becomes a task, then is completed in Todoist |
| act | changes the source through its own action, then pulls what changed | Mail's `apply` |

- **What the person makes is kept by default.** A collection becomes cached
  only when the person chooses to keep editing it elsewhere, as Gmail's
  mailbox is; then writes go through `act`, and its file edits are lost.
- **Copying works only for what is never edited elsewhere.** Recordings,
  arrivals in an inbox, and Gmail's messages are append-only to Epicenter. A
  record edited in two places is the folder sync product, refused.
- **A copy is written only by its pull, whoever runs it:** the app's own
  action, or a file syncer the person chooses. A stray edit is snapshotted,
  then replaced, only by a pull that rewrites files; a pull that only adds
  files leaves it.
- **Apps never import, call, or subscribe to each other.** A person or an
  agent joins them through actions. A move repeated often is a prompt the
  agent runs, then an action in a personal app, never a link between apps.
- **Scheduling is the host's.** launchd, cron, or an agent's routine may call
  `epicenter <app> <action>`; Epicenter builds no scheduler.

### Never

Each would bring back what ADR-0840 set aside. Building one needs a new record
that supersedes this one.

- reconciling two writable copies, or an id mapping that keeps two lists in step;
- a queue of edits made while the truth was unreachable;
- an event bus, triggers, or a workflow engine between apps;
- a hosted home;
- a collection form that `serve` acts on.

### Next, in order, each tied to its need

1. **The vault as a folder app** (ADR-0897's month).
2. **An `add` that answers done for the same id and content.** Every move and
   every retry needs it.
3. **Files beside a record.** Audio comes home with recordings; mail has
   attachments.
4. **Freshness in each pull's status,** when it last ran and how complete, as Mail's reads already answer.
5. **Which kind of caller wrote, a person or an agent,** named in commits, so
   an action can be refused to agents. Mail's "agents never apply" is
   unenforced today.

## Consequences

- Every source-facing app has one shape: a pull, kept decisions keyed by the
  source's id, and acts.
- After a move, the source's copy is dead to Epicenter; nothing flows back.
- Tasks stays kept. Todoist, Reminders, or a phone's own apps can be intakes
  that an agent empties into Tasks.

## Considered alternatives

- **An agent keeps Tasks and Todoist in step.** Reconciliation by agent, with
  an id mapping and a rule for when both change.
- **A local-first tasks program on the phone, pulled into Epicenter.** Its
  tasks are edited on both sides; Whispering's pattern works only because
  recordings are not.
- **`serve` runs each app's pull on its clock.** ADR-0882 rejected it for Mail,
  whose reads catch up; reconsider when an agent greps a committed pulled copy
  that nothing refreshes.
