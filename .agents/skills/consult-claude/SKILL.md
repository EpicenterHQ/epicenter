---
name: consult-claude
description: Give Claude ownership of a read-only investigation, recommendation, or text draft. Use when a question benefits from Claude's reasoning or taste, when the user asks for Claude's take or critique, or when Claude is a reviewer in an adversarial review.
---

# Consult Claude

Ask Claude to think through a question and give us its own answer.

Claude owns the answer. Codex checks the claims that drive the decision and
handles any authorized execution. Bring Claude in early, while its judgment
can still shape the result. When Claude should deliver a change or run an
experiment, use [delegate-claude](../delegate-claude/SKILL.md) and assign the
investigation and delivery together.

## Brief the question

Give Claude the question, why it matters, and the source it needs to answer.
Say what would settle the question. Point to current files and callers, and
distinguish requirements and observed behavior from assumptions.

If the user wants Claude's own take, let it form a view before sharing yours.
Compare the reasoning after Claude answers. If the user wants a critique,
include the proposal and its rationale in the first brief.

For an adversarial review, follow [adversarial-review](../adversarial-review/SKILL.md)
for briefing and staffing. Have Claude perform its assigned review itself.

## Send a brief

Run from the checkout containing the evidence. The launcher gives Claude
read-only access to that checkout for one turn per brief. Keep the source
stable during the turn. For parallel work or a delegated clone, see
[preparing review source](references/launcher.md#prepare-source-for-a-review).

Every turn requires `--account personal|work` and
`--account-email <verified Claude email>`. Use the
[launcher reference](references/launcher.md#choose-a-subscription-account)
for account setup and login troubleshooting. The launcher defaults to Opus
5.5 at high effort. Pass any model and effort required by the assignment
explicitly.

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --account personal --account-email claude@example.com <<'BRIEF'
[Question, why it matters, source paths, and what would settle it.]
BRIEF
```

For optional read-only evidence gathering by a Codex helper, see
[Codex assistance](references/codex-assistance.md).

## Review the answer and follow up

Monitor the launcher until it finishes. Read the native JSON `result`,
`is_error`, and any permission denials. Save the `session_id` and check
the actual model in the result when attribution matters.

Check the deciding claims against the source. If Claude asks for a useful check
within the user's authorization, run it and share the command and relevant
output. Resume the same assignment with `--resume <session_id>` from the same
checkout and account. Repeat any explicit model, effort, and helper options.
Say what changed, include the new evidence, and ask the next question. Start
a fresh session for an independent review of Claude-authored work. For work
that spans contexts, [record how to resume](references/launcher.md#record-a-session-for-continuation).

Return the answer, the evidence that supports it, and any open disagreement
that matters to the decision. Stop when the question has enough evidence to
move forward. See [the example workflow](references/example-workflow.md) when
evaluating how the consultation went.
