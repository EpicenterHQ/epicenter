# 0686. One HTTPS site is one portable release and one data area

- **Status:** Accepted
- **Date:** 2026-10-23
- **Supersedes as a direction:** The proposed source-install runner in [ADR-0680](0680-rust-serves-each-installed-app-from-a-pinned-build-on-its-own-origin.md). The legacy bundled-app path remains during migration.
- **Unbuilt:** Published first-party URLs, migration of every bundled app, and Windows/Linux origin and activation probes.
- **Amended by:** [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) at window close: the host asks the page over the Folder channel; the page answers after its writes land; a second request asks natively.

## Context

Epicenter's bundled apps have a separate `EPICENTER_HOST` build and run
below paths on one `epicenter-app://localhost` origin. A proposed source
installer would have added a Git checkout, build, installation key, app
manifest, active-build record, per-window build pin, and app-to-folder choice.
People more often arrive at a published URL; their own app or agent can
edit source and publish a new build there. The desktop needs reliable
offline execution and a bounded local data area, not source ownership.

## Decision

A hosted app is a canonical HTTPS root hostname. The publisher serves the
ordinary static SPA at that origin and a complete archive of those same
build bytes as plain ustar at `/.well-known/epicenter/site-v1.tar`. This fixed endpoint is
the v1 artifact and Folder-wire compatibility contract. It is not a
manifest or a registry. The host validates and stores the complete tar as one
`release.tar`, indexing file offsets and serving bytes directly from it,
then executes it from a separate local origin per hostname. It opens only
stored bytes, including when online. An update can activate only after its
site window has closed; failed download or validation leaves the old active
release. Code rollback after a new release edits data is not promised.

The hostname also determines one reverse-DNS child of the Epicenter folder:
`https://todos.acme.dev` uses `dev.acme.todos`. The site cannot select
another directory. Epicenter's own `so.epicenter` area is reserved. The
host confirms adoption when the derived child already exists on first use,
and remembers that association only to reject silent recreation if it later
disappears. Files, agents, and CLI may still inspect multiple areas; an
ordinary hosted app receives only its bound Folder plugin. Folder observation and close requests use channels owned by the
calling WebView; the site receives no application-wide Tauri event or window
permission. The native host handles unfinished-save close confirmation.

The site may use ordinary HTTPS/WSS browser networking. Its executable
scripts and workers must come from the installed release. WebView CORS,
cookies, and OAuth redirects see the local execution origin, so a remote
service must accept that origin or a later narrow portable capability must
solve the concrete case. Offline guarantees cover the static shell and local
folder edits, not remote services. WebView device permissions are denied.
The URL publisher can read and transmit
its own area on every update; accepting that ongoing trust avoids a
per-capability permission matrix. The host enforces separation between
sites, its own pages, and other local directories.

## Consequences

- The desktop does not clone, build, or approve source. Editing source and
  publishing the site are publisher workflows.
- Organization subdomains can be grouped in the UI but confer no shared
  folder grant.
- One published build needs runtime-selected `@epicenter/*` implementations
  for browser and hosted WebView. Legacy host-only builds are removed as
  their consumers migrate.
- The current macOS implementation is the first platform slice. Other
  platforms stay disabled until local-origin isolation and durable
  activation are verified there.
