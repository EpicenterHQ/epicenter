---
name: consult-claude
description: Obtain a bounded read-only opinion, investigation, recommendation, or text draft from Claude Code. Use when asked to consult Claude, when a task-specific need for an independent Claude perspective is identified, or when a review workflow assigns Claude a role. Completed edits and executable experiments belong to delegate-claude.
---

# Consult Claude

Claude owns a bounded answer and the strategy for finding it: an investigation,
recommendation, caller map, API example, migration assessment, or finished text
draft. The coordinating Codex owns overall continuity, acceptance of the answer,
and any execution it leads to. Use
[delegate-claude](../delegate-claude/SKILL.md) when Claude should own edits or
run an experiment. If the user already authorizes a delivered change, assign
the investigation and implementation together through that route; do not add
an initial consultation merely because the approach is unresolved.

Identify what the consultation adds: a requested Claude opinion, an independent
challenge to a consequential assumption, or a role assigned by a review
workflow. Reasoning, design judgment, or taste alone does not require a handoff.
Once consultation is selected, brief Claude before resolving the assigned
question yourself. Give it the desired outcome, raw source evidence, and enough
ownership to finish the answer. A standalone consultation does not automatically
launch the adversarial reviewer pair.

Use Codex assistance for supporting evidence that Claude can inspect without
giving up its understanding of the problem. Judge the answer by its reasoning,
evidence, and quality of judgment. Elapsed time and usage are context, not the
objective.

## Define the result

Brief Claude with the desired result, intended consumer, source paths, genuine
constraints, acceptance evidence, and stopping condition. For example:

> Trace every caller affected by this rename API. Return a source-linked caller
> map, incompatible assumptions, and the smallest migration proposal. Read the
> current uncommitted source. Stop when every caller class is accounted for;
> request runtime evidence only where it decides compatibility.

Distinguish explicit requirements, observed behavior, and hypotheses. If the
contract is unresolved, assign its discovery rather than assuming a fix.
Check the deciding claims against sources; do not redo the whole investigation.

An exploration can advance a decision by discovering a better destination or an
unknown blind spot; it need not resolve a question already identified. Name the
opportunity the assignment could explore. Claude may propose worthwhile
follow-up investigations, but Codex decides which to commission.

## Make the design legible

Supply the desired outcome, genuine constraints, representative callsites, and
relevant existing implementation excerpts with source paths. Include actual
and proposed API code up front unless an explicitly blind review is selected
under adversarial-review. That skill owns the briefing method. Use an
ASCII diagram when it clarifies ownership, lifecycle, or data flow. Distinguish
observed facts, proposals, assumptions, and preferences. Give enough concrete
evidence to judge the decision; Claude can read further to verify your account.

For a requested adversarial design review, have Claude apply
[adversarial-review](../adversarial-review/SKILL.md) itself without commissioning
another reviewer. Its coordinator owns staffing; this consultation supplies a
Claude reviewer or a standalone opinion. For other design questions, answer the
bounded question from source evidence; a complete architectural review is not
implied. Treat the implementer's reasoning as contestable evidence. Ask for a
concrete smaller alternative when that would decide the question; keeping the
design is valid when its guarantees earn their cost.

## Send a brief

Requires Bun, Git, and authenticated Claude Code 2.1.280 or later with access to
the selected model. New and resumed consultations default to `claude-opus-5-5`
at high effort. Sonnet is an explicit alternative for routine bounded work.
Adversarial architecture reviews use Opus high, including
follow-ups. Use `xhigh` only for a
focused unresolved decision, then return to high. Run from the checkout
containing the evidence; supply the brief directly on stdin:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --account personal --account-email claude@example.com \
  --model claude-opus-5-5 --effort high <<'BRIEF'
[Concrete question, code blocks, source paths, diagram, reasoning, uncertainties.]
BRIEF
```

On macOS, the Codex workspace sandbox can hide Claude Code Keychain login.
Treat a sandboxed `claude auth status` result of `loggedIn: false` as
inconclusive. Request the same status check outside the sandbox. If it reports
true, run the launcher and its follow-ups outside the sandbox. Keep the
launcher read-only Claude restrictions in place; do not log in again, export
credentials, or switch the whole Codex task to Full access for this case.

The launcher runs one native print-mode turn in the current checkout with
Read, Glob, and Grep. Without `--codex`, MCP tools are blocked. With `--codex`,
only the host's read-only evidence tool is configured and approved; Claude can
choose bounded evidence requests while retaining the investigation and judgment.
Read [Codex assistance](references/codex-assistance.md) before enabling it for
setup, limits, result handling, and the difference from `/codex:rescue`.
Restricted mode, disabled hooks, and outside-read restrictions retain the
Claude boundary. The launcher creates no source replica or checkpoint; native
Claude and Codex sessions own conversation history. Keep the reviewed files
stable during each turn. For parallel work, use a source snapshot containing the
relevant committed, uncommitted, and untracked task files. A HEAD-only copy can
omit the proposal. Copy prototype evidence into the selected checkout or run
there; naming an outside path in the brief does not grant access.

Read the native JSON result, including `result`, `session_id`, `is_error`, and
any permission denials. A process starting or exiting successfully is not proof
of a successful consultation. Preserve the session ID for follow-ups.

For an assignment that may outlive the current turn or context, record a
compact locator in existing task notes: native session ID, account and verified
email, absolute checkout, mode, actual model and chosen effort. For a delivery,
add the workspace choice, source baseline, allowed or transferred paths,
completed checks, blocker, and next step. If Codex assistance is enabled, retain
that launch choice, helper model, limits and write roots, and returned helper
IDs. The coordinating Codex owns these notes for every Claude assignment. Native
history owns the full conversation; do not build another session database.
Update the same record as work proceeds.

For an architecture-review follow-up, repeat high effort:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --account personal --account-email claude@example.com \
  --effort high --resume <session_id> <<'EVIDENCE'
[Requested evidence, commands and relevant raw output, changed source, next question.]
EVIDENCE
```

