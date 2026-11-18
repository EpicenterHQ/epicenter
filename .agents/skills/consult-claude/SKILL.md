---
name: consult-claude
description: Ask Claude Code a read-only question and get its own answer, using plain `claude -p`. Use when a question benefits from Claude's reasoning or taste, when the user asks for Claude's take or critique, or when Claude is a reviewer in an adversarial review.
---

# Consult Claude

Ask Claude to think through a question and give us its own answer. Claude
reads the checkout; it cannot run commands or change files. To have Claude
deliver a change, use [delegate-claude](../delegate-claude/SKILL.md).

Bring Claude in early, while its judgment can still shape the result.

## Brief the question

Give Claude the question, why it matters, and the files it should read. Say
what would settle the question, and separate what you observed from what you
assume.

If the user wants Claude's own take, let it form a view before you share
yours. If the user wants a critique, put the proposal and its reasoning in the
first brief. For an adversarial review, follow
[adversarial-review](../adversarial-review/SKILL.md) for briefing and staffing.

A brief from this repository:

> `@epicenter/cli` and `@epicenter/app` are released at one version, and the
> command checks for a second copy of the library before loading an app. Read
> `packages/app/README.md`, `packages/cli/README.md` and the command's loader.
> Is there still a reason for two packages, or should the command fold into
> `@epicenter/app`? Name each thing that depends on the split. The answer
> decides whether we retire `@epicenter/cli`.

## Send it

Run from the checkout Claude should read:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  claude -p --setting-sources project --strict-mcp-config \
  --mcp-config '{"mcpServers":{"deepwiki":{"type":"http","url":"https://mcp.deepwiki.com/mcp"}}}' \
  --tools Read,Glob,Grep,Skill,WebSearch --allowedTools WebSearch mcp__deepwiki \
  --model claude-opus-5-5 --effort high --output-format json <<'BRIEF'
[Question, why it matters, files to read, and what would settle it.]
BRIEF
```

- `env -u` removes API keys and proxies, so the call uses the Claude
  subscription login instead of billing an API key.
- `--tools` leaves Claude only reading, the repository's skills, web search,
  and DeepWiki. It cannot write files or run commands, and reads outside the
  checkout are refused.
- `--strict-mcp-config` with `--mcp-config` gives Claude DeepWiki and no other
  MCP server, so it can check library behavior itself. Leave library questions
  to Claude rather than researching them first and pasting the answers into the
  brief: Claude knows which details its reasoning depends on.
- `--setting-sources project` keeps `AGENTS.md`, the skills and the
  repository's permission rules, and drops personal settings that would allow
  more. Do not use `--restricted`: it also hides `AGENTS.md` and every skill,
  so Claude answers without the repository's conventions.
- The default login is the personal account. For the work account, prefix the
  command with `CLAUDE_CONFIG_DIR="$HOME/.claude-work"`. Check which account
  is active with `claude auth status` once per task.
- If `claude auth status` reports `loggedIn: false` inside the Codex sandbox,
  the sandbox is hiding the macOS Keychain. Run the command with a sandbox
  exception rather than logging in again.

Keep the files Claude is reading unchanged until it answers.

## Read the answer and follow up

The JSON output has `result` (the answer), `is_error`, `session_id`, and
`permission_denials`. Check the claims that drive the decision against the
source yourself.

A run cannot be steered once it starts, so steer between turns. Keep each
brief to one question, and ask Claude to stop and say so when the answer turns
on something only the user can decide. To continue the same conversation with
new evidence or a correction, run the same command from the same checkout with
`--resume <session_id>`. Say what
changed and ask the next question. If Claude asks for a test or command
output, run it and paste the output into the follow-up. Start a fresh session
when you need an independent review of Claude's own work.

Return Claude's answer, the evidence behind it, and any disagreement that
matters to the decision.
