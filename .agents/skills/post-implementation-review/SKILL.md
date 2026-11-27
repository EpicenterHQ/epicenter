---
name: post-implementation-review
description: Review the combined result of an implementation and act on what building it taught you. Use when finishing substantial implementation or refactoring, reviewing changes across callers or public APIs, or when asked for a second pass or final sweep. Independent review belongs to adversarial-review.
metadata:
  author: epicenter
  version: '2.0'
---

# Post-implementation review

What did building this teach us about how the code should work? Use the final
sweep to act on what you learned and verify the combined result.
Earlier implementation choices, including your own, remain open to question.

## Review the whole change

Start with the requested outcome, the task-start baseline, and the cumulative
diff, including earlier implementation waves. Read the affected entry points,
callers, and tests. Follow evidence into adjacent code when it explains the
result, and respect the task's file limits.

Ask what became clearer once the pieces worked together. A workaround or a
repeated repair can reveal where a decision or state belongs. Check which
constraints actual callers rely on and which you assumed along the way.

For example, a rename feature might accumulate a saved name, a sidebar copy,
and a callback keeping them synchronized. The sidebar can read the saved name
directly. The edit field still needs its unfinished draft. The simplification
removes the sidebar copy and callback. The final sweep checks that Save updates
the sidebar and Cancel discards the draft.

## Act on what you find

Fix concrete correctness problems within the authorized task. For a review-only
request, return findings and proposed repairs.

When the review identifies a concrete simplification, use
[code-collapse](../code-collapse/SKILL.md) to evaluate it and, when authorized,
carry it through. Start with the candidate, its affected callers, and the
behavior it must preserve. Then continue this review on the combined result.

Use [rethink](../rethink/SKILL.md) when the review reopens an ownership,
lifecycle, API, or package-boundary decision. Bring choices that would change
the agreed outcome or guarantees back to the user. Run the final sweep
yourself. Use [adversarial-review](../adversarial-review/SKILL.md) for requested
independent judgment.

## Verify and report

Verify the requested behavior through the entry points and callers that use
it. Reuse checks that still cover the final code. Rerun checks affected by a
later edit or needed to investigate a failure. Check changes to the interface
in the [running app](../ui-design/references/verification.md), including native
desktop behavior in the desktop app.

Compare failures against the task-start baseline or an agreed review baseline
before calling them pre-existing. Say when you cannot establish when a failure
started.

Report what the implementation taught you, what you changed, and what verified
it. For findings, give the location, observable consequence, and proposed
repair. Name any limits that affect confidence in the result. If the review
supports the current design, say what you checked.
