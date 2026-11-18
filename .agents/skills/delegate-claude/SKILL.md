---
name: delegate-claude
description: Hand Claude Code a bounded implementation, prototype, benchmark, or file artifact to deliver itself, using plain `claude -p` with edit permission. Use when Claude should own a piece of work from investigation to result, or when asked to delegate execution to Claude. Read-only questions and text drafts belong to consult-claude.
---

# Delegate Claude

Give Claude a piece of work to own, from deciding how to do it to delivering
the result. Claude reads, edits files, and runs tests in the assigned checkout.
Codex checks the result.

Prefer Claude when design judgment or taste affects the result. Keep purely
mechanical changes with Codex. The user's authorization for the task covers
delegating part of it; it does not cover publishing, deploying, sending
messages, or growing the scope. For a question rather than a change, use
[consult-claude](../consult-claude/SKILL.md).

## Brief the assignment

Describe what should be true when the work is done, why it matters, and who it
affects. Name the behavior that must still work, the starting source, and where
Claude can make changes. Say what checks would establish the result and when
to stop. For an experiment, name the decision its evidence will inform and ask
for observations that distinguish the options.

Let Claude investigate and choose the approach within those requirements. If
you suggest an approach, make clear which parts are suggestions and which parts
are requirements.

Ask Claude to bring back a decision if a missing requirement or tradeoff would
change the agreed result, break an agreed guarantee, or expand the assignment.
Have it pause the affected work and explain what it found, the options and
their consequences, and what it recommends. It can continue work within scope
that does not depend on the decision.

Ask for the changed paths, the checks Claude ran and their actual results, and
anything still unresolved. If blocked, have it return the blocker and any
useful partial work.

> Build and run a reproducible local benchmark to help us decide whether a
> commit should finish before the API responds. Measure commit times for small
> and large folders and record what happens when a Git lock is held. Change
> only the benchmark directory. Stop after measuring those cases and return
> the runnable files, results, and limits of the evidence. Leave the API
> decision to us. If measuring a case requires changing production behavior,
> bring back the proposed change and what that measurement would tell us.

## Choose the checkout

Each checkout has one writer. While Claude works in a checkout, Codex and other
agents do not edit it.

- **The current checkout.** Record `git status` first and name the allowed
  paths in the brief, so the review can separate Claude's changes from work
  that was already there.
- **A separate worktree,** when Codex keeps editing the current checkout or
  the experiment should not touch it:
  `git worktree add ../<name> -b <branch>`. Copy in any uncommitted files the
  assignment needs. Its result reaches the main checkout only when Codex
  applies it.

Install dependencies before sending the assignment. Claude has no browser or
desktop tools, so name the visual and native-app checks Codex will run itself.

## Send it

Run from the assigned checkout:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  claude -p --setting-sources project --strict-mcp-config \
  --mcp-config '{"mcpServers":{"deepwiki":{"type":"http","url":"https://mcp.deepwiki.com/mcp"}}}' \
  --permission-mode acceptEdits \
  --allowedTools 'Bash(bun test:*)' 'Bash(bun run:*)' \
    'Bash(git status:*)' 'Bash(git diff:*)' 'Bash(git log:*)' \
    WebSearch mcp__deepwiki \
  --model claude-opus-5-5 --effort high --output-format json <<'ASSIGNMENT'
[Result, who it affects, what must still work, allowed paths, checks, when to stop.]
ASSIGNMENT
```

- `--permission-mode acceptEdits` lets Claude edit files inside the checkout.
  Writes outside it are refused.
- `--allowedTools` lists the only shell commands Claude can run: tests, package
  scripts, and read-only Git. Anything else, including `git add`, `git commit`
  and `git push`, is refused and appears in `permission_denials`. If the
  assignment needs another command, add a narrow entry for it.
- `--setting-sources project` keeps the repository's own rules, such as
  refusing to read `.env`, and drops personal settings that would allow more.
- DeepWiki and web search let Claude check library behavior itself, as in
  consult-claude. `env -u`, the work account, and the Codex sandbox login fix
  also work as in [consult-claude](../consult-claude/SKILL.md#send-it).

## Follow up

Read `result`, `is_error`, `session_id` and `permission_denials` from the JSON.
A successful exit does not mean the work is done; the review decides that.

For a failed check, new evidence, or a correction, resume the same session
from the same checkout with the same flags plus `--resume <session_id>`. Say
what is still accepted, what failed, and paste the raw output.

## Review the result

Inspect the diff before running any code Claude wrote. Use a Git command that
ignores hooks a worker could have changed:

```bash
git -c core.fsmonitor= -c core.hooksPath=/dev/null diff --no-ext-diff <baseline>
git -c core.fsmonitor= -c core.hooksPath=/dev/null ls-files --others --exclude-standard
```

Check that only the allowed paths changed, then rerun the checks that decide
acceptance, especially the ones Claude could not run. Note which evidence came
from Claude and which you reproduced. Send a focused failure back to the same
session instead of editing alongside Claude.

For an independent judgment of Claude's work, start a fresh
[consult-claude](../consult-claude/SKILL.md) session and give it the desired
behavior and the diff before Claude's explanation. Two models agreeing does not
prove the result correct.

After acceptance, Codex resumes edits in that checkout and owns what follows.
