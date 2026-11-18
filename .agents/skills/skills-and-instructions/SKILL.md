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

Work through the draft at the user’s pace.
Before rewriting an existing section, ask whether it needs to be there at all.

Show the proposed wording and explain what it would help the agent do.
When revising, show the current wording alongside the proposal.
When a change affects how the guidance fits together, read the whole
section or skill and show enough of it for the user to judge the fit.

Read the draft together. What would it lead an agent to notice, decide, or do?
If it’s hard to tell from the wording alone, try it on a realistic request.

When proposing a substantial rewrite, show any existing phrases or
sentences you think are worth keeping so the user can see them and
choose. Preserve selected wording exactly.

The user may recognize the thought while wanting a different expression.
Use what they agreed on to write the next draft.

When the user requests an exact edit or agrees on the wording,
apply it and say what you saved.

## Where the guidance goes

Update an existing skill or instruction file when it already covers the work.

| Material | Where it goes |
|---|---|
| Instructions that apply across tasks | AGENTS.md |
| Guidance for a recurring kind of work | A skill |
| How the project works today | The relevant README |
| A durable decision and why it was made | An ADR |
| Supporting detail needed in particular situations | References |
| Reusable code for repetitive or fragile steps | Scripts |
| Advice specific to the current work | The task itself |

Keep durable personal guidance in the tracked dotfiles repository.

Link to guidance already covered elsewhere so the agent can find it.

## File conventions

Save project skills in `.agents/skills/<name>/SKILL.md`. Use lowercase,
hyphenated names and include `name` and `description` in the YAML
frontmatter.

Use the first sentence of the description to say what the skill does.
Start the second with “Use when” and name the requests or situations
where it applies.

When linking to a reference, say when to read it.

## Keep technical guidance grounded

When revising technical guidance or upgrading a dependency, recheck the
affected API claims against official documentation and the installed types
or behavior. Link factual claims to their sources beside the guidance.
Distinguish a source's advice from the project's chosen convention.

For examples that claim to detect mistakes, introduce an intentional mistake
and verify that the documented command fails for the intended reason.

## References

- Read [evaluation](references/evaluation.md) to investigate which
  skill an agent chooses, how it follows the guidance, or whether
  a revision improves its work.
- Read [composition diagnostics](references/composition-audit.md) to
  check broken links, conflicting or repeated instructions, or
  overlapping skill descriptions.
