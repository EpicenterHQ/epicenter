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

Use [dialectic](../dialectic/SKILL.md) to develop the diagnosis with the user.
Begin by articulating what they want this review to improve, drawing on their
request and the available conversation. Establish shared intent before
recommending changes.

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

Choose a consequential miss and show the request, response, and correction with
enough context to expose the mismatch. Develop one coherent issue at a time.
Distinguish a misunderstanding the agent could have avoided from a preference
or idea that emerged through useful exploration. A disagreement is evidence to
investigate, not proof that the agent was wrong.

Inspect the implicated skills and relevant surrounding instructions together.
Determine whether the problem was missing or misleading guidance, competing
instructions, skill selection,
or failure to apply guidance already present. **Loading a skill does not
establish that it caused the mistake.** If the record cannot support attribution,
keep the diagnosis provisional rather than assigning blame or adding a rule.

Make the suspected cause and proposed remedy concrete enough for the user to
correct. Show what the changed guidance would produce on the same request,
using only context available at that turn. Their reaction may change the
diagnosis, the responsible owner, or the proposed edit. Preserve what they
recognize and synthesize the next attempt yourself.

## Improve the responsible skills

Use [agent-instructions](../agent-instructions/SKILL.md) to place and make the
resulting skill edits. Prefer changing the existing owner and removing guidance
that encouraged the failure over adding compensating rules. Do not spread the
same lesson across every skill involved. Some findings warrant no skill change.

**Show the actual skill changes and the behavioral consequence together.** For
prose, show the exact wording changed; for scripts or configuration, show the
relevant change and its effect.

Keep comparison inputs consistent, distinguish illustrative responses from
actual runs, and check a materially different request for transfer or regression.
Use agent-instructions' [evaluation guidance](../agent-instructions/references/evaluation.md)
when designing behavioral comparisons. Report what remains unmeasured; success
on the motivating exchange alone does not establish improved accuracy.

Judge improvement by whether future agents can avoid the same misunderstanding
while preserving useful discovery, not by minimizing conversation turns.
Carry authorized changes through and report what changed, why, and what was
checked. Respect a request to diagnose or propose without editing. Creating
this workflow does not itself authorize running it on a referenced conversation.
