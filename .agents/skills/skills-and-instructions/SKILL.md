---
name: skills-and-instructions
description: Design, write, and maintain skills and agent instructions. Use when the user asks to create, edit, improve, review, or troubleshoot skills or agent instructions, decide where guidance belongs, or diagnose instruction sprawl, conflicting guidance, or skill selection. Do not use merely because another skill is being executed.
---

# Skills and Instructions

Preserve useful judgment in guidance a future agent can find and apply.
A skill earns its place through knowledge, preferences, or recurring failures
the agent would otherwise miss. More instructions are not evidence of progress.

## Find the instruction's owner

Use [dialectic](../dialectic/SKILL.md) when the purpose or desired behavior is
unsettled: articulate the proposed model alongside a sample of the behavior it
would produce. Use reactions to both to develop the instructions. Settled edits
do not require another discovery conversation.

Ground the guidance in actual work, source material, or the user's corrections.
Extract the judgment behind an accepted interaction, not its topic, layout, or
turn count. Remove instructions that push against that judgment before adding
compensating rules. An example is evidence for a principle, not a template for
every future response.

Update the existing owner when the intent is the same. Create a separate skill
when it offers a coherent capability someone would reach for independently.
Merge or delete guidance whose distinction creates more work than it saves;
legitimate composition does not require every phrase to have exactly one owner.

Keep cross-task constraints in AGENTS.md, specialized judgment in skills, and
architecture or decision history in the relevant README or ADR. References
carry conditional detail; scripts carry repeated fragile mechanics. One-off
advice and rules already owned elsewhere need not become another instruction.

## Write for judgment

State the premise and connect instructions to their reasons so the agent can
apply them to cases you did not anticipate. Give criteria and boundaries;
prescribe a sequence only when the order affects correctness. Keep enough
context to prevent the recurring mistake without dictating unrelated work.

Start the frontmatter description with a sentence stating what the skill does.
Begin the second sentence with "Use when" and name the user intents or situations
that should select it. This makes both the capability and its selection
conditions clear. Use examples when they clarify the boundary, and add
exclusions for plausible near misses. Revisit the description when the
capability changes. The body supplies the judgment and workflow rather than
repeating a list of trigger phrases.

Keep the core readable on its own. Link to a reference with a concrete reason
to read it, and retain examples only when they reveal something the principle
cannot carry alone. Remove obsolete references and duplicated rules as part of
the same edit; moving every paragraph elsewhere is not simplification.

## Repository conventions

Project skills live in `.agents/skills/<name>/SKILL.md` with lowercase hyphenated
names and YAML frontmatter containing `name` and `description`. Preserve optional
metadata or host settings unless the requested change makes them unnecessary;
do not add host scaffolding to portable skills by default.

For skills intended for Claude as well, create a relative sibling link from the
repository root, and update or remove it with the skill:

```bash
ln -s ../../.agents/skills/<name> .claude/skills/<name>
```

Codex-only skills deliberately have no Claude link.

Durable personal guidance belongs in the tracked dotfiles repository, not a
host-managed system-skill installation.

When importing guidance, inspect its scripts, dependencies, external actions,
and assumptions before using them. Adapt to local conventions and state the
tools or credentials the workflow needs; instructions cannot grant access.

## Check what changed

When changing a skill, **show how the revised skill would handle a realistic
request compared with the current skill**. Include enough of the interaction
or result for the user to judge the difference.

Alongside that comparison, **show the actual skill wording being changed**.
Use [writing-voice's comparison guidance](../writing-voice/SKILL.md#show-revisions-in-context)
for both the proposed instructions and the sample outputs.

Keep the request and unrelated material consistent. Clearly identify examples
you are illustrating versus results you actually obtained by running the skill.

For a new skill, show the proposed instructions and intended interaction. Use
the appropriate surface for other outputs, such as caller code, a rendered
screen, or an action sequence.

Describe the conditions of actual runs. Use the user's reaction to develop the
instruction; one preferred sample does not establish a general improvement.

Samples support review without introducing another approval step for work
already authorized.

Choose checks that answer a concrete uncertainty. Check affected links after
moving references; check frontmatter and intended-host discovery after changing
skill names, locations, or discovery metadata. A prose correction does not by
itself require an installation CLI or an audit of the whole library.

Review the motivating request and a materially different use to see whether the
judgment transfers, including when direct action is appropriate. When behavior
is uncertain or regresses, compare actual work with the previous version, or
without the skill for a new capability.

Read [evaluation](references/evaluation.md) when investigating selection or
behavior, comparing versions, or asked for evidence of improvement. Read
[composition diagnostics](references/composition-audit.md) when checking broken
links, duplicated guidance, or competing skill descriptions. Neither is a
required pass for every edit.
