---
name: epicenter-actions
description: Decide what becomes an Epicenter action and how much each one does, so agents can arrange small actions into workflows. Use when adding, splitting, merging, describing, or reviewing an app's actions.
---

# Epicenter actions

Actions are small and each does one thing. Agents arrange them into
workflows; the arranging lives in skills, not in code. An action exists
when it does something only code should do: spend money once and keep the
result, check a rule that must never be skipped (approval, the right
account, never posting twice), or do heavy work like rendering.

## Action or agent

Ask whether the agent could do the job itself by editing a record or
running a tool. If so, it does. A read follows the same test: it is an
action when the answer takes code to compute, such as a board built from
many records, and a file read otherwise.

An action fetches the secrets it needs when it runs. The person stores
them in the secrets manager.

## One job each

Give an action one job a caller would ask for by name. When a caller could
usefully run part of it alone, that part is its own action. When a flag
would switch it between different jobs, each job is its own action.

For example, making a video is `narrate-video`, `direct-video`,
`cut-clips` and `render-video`. The agent calls one, reads its answer, and
decides what comes next.

## The skill holds the order

Write the sequence in the skill for that workflow, naming each action in
turn. When you add, rename or split an action, update that skill in the
same change.

## Descriptions

An agent chooses an action by reading its description, so write it for
that reader:

- what the action does, in the caller's words;
- what it changes, and what it costs when it spends money;
- when it refuses, and what to do then.

Describe each input field the same way: what to pass and what happens
when it is left out.

See [the actions contract](../../../packages/app/README.md#actions-and-apps)
for `defineAction`, `update`, `signal` and `mcp: false`.
