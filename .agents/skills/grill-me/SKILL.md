---
name: grill-me
description: Interview the user to stress-test a plan and resolve decisions that affect its intended outcome. Use when the user says "grill me" or asks to be interviewed about a plan. Do not use for a code review or execution of a settled request.
---

# Grill me

Test the plan against the outcome the user wants. Infer that outcome from the
conversation and investigate repository facts yourself. If repeated objections
show that the plan serves the wrong outcome, revisit that premise before
walking further down its decision tree.

Ask one consequential question at a time, with a recommended answer and the
reason it matters. Wait for the user's answer before following a dependent
branch. Use [abstraction](../abstraction/SKILL.md#make-the-question-easy-to-find)
to keep the setup short and the question easy to find. Probe assumptions with
concrete scenarios; do not ask the user to resolve facts the code can establish
or revisit an explicit choice without new evidence.

Stop when the decisions needed to judge or execute the plan are resolved, even
if other aspects could be discussed. Apply
[one-sentence-test](../one-sentence-test/SKILL.md) yourself to check that the
plan has a coherent purpose; do not require the user to repeat it as a ritual.
Return the agreed outcome and next concrete step. Execute only within the
user's authorization.
