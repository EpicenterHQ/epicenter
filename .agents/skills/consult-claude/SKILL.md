---
name: consult-claude
description: Run Claude Code as an independent reviewer or research laboratory while you keep ownership of the live repository. Use when the user asks to consult Claude, requests a Claude review, or asks Claude to investigate or research independently.
---

# Consult Claude

Claude researches in an independent repository snapshot. Codex owns the living
checkout, evaluates the evidence, and integrates the result. The launcher owns
the snapshot and tool boundary; Claude Code owns the conversation and its
lifecycle.

Give Claude one outcome, the settled values it must preserve, and source
territory worth starting from. Do not give it your working theory, a menu of
answers, or a prescribed method. Tell it what would make the research complete.

Requires Bun, Git, and authenticated Claude Code 2.1.257 or later with access to
the chosen model. This minimum includes the outside-read restriction used by
the launcher. Start from the repository root:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts start
```

Send the brief on stdin, then EOF. The launcher prints snapshot metadata and
Claude's native session ID and management commands. It saves provenance in
`run.json` beside the replica. `--name <name>` labels the run and native session;
`--dry-run` previews the metadata and settings without creating a snapshot or
calling Claude. `snapshotId` identifies the captured Git tree, retained at
`refs/consultation/baseline` inside the replica. Read a baseline file with
`git show <snapshotId>:<path>`; describe later experiments separately.

The default is Fable 5.1 (`claude-fable-5-1`). Pass `--model <alias-or-id>` to
choose another model. `--model fable` follows the CLI's moving alias. The record
states the requested model; inspect the native session before attributing a
result to it, since access restrictions and fallback can change the model used.

Monitor through Claude's native state and output:

```bash
claude agents --cwd <replicaPath> --json --all
claude logs <native-id>
```

When the user needs the answer before you continue, keep monitoring the native
session. Read its report at the printed `checkpointPath` when it finishes or
needs a decision. A report is evidence, not a process signal: `failed`, `stopped`,
and `blocked` need inspection even if no report exists. Report unavailable
checks instead of treating a successful launch as a completed consultation.

Follow up in the existing conversation with `claude attach <native-id>` in a
PTY, or reply in the session's peek panel in `claude agents`. Attach also resumes
stopped sessions with a saved conversation. Detach with Ctrl+Z to return to the
shell and leave the session running. Do not start `--resume --bg` against a live
session: Claude can copy it instead of continuing it.

The replica includes tracked changes and untracked, non-ignored files. It has
independent Git storage and no remote. Restricted mode confines file tools;
sandbox settings restrict outside reads and shell network access. Claude can
edit and experiment in the replica and use WebSearch. Ignored dependencies are
absent, so some tests may be unavailable offline. Untracked nested repositories
are rejected; ignore them or move them outside the source repository first.
Restricted Git operations may require approval. Direct fetching or external
actions require a deliberate change to the consultation's scope.

Re-verify findings against the living checkout. When live work has materially
moved on, start a new snapshot; do not refresh an existing laboratory beneath
its conversation. Claude's patches are evidence, not changes to apply. Return
its recommendation, material objections, and any remaining disagreement.

When changing launch behavior, check `claude --version`, `claude --help`, and
the official [CLI reference](https://code.claude.com/docs/en/cli-reference),
[agent view](https://code.claude.com/docs/en/agent-view),
[model configuration](https://code.claude.com/docs/en/model-config), and
[outside-read restrictions](https://code.claude.com/docs/en/settings-reference#permissions-blockreadsoutsideworkingdirectories).
Keep native commands in the skill and snapshot mechanics in the launcher;
do not add a second session manager to accommodate a CLI change.
