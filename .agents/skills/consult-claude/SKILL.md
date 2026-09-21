---
name: consult-claude
description: Get Claude Code's second opinion on a proposal or implementation. Use when the user asks to consult Claude, requests Claude's design judgment or research, or has asked to include Claude during design review. Do not enlist Claude merely because a task is complex.
---

# Consult Claude

Codex briefs Claude on the problem, proposed design, and reasoning. Claude reads
the current checkout and returns its judgment, alternatives, and objections.
Codex owns implementation and verification; when Claude needs a test, benchmark,
or experiment, it requests that evidence from Codex.

## Make the design legible

Supply the desired outcome, genuine constraints, actual and proposed API code,
representative callsites, relevant implementation excerpts with source paths,
and your engineering reasoning and unresolved questions. Use an ASCII diagram
when it clarifies ownership, lifecycle, or data flow. Distinguish observed facts,
proposals, assumptions, and preferences. Give enough concrete evidence to judge
the decision immediately; Claude can read further to verify your account.

For design questions, appoint Claude as the reviewer and have it apply
[adversarial-review](../adversarial-review/SKILL.md) itself, without launching another
reviewer. Explicitly ask for the strongest greenfield direction: starting from
the desired outcome and actual callers, what would it build if the current
abstraction did not exist? Treat your reasoning as evidence, not constraints.
Ask for concrete signatures and callsites, what disappears, new complexity, and
requirements being questioned. Keeping the design is valid when it earns its
place. A narrow question does not require a full architectural report.

## Send a brief

Requires Bun, Git, and authenticated Claude Code 2.1.257 or later with access to
the selected model. Run from this repository; supply the brief directly on stdin:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts <<'BRIEF'
[Concrete question, code blocks, source paths, diagram, reasoning, uncertainties.]
BRIEF
```

The launcher runs one native print-mode turn in the current checkout with only
Read, Glob, and Grep. Restricted mode, blocked MCP tools, disabled hooks, and
outside-read restrictions enforce the boundary. It creates no replica, brief
file, or checkpoint. Claude Code owns session storage. Keep the reviewed files
stable during each turn; identify changed files when supplying fresh evidence.

Read the native JSON result, including `result`, `session_id`, `is_error`, and
any permission denials. A process starting or exiting successfully is not proof
of a successful consultation. Preserve the session ID for follow-ups.

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts --resume <session_id> <<'EVIDENCE'
[Requested evidence, commands and relevant raw output, changed source, next question.]
EVIDENCE
```

Resume only a completed consultation from this launcher, in the same checkout.
The launcher reapplies the access boundary on every turn. If the shell tool
yields a running process, keep monitoring it and provide progress updates.
There is no interactive attach step.

`--model` selects a model; the default remains `claude-fable-5-1`.
`--dry-run` previews launch arguments without invoking Claude. Consult the native
result or transcript before attributing findings to a model: access restrictions
and fallback can change the model used.

## Adjudicate and continue

Evaluate objections yourself. When Claude requests evidence, run useful checks
within the user's existing authorization and return the commands, relevant raw
results, and source state. An advice-only request does not authorize edits.
Ask before materially expanding the task; prior authorization still applies.

Codex normally runs experiments. If the user explicitly delegates experimental
execution to Claude, arrange an appropriately isolated workspace for that task
separately. This launcher never grants write or execution tools, and elapsed
time alone does not justify a new workspace or broader delegation.

Return the recommendation, supporting evidence, and remaining disagreement.
Stop when the bounded decision has enough evidence; consensus is not required.

Read [the example and evaluation cases](references/example-workflow.md) when
evaluating this workflow or revising the skills. For launcher changes, verify
`claude --version`, `claude --help`, the official
[CLI reference](https://code.claude.com/docs/en/cli-reference), and
[programmatic usage](https://code.claude.com/docs/en/headless). Native Claude
sessions own conversation history; the launcher owns only access and transport.
