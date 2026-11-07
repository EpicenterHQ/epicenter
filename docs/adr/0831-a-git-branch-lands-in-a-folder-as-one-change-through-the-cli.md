# 0831. A Git branch lands in a folder as one change through the CLI

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Amends:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at "No Git client writes to a folder": a Git branch lands through the CLI as ordinary changes; [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) at one program owning a folder at a time: Git still never syncs a folder, and a branch is translated, never synced.
- **Relates:** [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) (the merge a landed branch meets), [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) (the CLI and MCP).
- **Amended by:** [ADR-0834](0834-every-folder-is-also-a-git-remote.md) at a server endpoint for `git push` waiting for a Git-only sandbox: the Git remote is the destination, and the CLI's commands are its present form.
- **Amended by:** [ADR-0838](0838-git-speaks-to-a-folder-through-a-remote-helper-and-the-cli-speaks-a-persons-verbs.md) at `epicenter git land`: a push lands.
- **Unbuilt:** all of it: `epicenter git land`, its refusals, and an optional message on a change.

## Context

Agents that work in a hosted sandbox usually reach a Git host and work on
branches there. A folder exports to Git deterministically, each commit carrying
`Epicenter-Change` and `Epicenter-Digest`, so a branch made from an export names
the change it started from. Accepting `git push` on the server would need a Git
projection and the receive-pack code ADR-0824 removed.

## Decision

**`epicenter git land` lands a branch as one change.** Given a folder and a
branch of its mirror or a local checkout, it finds the exported commit the
branch started from, checks its digest against the log, and lands the
difference as one change whose expected versions are the files at that change.
A note changed on both sides merges by key and by line; a true conflict refuses
the whole branch, naming the paths, and the agent fetches a fresh export and
tries again. It refuses to land a note that read in the grammar at the start and
no longer does, or that holds conflict markers.

**The sandbox never holds an Epicenter token.** The person's Epicenter app or
CLI lands the branches they name, with their own sign-in; the change records the
branch it came from and its commits' subjects as its message.

**A server endpoint for `git push` waits** for a sandbox that can reach Epicenter
and nothing but Git.

## Consequences

- An agent works on a branch with stock Git, and its work lands with Epicenter's
  merge and checks.
- Push rights on a mirror's branches become, through the person who lands them,
  writes to the folder.
