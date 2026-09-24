---
name: conversation-hygiene
description: Triage and archive accumulated Codex conversations without losing wanted work. Use when cleaning up old Codex threads, deciding which conversations still need attention, or resuming a large conversation cleanup. Do not use for ordinary backlog capture, feature implementation, or issue-tracker cleanup.
---

# Conversation hygiene

Clear tasks that no longer need attention while giving every still-wanted
outcome a durable continuation. A task and an outcome have separate lifecycles:
one outcome may span several tasks, and one task may contain several outcomes.
Archiving is reversible; it does not delete the task.

The archive proposal is the unit of work. It must let the user judge the exact
tasks and any preservation changes without reopening the source conversations.
Keep supporting evidence in the cleanup checkpoint, where the next pass can
resume it.

## Gather evidence in bounded batches

Establish the repository or project scope. Use Codex thread tools to list and
read tasks, and to archive and verify them. If those tools are unavailable,
report the limit rather than claiming to have inspected or archived tasks.
Treat titles, age, and summaries as discovery hints; read recent turns and
relevant completion evidence. Earlier promises may require reading farther
back. Check current code, decisions, specs, and backlog before treating a
claimed implementation or destination as complete. An ADR alone does not prove
implementation.

Inventory IDs before archiving so pagination shifts cannot skip candidates.
Work in bounded batches and keep a checkpoint in the cleanup task or a linked
working note: scope, inventory progress, reviewed IDs and reasons, preservation
destinations, approved actions, verified archives, and unresolved cases. This
checkpoint tracks cleanup progress, not product backlog. On resumption, recheck
tasks with new activity and retry unconfirmed operations; do not reread an
unchanged completed batch. Keep the cleanup task and running work active.

For a large inventory across products or long histories, subagents may read
bounded sets of exact IDs and return compact evidence about completion,
remaining user intent, existing destinations, and uncertainty. Give them
read-only work. The main agent verifies their findings against current task and
repo state, integrates the proposal, and owns preservation and archiving. A
small batch needs no delegation.

## Account for each outcome

First decide whether work must continue in this task. Keep active implementation
and conversations the user expects to resume there. A dirty worktree alone does
not keep a task active; archiving never authorizes discarding its worktree,
edits, or branch.

For a task that no longer needs attention, account for every remaining outcome:

- If nothing is still wanted, propose archive. Completion, a later accepted
  decision, or deliberate abandonment can establish this; age and an agent's
  tentative plan cannot.
- If a wanted outcome is already durable, name its destination and propose
  archive. Check that it actually preserves the remaining outcome. A related
  ADR, partial commit, or backlog item is not enough by association.
- If a wanted outcome exists nowhere durable, propose the smallest useful
  [backlog item](../../../BACKLOG.md#conventions), then archive after its
  preservation is confirmed. The backlog can hold a change, investigation, or
  decision, including future work on skills or documentation. Do not extract
  transcripts, agent plans, implementation guesses, or superseded ideas. If an
  independently authorized edit has already completed the outcome, count that
  as completion instead of creating a backlog item.
- If intent is unclear, explain the specific outcome and the evidence for and
  against preserving it. Recommend a path and ask a focused question. The
  answer determines whether to keep active, preserve then archive, or archive.
  Continue independent clear cases while this one remains unresolved.

A blocked task can close when its wanted outcome has a destination and the user
does not need to resume that task. Pinning, historical importance, and valuable
reasoning do not by themselves require attention. When another active task owns
the work, name it as the continuation. Completed delegations and reviews can
close once their results and any remaining integration work are accounted for.

## Propose a decision the user can make

Lead with the recommended batch. Group exact IDs by reason, then give only
consequential exceptions their own short explanation. For each preservation
change, show the proposed outcome and its destination. Explain uncertain cases
with enough context, consequence, and recommendation that the user can answer
without reading the source task. Use bullets or a compact diagram when they
make the choice easier to see; do not hand over an audit table or an unexplained
label. Ask only questions whose answers change the proposed action.

Show the exact archive IDs and proposed backlog edits before requesting
approval when approval is required. An audit request alone is not permission
to archive. Honor the user's standing approval preferences. Approval for one
batch does not authorize the next batch.

## Execute and close

Once authorized, recheck each authorized task for new activity. Preserve
authorized outcomes first and confirm the write succeeded. Archive only
authorized IDs with Codex thread tools, then verify each in archived-task
state. If preservation fails, leave its source task unarchived. Do not infer
success from a mutation response alone.

Report reviewed, archived, kept active, unresolved, failed, and not-yet-reviewed
counts separately. Report backlog changes separately. Keep exact IDs, titles,
reasons, destinations, and operation results in the checkpoint so the next
batch starts from verified state.
