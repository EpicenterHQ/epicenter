---
name: skills-and-instructions
description: Design, write, and maintain skills and agent instructions. Use when the user asks to create, revise, evaluate, or troubleshoot skills or agent instructions, including investigating selection behavior to improve the guidance and deciding where guidance belongs.
---

# Skills and Instructions

A skill should help a future agent do the work better. Preserve knowledge,
preferences, and lessons it would otherwise miss. Judge the skill by whether
that guidance helps the agent make better decisions in real situations.

## Shape a change together

For a new skill or a substantial revision, work through these responsibilities
with the user. Later work can send you back to an earlier one.

1. **Agree on what the guidance should do.** Settle its purpose and the
   behavior it should produce. Use [dialectic](../dialectic/SKILL.md) when
   either is unsettled.
2. **Reconsider the structure before polishing wording.** Decide what the
   relevant whole is responsible for, then how its sections should be divided
   and ordered. Existing section boundaries need not survive. A short sketch of
   the proposed sections can make this concrete.
3. **Rewrite in pieces the user can judge.** How much you rethink and how much
   you show at once are separate choices: you can rethink a whole skill while
   reviewing one section, merge, or replacement at a time, at the user's pace.
   Put the **Current** wording in a blockquote and the **Proposed** wording in
   a copyable writing block, with explanation outside both. When behavior is at
   issue, show how each version would handle a realistic request. The user may
   accept the direction and still object to the wording; carry settled pieces
   forward and keep working on the rest.
4. **Read the assembled whole.** Check it against the intended behavior and
   for clarity, repetition, and whether each rule sits with its owner. A
   passage or example may show that the structure or intent needs revisiting.

A settled change skips this sequence. When the user has selected wording or the
fix is already clear and authorized, apply it, say what you saved, and carry
the work through without asking again.

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
work each calls for. Revisit the description when the capability changes. The
body explains the judgment and workflow behind those selection conditions.

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
guidance. Present sample outputs using
[writing-voice's comparison guidance](../writing-voice/SKILL.md#show-revisions-in-context).
Clearly identify examples you are illustrating versus results you actually
obtained by running the skill.

For a new skill, show the proposed instructions and intended interaction. Use
the appropriate surface for other outputs, such as caller code, a rendered
screen, or an action sequence.

Describe the conditions of actual runs. Treat a preference as evidence about
that sample, and test materially different requests before claiming a general
improvement.

Choose checks that answer a concrete uncertainty. Check affected links after
moving references; check frontmatter and intended-host discovery after changing
skill names, locations, or discovery metadata. For a prose correction, focus
verification on the changed guidance and its diff.

Review the motivating request and a materially different use to see whether the
judgment transfers, including when direct action is appropriate. When behavior
is uncertain or regresses, compare actual work with the previous version, or
without the skill for a new capability.

Read [evaluation](references/evaluation.md) when investigating selection or
behavior, comparing versions, or asked for evidence of improvement. Read
[composition diagnostics](references/composition-audit.md) when checking broken
links, duplicated guidance, or competing skill descriptions.
