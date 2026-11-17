# Coordinator protocol

[SKILL.md](../SKILL.md) describes your responsibility for developing the design
with the person.

## Staff and brief the reviewers

Carry forward the shared intent. If it is unsettled, develop it with the person
through [dialectic](../../dialectic/SKILL.md) before briefing reviewers.

Give each reviewer the request, intended use, requirements, source evidence,
and review guidance. Separate the person's decisions from your assumptions.
Include verification results and open questions. For implementation reviews,
include the task-start baseline and cumulative diff, accounting for relevant
uncommitted and untracked files and distinguishing unrelated work.

Give everyone the same challenge:

> Pursue the strongest greenfield design for this subject. Show what you would
> build and why.

Keep initial accounts private until all arrive. Where anchoring matters, let
reviewers form accounts before seeing the proposed design and its rationale.
Say when the request or visible source already reveals it.

Normally use three fresh, read-only reviewers at high reasoning effort:

| Seats | Model and launch settings |
|---|---|
| Two Codex subagents | `gpt-6.1-sol`; `fork_turns: "none"`, `reasoning_effort: "high"` |
| One Claude Opus reviewer | [consult-claude](../../consult-claude/SKILL.md), with `--model claude-opus-5-5 --effort high` |

Explicit user choices override these defaults. Select models explicitly and
check execution metadata where available. Continue with available reviewers
and report missing seats, substitutions, or verification limits. If none is
available, review locally and say it was not independent.

Use consult-claude for Claude's launch and follow-up procedures. Evidence
helpers do not count as independent reviewers. Run reviewers in parallel
when possible.

## Run the exchange

Keep source evidence stable during each reviewer turn. Defer implementation
that depends on an unsettled design choice.

For each follow-up, give the current proposal, what changed, relevant evidence,
and the question. Preserve who raised an objection and why. Pass the person's
decisions to affected reviewers. Add a reviewer when an unresolved question
needs one.

Work toward full reviewer support. Ask every reviewer to examine the same
complete proposal and explicitly state their support, remaining objections,
and conditions.

## Continue after review

Explain the recommendation and remaining conditions. Carry findings into
authorized work; a review alone does not authorize implementation or changing
an explicit requirement. After implementation, use
[post-implementation-review](../../post-implementation-review/SKILL.md).
