# Specs

This folder holds in-flight design scaffolding: plans for work that is underway. A spec is not the durable record and not authoritative. Settled decisions go in the `## Decisions` section of the README beside the code they govern, shared vocabulary in `docs/vision.md`, and current behavior in package READMEs and the code. How to write a spec is in [the specification-writing skill](../.agents/skills/specification-writing/SKILL.md).

## File Names

New specs use:

```txt
YYYYMMDDThhmmss-kebab-case.md
```

Examples:

```txt
20260524T153612-centralize-route-paths.md
20260524T100110-centralize-c-json-error-responses.md
```

Prompt and handoff artifacts may use explicit suffixes:

```txt
*.prompt.md
*.handoff.md
*.execute.md
```

Those artifacts should link back to the canonical spec. Do not treat them as the current implementation plan unless the suffix and header make that explicit.

## Lifecycle

A spec has exactly two states, both meaning "in flight, still in the tree":

- `Draft`: design direction exists, implementation has not started or is not committed to the exact plan.
- `In Progress`: work is underway and checkboxes or implementation notes should stay current.

There is no terminal status. A spec does not become `Implemented`, `Superseded`, or `Retrospective` and linger; when its work lands (or it is abandoned), its durable decision is written into the README it governs and the spec is deleted. "Done" has one representation: the file is gone. Git keeps the history. This is why an in-tree spec is always safe to treat as live, and why a spec declaring a terminal status should be deleted.

When executing a spec, update checkboxes and implementation notes in the same review unit as the code. If implementation diverges from the spec, update the spec instead of leaving stale instructions behind.

Before deleting a spent spec, write any durable decision into the
`## Decisions` section of the README it governs, in the shape
[the documentation skill](../.agents/skills/documentation/SKILL.md#decisions-sections) describes. A decision an agent might
propose again, including an alternative it turned down, also gets a proposed entry in
[the history](../docs/history.md) for the owner to accept. A mechanical change
with no durable decision needs neither. After retirement, run `bun run check:doc-paths`; resolve issues
introduced by the work and report unrelated failures against the task baseline.
