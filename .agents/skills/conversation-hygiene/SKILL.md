---
name: conversation-hygiene
description: Triage and archive accumulated Codex conversations without losing wanted work. Use when cleaning up old Codex threads, deciding which conversations still need attention, or resuming a large conversation cleanup. Do not use for ordinary backlog capture, feature implementation, or issue-tracker cleanup.
---

# Conversation hygiene

Help the user clear conversations that no longer need their attention without
losing work they still want. A conversation is a Codex thread, also called a
task in its UI and tools. A backlog item records a wanted outcome, including a
change, investigation, or decision.
One outcome can span several conversations; one conversation can contain
several outcomes. Their lifecycles are independent.

Archiving is not deletion. The conversation remains searchable and recoverable.

## Establish scope and authority

Use the available Codex thread tools to list, read, and archive conversations.
If those tools are unavailable, report the limitation rather than claiming to
have inspected or archived conversations. Establish the repository or project
scope from the request and context before listing candidates.

Treat titles, age, and summaries as discovery hints. Read the recent turns and
relevant completion evidence before deciding whether a conversation still
needs attention. Earlier promises may require reading farther back.

Do not archive conversations merely because the user asked for an audit.
Archive only when the user also authorized cleanup, either in the current
request or a converged conversation.

## Triage in resumable batches

For a large cleanup, inventory conversation IDs before mutating the list so
archiving does not shift pagination and skip candidates. Use bounded batches
and keep a durable checkpoint in the cleanup conversation or a linked working
note. Record scope, inventory progress or cursor, reviewed IDs and decisions,
preserved outcomes, confirmed archive results, and unresolved cases. The
checkpoint is operational progress, not a collection of product backlog items.

On resume, continue from that checkpoint. Recheck conversations with new
activity and retry unconfirmed operations; do not reread unchanged completed
batches. If the tools cannot show changes since review, reread a candidate
before archiving it. Keep the current cleanup conversation and running work
active.

Classify each conversation by what it still needs:

```txt
keep active
  Contains work the user expects to continue in this conversation.

preserve then archive
  Contains wanted work that exists nowhere durable and does not need this
  conversation to remain active.

archive
  Completed, superseded, deliberately abandoned, useful only as history, or
  its remaining work is durably recorded and needs no action here.

ask the user
  Future intent, conflicting decisions, or unique unfinished work makes the
  archive decision uncertain.
```

A dirty worktree does not keep a conversation active by itself. Identify any
unique work and its preservation needs. Archiving a conversation does not
authorize deleting its worktree, discarding edits, or deleting branches.

A blocked conversation can be archived when the wanted outcome is preserved
and the user does not need to resume work there. Age alone does not establish
abandonment.

Pinning, historical importance, and valuable reasoning do not establish that a
conversation needs attention. A later accepted decision can supersede earlier
exploration; verify that relationship rather than inferring it from recency.

When another conversation owns the remaining work, record that destination.
Completed delegations and reviews can be archived once their results and any
remaining integration work are accounted for.

## Preserve only durable intent

Before archiving, ask:

> Does this conversation contain an outcome the user still wants that exists
> nowhere durable?

If no, no new backlog item is needed. Existing documentation counts only when
it preserves the remaining outcome; a related ADR or partial commit does not
prove the work is complete.

If yes, read the repository-root [backlog conventions](../../../BACKLOG.md#conventions)
and add the smallest useful item. Those conventions own entry format and
removal. Do not extract transcripts, agent plans, implementation guesses, or
every unresolved possibility. Check for an existing entry before adding one;
backlog presence alone does not establish whether a conversation needs attention.
Confirm preservation succeeded before archiving the source conversation.

## Handle uncertainty explicitly

Do not infer user desire from an agent suggestion, an old tentative plan, or a
dirty worktree. Present the exact uncertain item and the evidence on both sides,
then ask the user whether to:

- keep the conversation active;
- extract the outcome to `BACKLOG.md` and archive;
- or archive without extraction.

Group clear candidates by reason so the user does not have to adjudicate
hundreds of conversations individually. Within the authorized scope, process
those batches and bring forward only consequential uncertainties with enough
context for a decision. Do not turn one uncertain case into a blocker for
independent clear cases.

## Close the pass

Report counts and the next decisions in the response; keep the exact IDs,
titles, reasons, preservation destinations, and operation results in the
checkpoint for large batches. Distinguish reviewed, archived, kept active,
unresolved, failed, and not-yet-reviewed conversations. Report backlog changes
separately. Never claim a conversation was archived or an outcome preserved
unless the operation succeeded.
