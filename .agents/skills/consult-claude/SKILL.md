---
name: consult-claude
description: Assign Claude Code a read-only investigation, recommendation, or finished text draft. Use when asked to consult Claude or when a design-review workflow includes Claude. Completed edits and executable experiments belong to delegate-claude.
---

# Consult Claude

Claude owns a bounded answer: an investigation, recommendation, caller map,
API example, migration assessment, or finished text draft. Codex owns the
conversation, execution, verification, and integration. Use
[delegate-claude](../delegate-claude/SKILL.md) when Claude should own edits or
run an experiment.

When the user's request or chosen workflow includes Claude, choose a
consultation whose result advances a named decision or replaces
work Codex would otherwise do. Give Claude enough work to finish the answer;
available capacity alone does not justify another opinion. A standalone
consultation does not automatically launch the adversarial reviewer pair.

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
relevant existing implementation excerpts with source paths. For a blind
adversarial design pass, withhold proposed API code and your engineering
reasoning until Claude has answered from the outcome and callers. Then supply
the proposal, reasoning, and unresolved questions in the same session. For
other consultations, include actual and proposed API code up front. Use an
ASCII diagram when it clarifies ownership, lifecycle, or data flow. Distinguish
observed facts, proposals, assumptions, and preferences. Give enough concrete
evidence to judge the decision; Claude can read further to verify your account.

For design questions, have Claude apply
[adversarial-review](../adversarial-review/SKILL.md) itself, without launching another
reviewer. That skill's coordinator owns reviewer selection; this consultation
supplies its Claude reviewer or a standalone Claude opinion. A standalone
request for Claude's opinion does not itself launch a Codex reviewer. Explicitly
ask for the strongest greenfield direction: starting from the desired outcome
and actual callers, what would it build if the current abstraction did not
exist? Treat your reasoning
as evidence, not constraints.
Ask for concrete signatures and callsites, what disappears, new complexity, and
requirements being questioned. Keeping the design is valid when it earns its
place. A narrow question does not require a full architectural report.

## Send a brief

Requires Bun, Git, and authenticated Claude Code 2.1.280 or later with access to
the selected model. A new consultation requires an explicit `--model`. Choose
`claude-sonnet-5-5` with `--effort medium` for a bounded caller map, ordinary bug
investigation, or draft. Choose `claude-opus-5-5` with `--effort high` for an
open-ended design question or consequential judgment. Adversarial architecture
reviews explicitly use Opus high, including follow-ups. Use `xhigh` only for a
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

The launcher runs one native print-mode turn in the current checkout with only
Read, Glob, and Grep. Restricted mode, blocked MCP tools, disabled hooks, and
outside-read restrictions enforce the boundary. It creates no replica, brief
file, or checkpoint. Claude Code owns session storage. Keep the reviewed files
stable during each turn. For parallel work, use a source snapshot containing the
relevant committed, uncommitted, and untracked task files. A HEAD-only copy can
omit the proposal. Copy prototype evidence into the selected checkout or run
there; naming an outside path in the brief does not grant access.

Read the native JSON result, including `result`, `session_id`, `is_error`, and
any permission denials. A process starting or exiting successfully is not proof
of a successful consultation. Preserve the session ID for follow-ups.

For an architecture-review follow-up, repeat high effort:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --account personal --account-email claude@example.com \
  --effort high --resume <session_id> <<'EVIDENCE'
[Requested evidence, commands and relevant raw output, changed source, next question.]
EVIDENCE
```

Resume a completed consultation for the same assignment in the same checkout.
Supply changed source, new evidence, and the next question explicitly. The
launcher reapplies read-only tools but does not verify the native session's
assignment or original workspace; verify that identity before resuming. Use a
fresh session for independent exploration, an independent review, or a
materially different frame. See `delegate-claude` for reviewing a worker's
result. Resuming retains context: a challenge to another proposal or Codex's
synthesis is an informed follow-up, not blind discovery.

The launcher sends one fixed brief per turn, reapplies the access boundary on
every turn, and provides no mid-turn instruction channel or interactive attach.
Steer at completed-turn boundaries using
[adversarial-review](../adversarial-review/SKILL.md)'s coordination guidance for
design investigations. If the shell tool yields a running process, monitor it
and keep the user informed.

A new consultation requires `--model`. On resume the launcher supplies no model
or effort default: Claude Code restores the session's model, while command-line
effort must be repeated. Explicit `--model` overrides that session's model.
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
