---
name: epicenter-actions
description: Decide what becomes an Epicenter action and how much each one does, so agents can compose small actions into workflows. Use when adding, splitting, merging, or reviewing an app's actions, or when a command, script, or CLI is proposed beside them.
---

# Epicenter actions

Actions are small and each does one thing. Agents arrange them into
workflows; the arranging lives in skills, not in code. The person, their
agents, their pages and their schedules all call the same actions, so the
terminal command is `epicenter <app> <action>` and nothing else.

## What earns an action

Make an action when it does something only code should do:

- **Spend money once and keep the result.** A paid narration or
  transcription saves what it bought, and a repeat reuses it.
- **Check a rule that must never be skipped.** Approval, the right
  account, never posting twice.
- **Do heavy or exact work.** Rendering, cutting media, reading a
  database.
- **Answer a read** that a page, a schedule or an agent needs.

Otherwise, let the agent do the work itself: edit a record, write the code,
run a tool. Code for a job that is finished is deleted, not kept in case.

## How much one action does

Give an action one job a caller would ask for by name. If a caller could
usefully run part of it alone, that part is its own action. An action that
runs several steps in a fixed order hides the order from the agent that
has to recover when one step fails. A flag that switches an action between
different jobs is two actions.

For example, a `make-video` action that secures the narration, checks the
direction, cuts clips and renders becomes `narrate-video`, `direct-video`,
`cut-clips` and `render-video`. The video skill holds the sequence. The
agent calls each one, reads its answer, and decides what comes next.

## Each action guards its own rule

Splitting must not let a wrong order break anything. Put each rule in the
action it protects, and refuse with a named error and a `next` that says
what to do instead. `render-video` refuses an undirected page or stale
narration itself. It does not rely on being called after `narrate-video`.

## Long work

An action may take minutes. While it runs:

- Report progress through `run`'s `update`.
- Decide what the `signal` means. A caller leaving stops nothing on its
  own.
- Write what must outlast the call to a file.
- Give callers a read that returns the result, so an agent that stopped
  waiting can pick it up.

Serve stops in-flight work when it restarts, so make the work safe to run
again: keep paid results, and build output in a temporary place until it is
complete. Let the person or a schedule start the work, rather than an
action that starts another action.

## No second surface

Do not add an app CLI, a command router or a script tree beside the
actions. An action fetches the secrets it needs when it runs, so no caller
has to wrap it in `infisical run`. A secret never travels in an action's
input. The person stores it in the secrets manager, and an action checks
it.

See [the actions contract](../../../packages/app/README.md#actions-and-apps)
for `defineAction`, `update`, `signal` and `mcp: false`, and the
[Decisions](../../../packages/app/README.md#decisions) that shape them.
