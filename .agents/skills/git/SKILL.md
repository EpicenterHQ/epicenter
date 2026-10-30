---
name: git
description: Apply Epicenter Git conventions for commits, branches, and history. Use when staging files, writing or splitting commits, creating branches, or inspecting history, not for pull request text or merge guidance.
metadata:
  author: epicenter
  version: '2.0'
---

# Git Commit Guidelines

> **Related Skills**: See [standalone-commits](../standalone-commits/SKILL.md) for making each commit reviewable and auditable and for ordering multi-file changes into dependency-ordered waves. See [pull-request](../pull-request/SKILL.md) for PR titles, descriptions, changelog entries, issue references, and merge guidance.

## PR Boundary

PR titles, PR bodies, changelog entries, issue links, username verification, CODEOWNERS notes, and merge strategy belong to [pull-request](../pull-request/SKILL.md).

## References

This skill keeps its rules inline. For PR work, use [pull-request](../pull-request/SKILL.md).

## Conventional Commits Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Commit Types

- `feat`: New features (correlates with MINOR in semantic versioning)
- `fix`: Bug fixes (correlates with PATCH in semantic versioning)
- `docs`: Documentation only changes
- `refactor`: Code changes that neither fix bugs nor add features
- `perf`: Performance improvements
- `test`: Adding or modifying tests
- `chore`: Maintenance tasks, dependency updates, etc.
- `style`: Code style changes (formatting, missing semicolons, etc.)
- `build`: Changes to build system or dependencies
- `ci`: Changes to CI configuration files and scripts

### Scope Guidelines

- **Scope is OPTIONAL**: only add when it provides clarity
- Use lowercase, placed in parentheses after type: `feat(transcription):`
- Prefer specific component/module names over generic terms
- Your current practice is good: component names (`EditRecordingDialog`), feature areas (`transcription`, `sound`)
- Avoid overly generic scopes like `ui` or `backend` unless truly appropriate

### When to Use Scope

- When the change is localized to a specific component/module
- When it helps distinguish between similar changes
- When working in a large codebase with distinct areas

### When NOT to Use Scope

- When the change affects multiple areas equally
- When the type alone is sufficiently descriptive
- For small, obvious changes

### Description Rules

- Start with lowercase immediately after the colon and space
- Use imperative mood ("add" not "added" or "adds")
- No period at the end
- Keep under 50-72 characters on first line

### Breaking Changes & Version Bumps

Our monorepo uses a unified version scheme (`8.Y.Z`) where major version 8 is permanent:

- **Patch** (default): Every merged PR increments `Z` (e.g., `8.0.1` → `8.0.2`)
- **Minor**: Add `!` after type/scope: `feat(api)!: change endpoint structure`, increments `Y`, resets `Z`
- **Major**: Manual only. Reserved for "if ever needed." Do not use `!` expecting a major bump.

Include `BREAKING CHANGE:` in the commit footer with details when using `!`.

### Examples Following Your Style:

- `feat(transcription): add model selection for OpenAI providers`
- `fix(sound): resolve audio import paths in assets module`
- `refactor(EditRecordingDialog): implement working copy pattern`
- `docs(README): clarify cost comparison section`
- `chore: update dependencies to latest versions`
- `fix!: change default transcription API endpoint`

## Commit Messages Best Practices

### The "Why" is More Important Than the "What"

The commit message subject line describes WHAT changed. The commit body explains WHY.

**Good commit** (explains motivation):

```
fix(auth): prevent session timeout during file upload

Users were getting logged out mid-upload on large files because the
session refresh only triggered on navigation, not background activity.
```

**Bad commit** (only describes what):

```
fix(auth): add keepalive call to upload handler
```

The first commit tells future developers WHY the code exists. The second makes them dig through the code to understand the purpose.

### Other Best Practices

- NEVER include Claude Code or opencode watermarks or attribution
- Each commit should represent a single, atomic change
- Keep skill and agent-instruction changes in dedicated commits, separate from app and package changes, so they can be cherry-picked onto local `main`.
- Write commits for future developers (including yourself)
- If you need more than one line to describe what you did, consider splitting the commit

## What NOT to Include:

- `Generated with [Claude Code](https://claude.ai/code)`
- `Co-Authored-By: Claude <noreply@anthropic.com>`
- Any references to AI assistance
- `Generated with [opencode](https://opencode.ai)`
- `Co-Authored-By: opencode <noreply@opencode.ai>`
- Tool attribution or watermarks
