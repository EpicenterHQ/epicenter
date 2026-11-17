# 0913. CLI developer previews are non-latest GitHub releases

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0892](0892-the-cli-releases-to-npm-and-whispering-8-is-a-new-install-with-its-own-update-address.md), only its CLI distribution and tag choice. Whispering's identity, import, and update-address decisions remain.
- **Unbuilt:** committed release source, four native CI runs, and public CLI downloads.

## Context

A developer needs to install the compiled CLI without first installing Bun or
Node. GitHub already holds source and can host platform binaries, checksums,
and a shell installer. The monorepo also hosts Whispering releases whose update
checks use the global Latest address. A CLI release must not take that address.

## Decision

Prepare CLI developer previews as GitHub prereleases tagged
`epicenter-cli-v<VERSION>`. Use version-specific download URLs. Create drafts
with `--prerelease --latest=false`; publish with both settings preserved.
Do not change the global Latest release or upload desktop update manifests.

Build on native macOS and Linux runners for arm64 and x64. Each runner installs
its downloads into an isolated home and uses a committed writing source copy
through the CLI, UI build, and MCP. Create a draft only after all targets pass
and the public writing app exists. Build from the tagged source commit, never
upload a dirty checkout's binary as another commit's release.

## Consequences

One curl command installs an executable without a JavaScript package manager.
Maintainers review the draft before publication. The preview status prevents
the CLI from becoming Latest; removing that status needs another decision
about Whispering's updater. Publication of npm packages remains separate work.

## Considered alternatives

- npm platform packages from ADR-0892: isolates Whispering's release feed and
  fits Node users, but requires a package manager before installing this CLI.
- A release-only repository: isolates feeds, but adds a repository for the
  first preview when prereleases already keep Latest unchanged.
- A stable GitHub release marked Latest: breaks the address used by existing
  Whispering installations.
