---
name: handoff
description: Draft a self-contained prompt for a fresh ChatGPT, Claude Code, or other agent session. Use when the user asks for a handoff, continuation prompt, or something to copy and paste into another session. Do not use for a progress summary or for asking another agent to review or implement work within the active session.
argument-hint: "What should the next agent accomplish?"
metadata:
  author: epicenter
  version: '8.0'
---

# Handoff

Write one prompt the user can paste into a fresh session. Use the destination
the user names; otherwise keep it agent-neutral. This skill prepares the
handoff and does not launch or supervise the recipient. Return only the prompt.
If the user is designing or reviewing the handoff itself, a short note before
it is fine.

Give the next session enough context to make the next useful judgment. The
recipient cannot see this conversation: preserve the intent, evidence, and
reasoning it would otherwise lose, and point to accessible sources for details
it can recover. Do not assume tools or delegation arrangements from the
recipient's name.

## Ground it first

Look before writing. For coding work that usually means:

```bash
git status --short --branch
git diff --name-status
git diff -- <relevant paths>
```

Then read the files, tests, specs, ADRs, or logs the prompt will point at, and
distinguish work completed from checks actually run, their results, and what
remains unverified. For
non-coding work, gather the equivalent source material. Skip the grounding pass
only for something obviously small.

Match the prompt to the recipient's known access. Identify the checkout and
relevant paths when it can read them; otherwise include the excerpts or
evidence needed for the next judgment. When access is unknown, include the
essential context and name any missing source or tool needed to proceed.

## Write it

Lead with the mission and the artifact wanted. Explain where the work stopped,
what remains unresolved, and the next useful action or question. Give the
recipient enough of the larger objective to understand why that step matters
and what remains afterward.

Two things are easy to leave out and expensive to lose: the evolution that
explains the current direction (what the user reacted to, what was tried and
dropped), and what the user will recognize as right beyond a passing test run.

Name real hazards: dirty user work, destructive git, deploys, migrations,
security, licensing boundaries, dead paths to avoid, explicit non-goals. Leave
out hazards that are merely conceivable.

Let length follow the mission. Keep history when it explains the current
direction or prevents repeating a failed approach. Omit transcript bulk and
details the recipient can readily recover from the sources you identify.

## The posture that makes it work

Say what you think is true and why. Distinguish explicit user decisions from
observed behavior and your interpretation. The recipient should preserve the
user's constraints while remaining free to re-check evidence, disagree with
your conclusions, and choose its approach.

Close with the likely verification commands or evidence targets, and with what
counts as done: a review memo, a PR-ready diff, a clean implementation branch,
a verified command set, or a blocker list with the smallest remaining
decisions.

Read the prompt as someone arriving cold: can they tell what to accomplish,
what is known, and how to move forward without guessing at missing conversation?
A thorough summary that leaves the next step unclear is not a finished handoff.

For a one-line `/goal`, use [agent-goal](../agent-goal/SKILL.md). A progress
summary for the user is an ordinary response grounded in branch and session
state, not a handoff artifact.
