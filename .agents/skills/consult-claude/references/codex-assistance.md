# Codex assistance for Claude-owned work

The coordinating Codex fixes the assignment and access. Claude owns its reasoning
and delivery, can request evidence or bounded implementation from Codex, and
remains responsible for checking the returned work. The coordinating Codex owns
continuity and focused acceptance; it pauses its edits to the assigned checkout
and does not repeat the investigation or copy the result. Available capacity
alone does not earn a handoff.
The objective is better reasoning, design judgment, and delivered work. Prefer
Claude for choices where its reasoning or taste can improve the result; Codex
absorbs supporting work while Claude retains the understanding needed to judge
it. Claude defaults to Opus 5.5 high and Codex helpers to medium. Elapsed time,
attention, and usage are context rather than objectives for this workflow.

## Enable the capability

Requires Bun, Git, authenticated native Claude Code, and Codex CLI with native
ChatGPT login. Install the skill's protocol dependency once:

```bash
bun install --ignore-scripts --cwd .agents/skills/consult-claude
```

Add `--codex --codex-model <selected-model>` to the shared launcher. Choose the
helper model explicitly; the helper uses medium reasoning effort. For example:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --account personal --account-email claude@example.com \
  --model claude-opus-5-5 --effort high \
  --codex --codex-model gpt-6.1-sol <<'BRIEF'
Own the storage-ownership investigation. Ask the evidence helper for the teardown
caller map; inspect deciding sources yourself. Return the smallest supported
design, behavior that must survive, costs and unresolved uncertainty.
BRIEF
```

This retains the native Claude CLI and subscription identity checks; it does not
migrate authentication to an API SDK. The host registers one stdio MCP server,
with no other configured MCP servers or general child-agent tools. The old
native `codex mcp-server` was removed; this server adapts `codex exec --json`
instead. Native Codex owns the helper's history and returns its session ID.

## Who can do what

| Launch | Claude | Codex assistance |
| --- | --- | --- |
| Consultation without `--codex` | Read, Glob, Grep | None |
| Consultation with `--codex` | Read, Glob, Grep | `evidence`: read-only investigation |
| Delegation without `--codex` | Read, Glob, Grep, Edit, Write, sandboxed Bash | None |
| Delegation with `--codex` | Read, Glob, Grep | `evidence` plus `implement`: edits and checks in the assigned checkout, plus host-selected skill write roots |

In helper-backed delivery Codex is the sole code writer. Claude inspects and
directs; the coordinating Codex pauses its edits to the assigned checkout until
Claude returns. The host rejects overlapping helper calls. An implementation
tool is never exposed in a consultation, and write access is independently
refused unless the workspace is the current checkout root or an external
standalone clone. The model cannot supply a workspace, permissions, write roots,
arbitrary launch flags, or an unrelated session to the tool.

Codex execution uses a read-only or workspace-write sandbox, with approvals
disabled and no unsandboxed retry. Evidence always runs read-only.
Implementation without write roots uses the native workspace-write sandbox,
which keeps `.agents` read-only. With
`--codex-write-root`, implementation instead uses a custom permission profile:
the filesystem is readable, the workspace and temporary directories are
writable, `.git`, `.agents`, `.codex` and `.aws` are read-only except the
selected skill directories, and networking is disabled. A custom filesystem
table replaces inherited safeguards, so the profile restates each protected
path. Helper shell networking, connectors, plugins, hooks, web search and
built-in multi-agent tools are disabled. Native configured
tool-server names are enumerated and disabled individually because an empty
configuration table merges with inherited servers rather than clearing them.
Unrecognized inventory or server names that cannot be safely overridden refuse
dispatch. API-key/provider
overrides are cleared and native ChatGPT login is checked before sending a
brief. Native managed policy still applies. Filesystem sandboxing is distinct
from instructions forbidding commits, remote changes, external actions, or
invoking another agent through a command. Those instructions are not an OS
guarantee. Read-only does not mean project-only read access; do not use the
helper for assignments requiring a stricter confidentiality boundary.

## Assign and accept useful work

Use evidence assistance for substantial exploration that compresses well:
caller maps, lifecycle traces, compatibility inventories and counterexample
searches. Give an objective, relevant source paths, required evidence and stop
condition. Require locations, short decisive excerpts, coverage and uncertainty.
Claude reads the sources deciding its recommendation; a summary is not proof.
An evidence helper does not count as an independent adversarial-review seat.

For implementation, Claude supplies accepted requirements, affected consumers,
allowed changes, checks and a stop condition. Codex returns changed paths,
commands and actual results, and unresolved issues. Claude inspects the actual
result and returns focused corrections. Do not forward the parent assignment
unchanged or ask a worker to invent an unresolved product contract. Small edits
Claude already understands usually belong in the direct route.

Each tool accepts `prompt` and an optional `session_id`. Within one launcher
run, a tool can resume a helper session it returned; an evidence session cannot
become a writer. A parent resume starts a fresh helper connection that refuses
earlier helper IDs, so Claude sends a new brief with the earlier findings.
Native helper history remains available to the coordinator by ID, but the tool
does not accept arbitrary historical sessions or maintain another session
registry.

The default limit is four helper launches per helper-server connection, each with a five-minute
timeout. The coordinator can set positive integer `--codex-max-calls` and
`--codex-timeout-ms` values. Resuming a helper counts as another launch. Parent
resumes or server restarts reset this connection's allowance; the coordinator owns the total assignment
budget. Cancellation and server shutdown stop the running helper process group.
Reports are capped at 16000 characters and mark truncation explicitly; full
exploration stays in native history. A timeout, cancellation, native failure or
missing completion is returned as incomplete work, even after a zero exit.
Report blocked checks rather than treating the tool returning as acceptance.

## What changes for a real request

Illustrative comparison, not measured improvement:

> Request: "Find a simpler teardown owner and deliver the bounded fix."

> Before: Claude either performs every exploration and edit itself or returns
> evidence requests to the coordinating Codex. The coordinator repeatedly
> reconstructs Claude's immediate information needs.

> After: Claude **owns the investigation and delivery**, asks Codex for **a
> source-linked teardown map**, develops the design, and assigns **a bounded fix
> and its checks** in the current checkout. Claude inspects the edits and directs
> corrections. The coordinator checks the diff and deciding results without
> repeating the investigation or copying files.

A narrow caller question still uses a narrow answer; a small direct edit need
not acquire a helper. Compare the quality of reasoning, deciding evidence,
design choices, and delivered outcomes when judging the division of work. Keep
Claude involved in choices requiring judgment even when they are small.

## Sources and checks

The native boundaries were designed against the official
[Codex non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude programmatic interface](https://code.claude.com/docs/en/headless), and
[MCP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
Tests mock native processes to check capability selection, result handling,
timeouts, resumes and refusal paths. Live acceptance must separately establish
that the installed CLIs enforce the boundaries and Claude actually uses the tool.
