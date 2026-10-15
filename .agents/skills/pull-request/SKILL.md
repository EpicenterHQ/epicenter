---
name: pull-request
description: Draft and review Epicenter pull request titles and bodies, including changelog and merge details. Use when creating a PR or editing its text, not for local commits, branches, or issue replies.
---

# Pull Request Guidelines

If the task is only staging, splitting, or committing local changes, use [git](../git/SKILL.md). If the task is issue triage or public issue replies, use [github-issues](../github-issues/SKILL.md). The [writing-voice](../writing-voice/SKILL.md) rules govern the prose in any body you write.

## Default Standard

A PR body is a durable explanation of the change, not a reviewer-only checklist. Write the lightest body that still makes sense after merge. Open with why the change matters, then weave in what changed with the examples a reader needs to trust it. Name what the change removes or costs, and why that is acceptable. Write in the first person, as the author explaining the change.

## Pick A Body Shape

Match the change to a shape, then open that shape's section in [references/body-patterns.md](references/body-patterns.md):

| Change | Shape | Body in one line |
| --- | --- | --- |
| Narrow bug or UI fix | Focused fix | Two or three paragraphs, no headings |
| New or changed public surface | API or feature guide | Smallest call site first, concept headings allowed |
| Composition change, stable behavior | Refactor or architecture guide | Old shape, new shape, ownership decision |
| Versioned release or migration | Release notes | Version heading, contents, breaking section |

When unsure, default to the focused fix and add structure only when a reader would be lost without it.

## Hard Rules

- Do not include `## Summary`, `## Changes`, `## Testing`, `## Test Plan`, or `## Verification` sections unless the user explicitly asks.
- Report commands run, tests run, and verification gaps in the chat final response, not the PR body.
- Do not list changed files. The diff tab already does that.
- Do not include AI or tool attribution.
- PR titles use the same conventional commit format as commits.
- Include code examples for public API, CLI, HTTP, config, or type-signature changes.
- Name breaking changes with old and new examples.
- When a PR changes prose, instructions, or rules, quote the old and new wording.
- Add a `## Changelog` section only for `feat:` and `fix:` PRs with user-visible changes.

## References

Load these on demand:

- Body shapes, openers, headings, framing patterns, and what to avoid: [references/body-patterns.md](references/body-patterns.md).
- Diagram catalog (composition trees, before/after, journeys, flow, comparison tables) with when to use each: [references/visual-patterns.md](references/visual-patterns.md).
- A full worked body to copy a structure from before drafting your own: [references/examples.md](references/examples.md).
- Changelog entries for `feat:` or `fix:` PRs: [references/changelog-entries.md](references/changelog-entries.md).
- Issue linking, username verification, CODEOWNERS, and merge strategy: [references/github-pr-operations.md](references/github-pr-operations.md).
