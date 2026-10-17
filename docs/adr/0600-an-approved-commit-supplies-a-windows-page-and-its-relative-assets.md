# 0600. An approved commit supplies a window's page and its relative assets

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "One approved commit of the default branch supplies every byte a window runs" and "A window runs exactly the bytes approved": the approved commit supplies the window's page and the assets it loads by relative path.
- **Amends:** [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principle 6's "one approved commit supplies every byte that runs": it supplies the page and its relative assets.

## Context

ADR-0589 and ADR-0590 say one approved commit supplies every byte a window
runs. ADR-0588 already says less: a window's navigation stays below
`/apps/<app-id>/<commit>/`, but every installed app shares the one origin
`epicenter-app://localhost` and is trusted fully, so "a page may still fetch
another build's files." A page can load `/apps/<another address>/<commit>/…`
by absolute path, and the scheme serves it
(`resolve`, `apps/epicenter/src-tauri/src/scheme.rs:118-150`).

## Decision

**An approved commit supplies a window's top-level page and every asset
that page loads by relative path.** A request by absolute path to another
build is answered from that build, which was approved when it was
installed. No rule promises that every byte a window runs came from its own
commit.

## Consequences

- The approval a person gives covers what an app ships, not what it
  chooses to load from another installed app.
- Fencing each build would take one origin per app. ADR-0561 serves every
  app from one origin and refused one scheme per app.
