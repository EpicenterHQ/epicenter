---
name: skills-and-instructions
description: Design, write, and maintain skills and agent instructions. Use when the user asks to create, revise, evaluate, or troubleshoot skills or agent instructions, including investigating selection behavior to improve the guidance and deciding where guidance belongs.
---

# Skills and Instructions

A skill should help a future agent do the work better. Preserve knowledge,
preferences, and lessons it would otherwise miss. Judge the skill by whether
that guidance helps the agent make better decisions in real situations.

## Shape a change together

For a new skill or a substantial revision, use
[dialectic](../dialectic/SKILL.md) throughout: clarify the intent together,
develop a greenfield vision, and work backward into concrete form.
Carry forward what the conversation has already settled.

Clarify what the guidance should make possible and what judgment future
agents need. Make the vision tangible by showing how a future agent would
understand and handle realistic work. Let the user examine that experience
before settling the structure or instructions that should produce it.

Work backward from the recognized vision to responsibilities, structure,
and wording. Existing skill and section boundaries remain open to change.
You can rethink the whole while presenting coherent pieces at the user's
pace. Put Current wording in a blockquote and Proposed wording in a
copyable block, with explanation outside both.

Read the assembled guidance against the intent and vision, checking how
its instructions work together. Discoveries may require revisiting an
earlier understanding.

When the user has selected wording or the fix is clear and authorized,
apply it, say what you saved, and carry the work through.

## Find the instruction's owner

Ground the guidance in actual work, source material, or the user's corrections.
Extract the judgment that made an accepted interaction work so it transfers
across topics and formats. Resolve conflicting guidance at its source. Use
examples as evidence for principles that future agents can apply to new cases.

Update the existing owner when the intent is the same. Create a separate skill
when it offers a coherent capability someone would reach for independently.
Merge or delete guidance whose distinction creates more work than it saves;
let skills compose where their responsibilities work together.

Keep cross-task constraints in AGENTS.md, specialized judgment in skills, and
architecture or decision history in the relevant README or ADR. References
carry conditional detail; scripts carry repeated fragile mechanics. Preserve
recurring judgment in guidance, keep task-specific advice with its task, and
link to existing owners for rules they already carry.

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
Begin the body with the guidance itself; selection stays in the description.

Keep the core readable on its own. Link to a reference with a concrete reason
to read it. Keep examples that add judgment beyond the principle. Simplify as
part of the same edit by deleting obsolete references and duplicated rules.

## Repository conventions

Project skills live in `.agents/skills/<name>/SKILL.md` with lowercase hyphenated
names and YAML frontmatter containing `name` and `description`. Carry forward
optional metadata and host settings that still serve the requested capability.
Add host-specific scaffolding for an identified host requirement.

For skills intended for Claude as well, create a relative sibling link from the
repository root, and update or remove it with the skill:

```bash
ln -s ../../.agents/skills/<name> .claude/skills/<name>
```

Codex-only skills use Codex's skill discovery paths. CLAUDE.md files are shims
importing the sibling AGENTS.md. Store durable personal guidance in the tracked
dotfiles repository so it survives host-managed skill updates.

When importing guidance, inspect its scripts, dependencies, external actions,
and assumptions before using them. Adapt to local conventions and state the
tools or credentials the workflow needs. Work within the credentials and
permissions available in the session.

## Check what changed

When comparing how current and revised guidance handle a request, keep the
request and unrelated material the same so the difference comes from the
guidance. Present sample outputs together, each readable on its own, with
enough of the request and surrounding output to see the difference; bold the
parts that changed or need attention. Clearly identify examples you are
illustrating versus results you actually obtained by running the skill.

Describe the conditions of actual runs. Treat a preference as evidence about
that sample. Review the motivating request and a materially different use,
including when direct action is appropriate, before claiming a general
improvement. When behavior is uncertain or regresses, compare actual work with
the previous version, or without the skill for a new capability.

Choose checks that answer a concrete uncertainty. Check affected links after
moving references; check frontmatter and intended-host discovery after changing
skill names, locations, or discovery metadata. For a prose correction, focus
verification on the changed guidance and its diff.

Read [evaluation](references/evaluation.md) when investigating selection or
behavior, comparing versions, or asked for evidence of improvement. Read
[composition diagnostics](references/composition-audit.md) when checking broken
links, duplicated guidance, or competing skill descriptions.
