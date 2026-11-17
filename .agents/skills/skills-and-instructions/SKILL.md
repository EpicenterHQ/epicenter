---
name: skills-and-instructions
description: Design, write, and maintain skills and agent instructions. Use when the user asks to create, revise, evaluate, or troubleshoot skills or agent instructions.
---

# Skills and instructions

Help us put what we know about the work into guidance another agent can use.
That includes practical knowledge, judgment, taste, and a broader understanding
of what the work calls for.

Where that understanding is still taking shape, help us develop it.

Take responsibility for placement, structure, and composition. Carry the
user's selected wording and authorized changes into the guidance, say what
you saved, and carry the work through.

## Develop the intent and vision

When the intent or vision is still unsettled, use
[dialectic](../dialectic/SKILL.md) to develop it together.

Clarify what we want an agent to understand and how we want it to approach
the work. Show what that would look like through an agent handling a realistic
request: what it notices, the decisions it makes, and what the user receives.
Let the user examine that experience before writing the instructions meant
to produce it.

Build on intent, vision, and choices already settled in the conversation.

## Develop the guidance section by section

Once the intent and vision are recognized, work backward into the guidance
that should produce that experience. Propose a structure whose sections each
have a clear responsibility. Existing skill and section boundaries remain
open to change.

Develop the actual articulations section by section, at the user's pace.
Before rewriting an existing section, ask whether it needs to be there at all.

For each section, explain what it needs to contribute to the shared vision
and show the wording you propose. When revising, put Current wording in a
blockquote and Proposed wording in a copyable block, with explanation outside
both. Include enough context for the user to judge the passage.

Examine the wording together against the intent and vision. What understanding
does it convey? What would it lead an agent to notice, decide, or do?
Where taste matters, examine what the passage helps an agent recognize as
good work. Use a realistic example when the consequences need to become
visible.

Before replacing a substantial passage, ask whether there are phrases,
sentences, or explanations the user wants to keep. Preserve selected wording
exactly. An articulation can be worth keeping because it says something
just right, even when another version would convey the same idea.

Carry recognized parts forward and compose the next attempt yourself.
Agreement on the intent or vision establishes the direction; develop and
examine the wording within it. The user may recognize the thought while
wanting a different expression.

Keep the whole in view as you develop individual sections. Revisit the
structure when a passage reveals a better arrangement, and read the assembled
guidance against the shared intent and vision.

For an exact edit or a change whose wording is already settled, carry it
through directly. Build on intent, vision, and wording already recognized
in the conversation.

## Where the guidance goes

Update an existing skill or instruction file when it already covers the work.
Use this table to decide where new material belongs.

| Material | Where it goes |
|---|---|
| Instructions that apply across tasks | AGENTS.md |
| Guidance for a recurring kind of work | A skill |
| Project architecture and decision history | The relevant README or ADR |
| Supporting detail needed in particular situations | References |
| Reusable code for repetitive or fragile steps | Scripts |
| Advice specific to the current work | The task itself |

Link to guidance already covered elsewhere so the agent can find it.

## File conventions

Save project skills in `.agents/skills/<name>/SKILL.md`. Use lowercase,
hyphenated names and YAML frontmatter containing `name` and `description`.

Start the description with what the skill does. Begin the second sentence
with "Use when" and name the requests or situations that should select it.
Begin the body with the guidance itself.

Put supporting detail in references and explain when to read them.

Keep durable personal guidance in the tracked dotfiles repository.

When importing a skill, inspect its scripts, dependencies, and external
actions before using it. Identify the tools and credentials it needs.

## Optional references

- Read [evaluation](references/evaluation.md) when investigating how agents use
  guidance or comparing whether a change helps.
- Read [composition diagnostics](references/composition-audit.md) when
  investigating broken links, conflicting instructions, repeated guidance,
  or overlapping skill descriptions.
