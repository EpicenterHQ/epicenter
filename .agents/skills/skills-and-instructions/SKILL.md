---
name: skills-and-instructions
description: Design, write, and maintain skills and agent instructions. Use when the user asks to create, revise, evaluate, or troubleshoot skills or agent instructions.
---

# Skills and instructions

Help us put what we know about the work into guidance another agent can use.
When we’re still figuring out what good work looks like, help us work it out together.

## Develop the intent and vision

When the intent or vision is still unsettled, use
[dialectic](../dialectic/SKILL.md) to develop it together.

Show how you’d want an agent to handle a realistic request. Show what
it would notice, what it would decide, and what the user would receive.
Let the user judge the example before you write the guidance.

## Develop the guidance section by section

Work backward from what you want the agent to do. Decide what it needs
to understand and which decisions the guidance should help it make.
Organize the skill around those needs.

Develop the actual articulations section by section, at the user's pace.
Before rewriting an existing section, ask whether it needs to be there at all.

Show the proposed wording and explain what it would help the agent do.
When revising, show the current wording alongside the proposal.
When a change affects how the guidance fits together, read the whole
section or skill and show enough of it for the user to judge the fit.

Read the draft together. What would it lead an agent to notice, decide, or do?
If it’s hard to tell from the wording alone, try it on a realistic request.

Before replacing a substantial passage, ask whether there are phrases,
sentences, or explanations the user wants to keep. Preserve selected wording
exactly. An articulation can be worth keeping because it says something
just right, even when another version would convey the same idea.

Carry recognized parts forward and compose the next attempt yourself.
Agreement on the intent or vision establishes the direction; develop and
examine the wording within it. The user may recognize the thought while
wanting a different expression.

For an exact edit or a change whose wording is already settled, carry it
through directly and say what you saved. Build on intent, vision, and wording
already recognized in the conversation.

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

## Keep technical guidance grounded

When revising technical guidance or upgrading a dependency, recheck the
affected API claims against official documentation and the installed types
or behavior. Link factual claims to their sources beside the guidance.
Distinguish a source's advice from the project's chosen convention.

For examples that claim to detect mistakes, introduce an intentional mistake
and verify that the documented command fails for the intended reason. Keep
historical context separate from current instructions. Recheck the affected
guidance when it changes; ordinary maintenance does not need a standing audit.

## Optional references

- Read [evaluation](references/evaluation.md) when investigating how agents use
  guidance or comparing whether a change helps.
- Read [composition diagnostics](references/composition-audit.md) when
  investigating broken links, conflicting instructions, repeated guidance,
  or overlapping skill descriptions.
