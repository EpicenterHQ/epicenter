# Instruction Placement

Use this reference when deciding where repository guidance belongs. The goal is
not to capture every lesson. The goal is to keep future agents pointed at the
smallest durable instruction that changes behavior.

## Ownership

`AGENTS.md` carries cross-task constraints and routing. Skills own specialized
judgment and workflows. READMEs and ADRs describe the system and its decisions.
Choose the destination by what the material does for a future agent.

## Placement Rules

```txt
AGENTS.md      rules every agent must carry before any skill is selected
SKILL.md       repeatable workflow selected by a concrete user intent
references/   long examples or conditional detail loaded only when needed
scripts/      deterministic fragile work better done by code
CLAUDE.md      compatibility shim, usually only @AGENTS.md
README / ADR  current architecture, contracts, and decision rationale
delete         one-off advice, taste notes, or rules already owned elsewhere
```

A statement about what the system currently does is evidence to consult for a
relevant task, not an instruction every task should inherit. Keep architecture
snapshots, API examples, and migration status with their subsystem docs. Keep
an always-on rule only when it governs work across tasks or routes the agent
to the evidence it needs.

Do not create a new skill when an existing skill already owns the same user
intent. Update the existing skill, narrow its description, or move detail into a
reference instead.

## Always-On Rules Route

An `AGENTS.md` rule that names a skill is a routing rule, and it is measurably
the only thing that routes a broad intent no description claims. Where a
description already owns the phrase, the description wins and the rule changes
nothing about that route.

That asymmetry says which rule earns its place. It does not license a cleanup
pass over the ones that do not: shortening the paragraph cost orphan routes it
still named, so gate influence is not the sum of its clauses. Treat every edit
to an always-on file as a routing change and measure it.
`references/evaluation.md` carries the method and the evidence;
`audit-routing-collisions.ts` reports where a rule and a description claim the
same phrase.

## Greenfield Questions

Ask these questions in order:

```txt
What repeated failure does this prevent?
Which future prompt should trigger this instruction?
Which near-miss prompt should not trigger it?
Who has to carry this text on every task?
Which existing instruction already owns the behavior?
What can be deleted, moved to references, or shortened?
Does the new shape reduce loaded context or only add another place to check?
```

Default to deletion when the answer is "this was useful once." Update an
existing skill when the answer is "same trigger, sharper behavior." Add a skill
only for a separate trigger, repeatable workflow, and lower total routing cost.

## Review the placement

Explain the behavior the instruction should change, why its owner is the right
one, and what redundant guidance it replaces. Use enough evidence for the user
to judge the change; the explanation does not need a fixed set of fields.
