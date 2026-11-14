# GitHub PR Operations

## When To Read This

Read when drafting PR descriptions with issue references, mentioning GitHub users, or choosing the merge strategy.

## Scanning GitHub Issues Before Writing a PR Description

Before drafting a PR description, run a cursory search of open GitHub issues to identify any that the PR's changes may fix, partially address, or lay groundwork for:

```bash
# List open issues (scan titles for keywords matching the PR's scope)
gh issue list --state open --limit 100 --json number,title,labels

# Read a specific issue to check if the PR addresses it
gh issue view <NUMBER> --json title,body,labels,comments
```

**What to look for:**
- Issues whose root cause matches code you changed (e.g., error handling, provider bugs, API connection issues)
- Feature requests where your changes are a prerequisite (mention as "lays groundwork for")
- Bug reports where your changes improve error messages or diagnostics without fully fixing the bug

**How to reference in the PR description:**
- `Closes #123`: only if the PR fully resolves the issue
- `Partially addresses #123`: if the PR improves the situation but doesn't fully fix it
- `Lays groundwork for #123`: if the PR creates infrastructure that a future PR will use to fix the issue

**Be honest:** Don't claim a fix unless the changes directly address the root cause. Improved error messages or internal refactors that happen to touch related code do not count as fixes.

## Verifying GitHub Usernames

**CRITICAL**: When mentioning GitHub users with `@username` in PR descriptions, issue comments, or any GitHub content, NEVER guess or assume usernames. Always verify programmatically using the GitHub CLI:

```bash
# Get the author of a PR
gh pr view <PR_NUMBER> --json author

# Get the author of an issue
gh issue view <ISSUE_NUMBER> --json author
```

This prevents embarrassing mistakes where you credit the wrong person. Always run the verification command before writing the @mention.

## Merge Strategy

When merging PRs, use regular merge commits (NOT squash):

```bash
gh pr merge --merge  # Correct: preserves commit history
# NOT: gh pr merge --squash
# NOT: gh pr merge --rebase
```

A merge that branch protection blocks waits for its checks. Bypassing protection with `--admin` is the person's decision, not the agent's.

Preserve individual commits; they tell the story of how the work evolved.