Resume the same session for the same assignment in the same checkout and
account. New evidence or a correction does not need a new conversation; state
source changes and new evidence in the follow-up. Use a fresh session for an
independent review of Claude-authored work or a materially different frame.
The launcher reapplies read-only tools but does not verify the native session's
assignment or original workspace; verify that identity before resuming.
For review of a delivered result, first supply the desired behavior, source
baseline, actual callers, and cumulative diff from the idle assigned checkout or
a snapshot containing that evidence. For a clone delivery, invoke the launcher
by its absolute path in the coordinating checkout, with the clone as the working
directory, so code under review does not set its own access boundary.
Withhold the worker's explanation until the reviewer has reconstructed the
system. Resuming retains context and does not restore independence.
The launcher reapplies the access boundary on every turn. If the shell tool
yields a running process, keep monitoring it and provide progress updates.
There is no interactive attach step.

The launcher sends one fixed brief per turn and provides no mid-turn instruction
channel. Steer at completed-turn boundaries using
[adversarial-review](../adversarial-review/SKILL.md)'s coordination guidance for
design investigations.

The shared launcher owns launch defaults. New consultations, delegations and
resumes use Opus 5.5 high unless explicit `--model` or `--effort` flags override
them. Codex helpers use medium reasoning independently. Repeat any deliberate
nondefault model or effort on each follow-up. A resume retains the same native
conversation history even when the model changes; an older Sonnet conversation
can continue with Opus without starting over. Native command-line effort does
not persist, so the launcher reapplies high on every turn.
`--dry-run` previews launch arguments without invoking Claude. Consult the native
result or transcript before attributing findings to a model: access restrictions
and fallback can change the model used.

### Choose a subscription account

Every launch, including resumes, requires `--account personal|work` and
`--account-email <verified Claude email>`. `personal` uses the existing native
default login; `work` uses `~/.claude-work`. Carry the same account and verified
email into follow-ups. Do not infer a Claude login from a ChatGPT billing email.

The launcher clears inherited Anthropic credentials, endpoints, provider flags,
and secure-storage overrides in the child environment. Native `auth status`
must identify the expected paid claude.ai account and configuration directory
before the brief is sent. Restricted settings apply to both preflight and prompt;
managed policy still applies. Claude resolves `--resume` in the selected profile
and fails if it cannot find the session. The launcher does not inspect transcript
files. Dry-run previews the selection without checking login and prints removed
variable names, never credential values.

Claude owns login, Keychain storage, refresh, and history. For a new work login,
remove conflicting authentication overrides and run the native login with the
user's work email:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login --claudeai --email "work@example.com"
```

The user completes browser login and verifies its Claude email. Keep profile
login changes out of active launches: preflight does not lock the login while
Claude runs. Do not copy credentials between profiles
or log out of the default account. Explicitly setting `CLAUDE_CONFIG_DIR` to
`~/.claude` selects a different Keychain entry from leaving it unset, so the
launcher preserves the unset default for personal. See the official
[multiple-account guidance](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts).

## Adjudicate and continue

Evaluate objections yourself. When Claude requests evidence, run useful checks
within the user's existing authorization and return the commands, relevant raw
results, and source state. An advice-only request does not authorize edits.
Ask before materially expanding the task; prior authorization still applies.

This route remains read-only. When the assignment requires Claude to own
implementation or experimental execution, use delegate-claude only with the
user's explicit authorization for Claude execution.
Return artifacts and evidence, including limitations. A longer report or more
objections does not establish that a consultation was useful.

Return the recommendation, supporting evidence, and remaining disagreement.
Stop when the bounded decision has enough evidence; consensus is not required.

Read [the example and evaluation cases](references/example-workflow.md) when
evaluating this workflow or revising the skills. For launcher changes, verify
`claude --version`, `claude --help`, the official
[CLI reference](https://code.claude.com/docs/en/cli-reference), and
[programmatic usage](https://code.claude.com/docs/en/headless). Native Claude
sessions own conversation history; the launcher owns only access and transport.
