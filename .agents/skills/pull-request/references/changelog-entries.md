# Changelog Entries in PRs

## When To Read This

Read when preparing PR descriptions for `feat:` or `fix:` changes that require end-user changelog entries.

PRs with `feat:` or `fix:` prefix MUST include a `## Changelog` section in the PR description body. Release notes are written from these entries.

**Rules:**

- One line per user-visible change
- Written for end users, not developers. Describe the benefit, not the implementation
- Use imperative mood ("Add...", "Fix...", not "Added" or "Fixes")
- Internal-only PRs (`chore:`, `refactor:`, `docs:`) should omit the section entirely

**Good entries:**

```
## Changelog
- Add local workspace sync via Bun sidecar
- Fix sync client sending unnecessary heartbeat probes
```

**Bad entries:**

```
## Changelog
- refactor(services): flatten isomorphic/ to services root
- Bump transcribe-rs 0.2.1 to 0.2.9
```

The first examples describe user-visible outcomes. The second examples are developer shorthand that means nothing to users.
