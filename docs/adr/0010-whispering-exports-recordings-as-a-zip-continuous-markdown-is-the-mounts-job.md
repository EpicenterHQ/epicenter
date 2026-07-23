# 0010. Whispering exports recordings as an on-demand zip; continuous Markdown is the mount's job

- **Status:** Accepted
- **Date:** 2026-06-16
- **Amended by:** [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md) (the on-demand recording zip remains; the deleted Workspace mount and materializer no longer own continuous Markdown)

## Context

Whispering's recordings live in the workspace (Yjs rows). Users sometimes want
that content as Markdown files on disk: to drop into Obsidian, a git repo, or a
backup. Two mechanisms were on the table. A draft branch (PR #1981) added an
always-on observer that materialized each recording to a hidden appdata sidecar
(`recordings/{id}.md` beside the audio). Earlier the manual export wrote loose
`.md` files into a folder the user picked, but only on desktop; on web it
returned an "unsupported" stub.

The sidecar writes to `~/Library/Application Support/.../recordings/`, a machine
directory of opaque-id files. A repo-wide search found no reader of those files:
no human path (it is appdata), no agent, no CLI, no SQLite surface. It is a
continuous producer with no consumer, paid on every edit. Meanwhile Epicenter
already has the right home for continuous Markdown: a folder becomes a mount via
`epicenter.config.ts`, and the daemon materializes the workspace to Markdown in a
folder the user controls, plus a SQLite mirror that is the agent read surface
(this is how `apps/fuji` works).

## Decision

Recording Markdown leaves Whispering as a single on-demand zip, downloaded
through the existing `#platform/download` seam: a Save dialog on desktop, a
browser download on web. The action is platform-agnostic, defined once and shared
by both runtime clients. We refuse a continuous appdata sidecar. When users want
Markdown files that stay current in a folder they own, that is the Epicenter
mount's job (`epicenter.config.ts` + daemon), not bespoke per-app machinery
pointed at hidden appdata.

## Consequences

- The export works identically on web and desktop, and is a portable snapshot
  (`recordings.zip`), not a live mirror. Users who want a living folder use a
  mount; the snapshot action does not chase that use case.
- Deletes the desktop-only folder-picker path, the web "unsupported" stub, and
  the Rust `write_markdown_files` command. One shared action replaces three.
- PR #1981's continuous sidecar is not adopted; this ADR supersedes that
  direction. #1981's `packages/workspace` materializer generalization is a
  separate concern and may proceed on its own merits as the mount infrastructure
  this ADR points at.
- Whispering is not mountable by the daemon today (its workspace lives in
  IndexedDB / the Tauri webview, with no node-readable store). The continuous
  path is therefore future work, deliberately deferred until a real reader
  exists. This ADR is the guardrail against re-growing a bespoke sidecar in the
  meantime.
- Cost: a desktop user who wanted loose `.md` files dropped straight into a
  folder now receives a zip and unzips it. That continuous-into-my-vault desire
  is exactly what the mount path is for.
