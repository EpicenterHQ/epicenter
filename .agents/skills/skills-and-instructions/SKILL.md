---
name: skills-and-instructions
description: Design, write, and maintain skills and agent instructions. Use when the user asks to create, revise, evaluate, or troubleshoot skills or agent instructions, including investigating selection behavior to improve the guidance and deciding where guidance belongs.
---

# Skills and instructions

Preserve the judgment a future agent needs to do the work well:
knowledge, preferences, and lessons it would otherwise miss.
Judge guidance by the decisions it improves in realistic situations.

Placement, structure, and wording for a settled, authorized outcome are your
work. Apply them, or the wording the user selected, say what you saved, and
carry the work through. Bring back a choice only when it would change the
settled outcome.

## Develop the intended capability

Ground the work in actual interactions, source material, and the user's
corrections. Examine what the agent needed to understand or decide.
Treat an accepted response as evidence about useful judgment, rather
than a template to reproduce.

When the purpose of the guidance or the workflow it should produce is still
unsettled, use [dialectic](../dialectic/SKILL.md) throughout. Carry forward
the intent, vision, and choices already settled in the conversation.

Make the vision concrete through a future agent handling realistic work:
what it recognizes, what decisions it makes, and what the user receives.
Let the user examine that experience before settling the instructions
that should produce it. Distinguish illustrative exchanges from results
obtained by running the guidance.

Work backward from that experience to the knowledge, boundaries, and
resources the agent needs. Existing skill and section boundaries remain
open to change.

## Find the guidance's owner

Read the involved guidance together. Resolve conflicting instructions
at their source, and distinguish useful composition from repeated
responsibility.

When a principle has gathered exceptions or patches, use
[rethink](../rethink/SKILL.md) to rearticulate it and check it against the cases
that produced them.

Update an existing skill when the intended capability is the same.
Create a separate skill when it offers a coherent capability someone
would reach for independently. Merge or remove guidance whose
distinction creates more work than it saves.

| Material | Home |
|---|---|
| Constraints that apply across tasks | AGENTS.md |
| Specialized, recurring judgment | A skill |
| Architecture and decision history | The relevant README or ADR |
| Conditional detail | References |
| Repeated fragile mechanics | Scripts |
| Advice specific to the current work | The task itself |

Link to existing owners for guidance they already carry. A link can lend
another skill's method, such as rethink's reasoning, without importing that
skill's interaction protocol; say which part applies when the difference
matters. Prefer an existing check or guard for a constraint it reliably
enforces; preserve the explanation an agent needs to work within it.

## Write for judgment

State the premise, the desired behavior, and the reasons that connect
them. Give criteria and boundaries that help the agent recognize new
cases. Use ordered steps where sequence affects correctness.

When correcting a failure, describe the behavior that would handle the
situation well. Keep explicit prohibitions where they express a
necessary boundary more precisely.

Start the frontmatter description with what the skill does. Begin
the second sentence with "Use when" and name the user intents or
situations that should select it. Distinguish nearby capabilities
where confusion is plausible. Revisit the description when the
capability changes.

Begin the body with the guidance itself; selection stays in the
description.

Keep the core readable on its own. Link to conditional detail with
a concrete reason to read it. Keep examples that contribute judgment
beyond the principle. Remove obsolete references and duplicated
instructions as part of the same change.

## Check the assembled guidance

Read the whole against the intended behavior and the guidance it
composes with. Check what the instructions jointly encourage, what
they leave unresolved, and whether they burden unrelated work.

Choose verification around a concrete uncertainty. Check affected
links after moving references. Check frontmatter and intended-host
discovery after changing names, locations, or discovery metadata.
For a prose correction, inspect the changed guidance and its diff.

Before claiming a general improvement, examine the motivating request
and materially different work, including a request where direct
action is appropriate. Judge decisions and outcomes, rather than
similarity to an approved response.

Read [evaluation](references/evaluation.md) when investigating
selection or behavior, comparing versions, or asked for evidence
of improvement. It covers controlled comparisons, fresh cases,
user judgments, and the limits of the available diagnostics.

Read [composition diagnostics](references/composition-audit.md)
when checking broken links, duplicated guidance, or competing
skill descriptions.

## Repository conventions

Project skills live in `.agents/skills/<name>/SKILL.md` with lowercase
hyphenated names and YAML frontmatter containing `name` and
`description`. Preserve optional metadata and host settings that
still serve the capability. Add host-specific scaffolding for an
identified host requirement.

For skills intended for Claude as well, create this relative link
from the repository root, and update or remove it with the skill:

```bash
ln -s ../../.agents/skills/<name> .claude/skills/<name>
```

Codex-only skills use Codex's skill discovery paths. Store durable
personal guidance in the tracked dotfiles repository so it survives
host-managed skill updates.

When importing guidance, inspect its scripts, dependencies, external
actions, and assumptions before using them. Adapt it to local
conventions and identify the tools or credentials it requires.
