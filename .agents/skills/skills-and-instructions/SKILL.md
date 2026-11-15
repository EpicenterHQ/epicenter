---
name: skills-and-instructions
description: Design, write, and maintain skills and agent instructions. Use when the user asks to create, revise, evaluate, or troubleshoot skills or agent instructions, including investigating selection behavior to improve the guidance and deciding where guidance belongs.
---

# Skills and instructions

A skill should help a future agent do the work better. Preserve knowledge,
preferences, and lessons it would otherwise miss. Judge the skill by whether
that guidance helps the agent make better decisions in real situations.

Placement, structure, and wording for a settled, authorized outcome are your
work. Apply them, or the wording the user selected, say what you saved, and
carry the work through. Bring back a choice only when it would change the
settled outcome.

## Develop the intended capability

Ground the guidance in actual work, source material, or the user's corrections.
Extract the judgment that made an accepted interaction work so it transfers
across topics and formats.
Treat an accepted response as evidence about useful judgment, rather
than a template to reproduce.

Use examples as evidence for principles that future agents can apply to new
cases.

When the purpose of the guidance or the workflow it should produce is still
unsettled, use [dialectic](../dialectic/SKILL.md) throughout: clarify the
intent together, develop a greenfield vision, and work backward into concrete
form. Carry forward the intent, vision, and choices already settled in the
conversation.

Clarify what the guidance should make possible and what judgment future
agents need.
Make the vision concrete through a future agent handling realistic work:
what it recognizes, what decisions it makes, and what the user receives.
Let the user examine that experience before settling the instructions
that should produce it. Distinguish illustrative exchanges from results
obtained by running the guidance.

Reconsider the structure before polishing wording.

Work backward from the recognized vision to responsibilities, structure,
and wording. Existing skill and section boundaries remain open to change.
A short sketch of the proposed sections can make this concrete.

How much you rethink and how much you show at once are separate choices: you
can rethink a whole skill while reviewing one section, merge, or replacement
at a time, at the user's pace. Put Current wording in a blockquote and Proposed
wording in a copyable block, with explanation outside both.

The user may accept the direction and still object to the wording; carry
settled pieces forward and keep working on the rest. When behavior is at
issue, show how each version would handle a realistic request.

When reviewing the concrete form of a new skill, show the proposed instructions
and intended interaction. Use the appropriate surface for other outputs, such
as caller code, a rendered screen, or an action sequence.

## Find the guidance's owner

Read the involved guidance together. Resolve conflicting instructions
at their source, and distinguish useful composition from repeated
responsibility.

When a principle has gathered exceptions or patches, use
[rethink](../rethink/SKILL.md) to rearticulate it and check it against the cases
that produced them.

Update the existing owner when the intent is the same.
Create a separate skill when it offers a coherent capability someone
would reach for independently. Merge or remove guidance whose
distinction creates more work than it saves.
Let skills compose where their responsibilities work together.

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

State the premise and connect instructions to their reasons so the agent can
apply them to new cases. Give criteria and boundaries. Use ordered steps where
sequence affects correctness. Supply the context the agent needs to recognize
the situation and make a sound decision within the task.

Prefer positive framing: describe what the agent should do, when to do it,
and why. When correcting a failure, state the behavior that would handle that
situation well. This gives future agents a useful action to take and a principle
they can apply to new cases. Keep explicit prohibitions where they express a
necessary boundary more precisely.

Start the frontmatter description with a sentence stating what the skill does.
Begin the second sentence with "Use when" and name the user intents or situations
that should select it. This makes both the capability and its selection
conditions clear. Use examples to distinguish nearby user intents and the
work each calls for. Revisit the description when the capability changes.

Begin the body with the guidance itself; selection stays in the
description.

The body explains the judgment and workflow the skill applies.

Keep the core readable on its own. Link to conditional detail with
a concrete reason to read it. Keep examples that contribute judgment
beyond the principle. Remove obsolete references and duplicated
instructions as part of the same change.

## Check the assembled guidance

Read the whole against the intended behavior and the guidance it
composes with. Check what the instructions jointly encourage, what
they leave unresolved, and whether they burden unrelated work.
Check for clarity, repetition, and whether each rule sits with its owner.
Discoveries may require revisiting an earlier understanding.
A passage or example may show that the structure or intent needs revisiting.

Choose verification around a concrete uncertainty. Check affected
links after moving references. Check frontmatter and intended-host
discovery after changing names, locations, or discovery metadata.
For a prose correction, inspect the changed guidance and its diff.

When comparing how current and revised guidance handle a request, keep the
request and unrelated material the same so the difference comes from the
guidance. Present sample outputs together, each readable on its own, with
enough of the request and surrounding output to see the difference; bold the
parts that changed or need attention.

Describe the conditions of actual runs. Treat a preference as evidence about
that sample.
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

For shared instruction files, follow the repository's
[instruction ownership and Claude shim rules](../../../AGENTS.md#agent-instruction-files).

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
Work within the credentials and permissions available in the session.
