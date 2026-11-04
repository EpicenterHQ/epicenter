---
name: agent-goal
description: Draft a `/goal` line that gives long-running Codex or Claude Code work an objective, validation evidence, and a stop condition. Use when the user explicitly asks for `/goal`, an agent goal, or a completion condition.
---

# Agent Goal

Write one `/goal` line that a coding agent can keep pursuing until the transcript proves the work is done.

This skill owns the slash-goal artifact. Do not use it for ordinary prompt
drafting, handoffs, continuation prompts, delegation briefs, or prompt
engineering.

## Shape

```txt
/goal <single objective> in <lane> until <observable evidence proves completion>. First read <starting context>. Work in checkpoints and surface <validation evidence> after each checkpoint.
```

Answer these in order, then compress them into one line:

```txt
What should change?
Where should the agent start?
What evidence proves it changed?
When should the agent stop?
```

Include only execution-critical detail:

- Objective: one concrete outcome, not a backlog of unrelated wishes.
- Lane: files, packages, apps, issues, specs, or the intended work area.
- Starting context: the first files, plans, logs, screenshots, or acceptance criteria to read.
- Evidence: command output, tests, build result, screenshot check, eval score, file count, or reviewed artifact.
- Stop condition: the exact transcript-visible state that means the goal is achieved.

## Rules

1. Start the answer with `/goal` when the user asks for the goal text.
2. Make completion judgeable by someone who can only read the transcript.
3. Prefer exact checks over vague proof: "`bun test packages/account` exits 0" beats "tests pass."
4. Point long requirements at a file instead of pasting them into the goal.
5. Ask for checkpoints when the work spans multiple turns.
6. Bound repeated failure: after three failed attempts on the same check, report the root cause and next decision.
7. Do not create a `/goal` for vague wishes, open-ended research, unrelated chores, or work with no observable evidence.

## Platform Note

Different agents may evaluate goals differently, but the portable rule is the
same: the goal should not rely on hidden state. Tell the agent to run checks and
surface evidence in the transcript.

## Check

Before handing back a goal, verify:

- It has one main objective.
- It names where to start.
- It names the evidence that proves completion.
- It tells the agent to surface that evidence.
- It tells the agent when to stop.
