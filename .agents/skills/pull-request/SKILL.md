---
name: pull-request
description: Draft and review Epicenter pull request titles and bodies, including changelog and merge details. Use when creating a PR or editing its text, not for local commits, branches, or issue replies.
---

# Pull Request Guidelines

If the task is only staging, splitting, or committing local changes, use [git](../git/SKILL.md). If the task is issue triage or public issue replies, use [github-issues](../github-issues/SKILL.md). The [writing-voice](../writing-voice/SKILL.md) rules govern the prose in any body you write.

## Explain the change

A pull request body explains why the change should exist and why it takes this shape. Briefly state what changed so the reader can place the explanation, then develop the reasoning the diff cannot supply: what prompted the change, why this approach fits, and which consequences or tradeoffs matter.

Build a readable rhythm of explanation and concrete things the reader can inspect. Use code to show behavior, diagrams to expose relationships, and tables to make comparisons visible. Let these carry part of the explanation so the reader has less to hold in their head. Give each visual enough context to read it, then explain what follows from it.

Let the change determine the body’s shape and length. A small fix may need two sentences. An ownership change may need a diagram and its rationale. A breaking API change needs old and new usage with migration guidance. End when the reader has enough context to understand and judge the change.

## Ground the explanation

Read the final diff and affected callers before drafting. Identify the main change and the reason for it; check examples against the implementation. Distinguish demonstrated behavior from intended benefits, and do not invent a rationale when the evidence leaves it unresolved.

Write for someone who has not followed the conversation. Keep the explanation useful after merge. Rewrite the title and body when the final scope changes, and include history only when it explains a decision that still matters.

Read the draft as that reader: can they tell what changed, why it was needed, and why this approach fits? Does each example help them judge a claim? Cut repetition of the diff and of what the visuals already show. Use the references for examples when useful; no body shape or sequence is mandatory.

## Hard Rules

- Do not include `## Summary`, `## Changes`, `## Testing`, `## Test Plan`, or `## Verification` sections unless the user explicitly asks.
- Report commands run, tests run, and verification gaps in the chat final response, not the PR body.
- Do not list changed files. The diff tab already does that.
- Do not include AI or tool attribution.
- PR titles use the same conventional commit format as commits.
- Include code examples for public API, CLI, HTTP, config, or type-signature changes.
- Name breaking changes with old and new examples.
- Add a `## Changelog` section only for `feat:` and `fix:` PRs with user-visible changes.

## References

Load these on demand:

- Guidance for openings, rationale, consequences, and structure: [references/body-patterns.md](references/body-patterns.md).
- Diagram catalog (composition trees, before/after, journeys, flow, comparison tables) with when to use each: [references/visual-patterns.md](references/visual-patterns.md).
- Worked bodies showing how the principle applies to different changes: [references/examples.md](references/examples.md).
- Changelog entries for `feat:` or `fix:` PRs: [references/changelog-entries.md](references/changelog-entries.md).
- Issue linking, username verification, CODEOWNERS, and merge strategy: [references/github-pr-operations.md](references/github-pr-operations.md).
