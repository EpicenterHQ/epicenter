---
name: learn-from-corrections
description: Explicitly invoked review of a conversation to update the skills responsible for avoidable corrections. Work backward from disagreements, inspect the skills actually invoked, and develop and verify appropriate skill changes. Use only when directly invoked; ordinary corrections during a task do not select this workflow.
---

# Learn From Corrections

**Update the relevant skills so future agents can avoid the same mistake.** Work
backward from the user's corrections to the skills that shaped the exchange.
A better sample response helps judge a skill change; carry justified findings
into the skills themselves within the user's authorized scope.

A skill is its `SKILL.md` and the supporting references, scripts, and
configuration it owns. Read the relevant parts and change where the behavior
is actually governed. `AGENTS.md` and other active instructions can explain a
conflict or show that a lesson belongs outside a skill; distinguish those
findings from skill changes. The conversation's prompt is evidence of intent,
not the default destination for the improvement.

## Establish the purpose and evidence

**Use [dialectic](../dialectic/SKILL.md) to establish the intended outcome before
diagnosing the correction or suggesting changes.** State what the user wants
the reviewed conversation or workflow to help them understand, decide, or do.
Put that proposed intent in a blockquote and bold the words that state it;
emphasizing a question such as "Is that the job you want?" leaves the intent
itself hard to find. Let the user sharpen that understanding before building
on it. Carry forward intent already established; a settled correction can
proceed directly.

Once the purpose is understood, examine one concrete issue or suggestion at a
time against it. Ground the diagnosis in the conversation and the skills
actually invoked, and let the user's reactions shape the next attempt. Develop
the corresponding skill change once the diagnosis is understood. Revisit it
if considering the change exposes something it missed.

Read the referenced conversation through the available conversation tools. For
Codex chat references, use `read_thread` and follow pagination far enough to
understand the relevant requests, responses, corrections, and resolutions.
Use the record before asking the user to reconstruct it. They may identify a
correction they should never have needed to make without knowing the missing
instruction.

**Verify which skills were actually invoked**, alongside other active
instructions. Distinguish loaded guidance from skills merely available or
mentioned. Recover the wording in effect at the relevant turn when possible;
separate later changes from the baseline. State gaps in that evidence.

## Work backward from a correction

**Connect the user’s correction, the agent’s behavior, and the skill wording
that may explain it.** Show the relevant excerpts and explain your current
reading in plain language. Use dialectic to examine that connection with the
user, including discrepancies between what the skill says and what the agent
did. Develop one concrete issue at a time, letting their reactions and the
evidence revise the explanation before deciding what to change.

Distinguish a misunderstanding the agent could have avoided from a preference
or idea that emerged through useful exploration. A disagreement is evidence to
investigate, not proof that the agent was wrong.

Inspect the implicated skills and relevant surrounding instructions together.
Determine whether the problem was missing or misleading guidance, competing
instructions, skill selection, or failure to apply guidance already present.
**Loading a skill does not establish that it caused the mistake.** If the
record cannot support attribution,
keep the diagnosis provisional rather than assigning blame or adding a rule.

## Improve the responsible skills

Use [skills-and-instructions](../skills-and-instructions/SKILL.md) to place and make the
resulting skill edits. Prefer changing the existing owner and removing guidance
that encouraged the failure over adding compensating rules. Do not spread the
same lesson across every skill involved. Some findings warrant no skill change.

Show what the changed guidance would produce on the same request, using only
context available at that turn.

**Show the actual skill changes and the behavioral consequence together.** For
prose, show the exact wording changed; for scripts or configuration, show the
relevant change and its effect.

Keep comparison inputs consistent, distinguish illustrative responses from
actual runs, and check a materially different request for transfer or regression.
Use skills-and-instructions' [evaluation guidance](../skills-and-instructions/references/evaluation.md)
when designing behavioral comparisons. Report what remains unmeasured; success
on the motivating exchange alone does not establish improved accuracy.

Judge improvement by whether future agents can avoid the same misunderstanding
while preserving useful discovery, not by minimizing conversation turns.
Carry authorized changes through and report what changed, why, and what was
checked. Respect a request to diagnose or propose without editing. Creating
this workflow does not itself authorize running it on a referenced conversation.
