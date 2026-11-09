# 0112. The CLI watcher is not a callable action server

- **Status:** Accepted
- **Date:** 2026-07-06
- **Amended by:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) at "The CLI resident process remains": no `epicenter` process outlives its command, and the refusal of a local action server stands.
- **Supersedes:** [ADR-0009](0009-the-cli-dispatches-through-a-mandatory-daemon.md)
- **Relates:** [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md), [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md), [ADR-0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md)

## Context

The CLI daemon was introduced as a mandatory local process for `epicenter run`,
`epicenter list`, and `epicenter peers`. ADR-0009 justified that shape by
framing the daemon as a callable peer in a device mesh: a device was either
online and callable, or it was offline. That rationale no longer matches the
system. The mesh peer, `run --peer`, in-room action dispatch, relay action channel,
and the daemon action handler were deleted. Cross-device work is no longer a
`/run` concern.

The useful product need that remains is different: a user can run Epicenter
headlessly for one folder so the workspace stays synchronized and materialized.
That process owns the lease, node id, sync connection, materializers, logs, and
metadata. It does not need to be an addressable local action server.

The generic off-process action surface also had no live first-party consumer.
Apps call workspace actions in-process through their own runtime or local tool
catalogs. The old documented script path, `connectDaemonActions`, had tests but
no production caller in the repo.

## Decision

The CLI resident process remains. It is a headless watcher for one Epicenter
root: it opens the configured mount, owns local machine state under
`.epicenter/`, joins sync when a session is available, runs materializers, writes
logs and metadata, and exits cleanly on signal.

The watcher is not a callable action server. Epicenter does not expose a local
Unix socket, HTTP app, `/run`, `/list`, or `/peers` endpoint for invoking or
introspecting mount actions. The CLI does not provide generic `run`, `list`, or
`peers` verbs. Library scripts do not use `connectDaemonActions` to call a live
watcher.

Workspace actions remain an in-process concept. Apps, local AI tools, and future
app-specific commands may call actions inside the process that opened the
workspace. A future write workflow should earn an explicit product verb, such as
an import or capture command, instead of resurrecting a generic action bus.

## Consequences

The cleanup deleted the external IPC plane while preserving headless operation.
`epicenter up` opens a mount, syncs, materializes, logs presence and sync status,
and tears down. `down`, `status`, and `logs` operate through metadata, pid
liveness, and log files. The old `daemon` namespace was deleted with no
compatibility aliases.

The trade-off is explicit: users lose the generic shell escape hatch
`epicenter run <action>`, action introspection through `epicenter list`, on-demand
peer listing through `epicenter peers`, and the typed `connectDaemonActions`
script proxy. Those surfaces can return only if a real consumer makes the local
action-server product worth its protocol, validation, concurrency, and
compatibility obligations.

This decision does not require every app to become a desktop app. Desktop apps
own interactive human workflows. The watcher owns headless sync,
materialization, and app-owned background work. One-shot app verbs may open the
workspace directly under the lease when a concrete workflow needs them.

## Re-entry triggers

Reopen local watcher IPC only when a real first-party or external workflow needs
to call a running watcher and cannot be served by an app-specific command,
in-process tool catalog, or one-shot lease-guarded workspace open. The new
decision must name the caller, the stability contract for action names and
schemas, the concurrency story, and why a generic protocol is better than a
specific verb.

Reopen `peers` only when there is a user-facing workflow that needs on-demand
presence outside the watcher logs or app UI. Debug curiosity is not enough to
keep a socket protocol alive.

## Considered alternatives

Keep the then-current IPC plane and fix the docs: rejected. It would have
preserved a socket, HTTP app, typed client, action manifest, JSON input parser,
and three commands for a callable-peer story that no longer exists in code.

Delete the resident process entirely: rejected. The resident process still owns
real headless value: the single-writer lease, sync connection, materializer
lifecycle, logs, metadata, and clean shutdown.

Make desktop apps the only runtime: rejected. Desktop apps and headless watchers
serve different jobs. A machine should be able to keep a folder synchronized and
materialized without an interactive UI.

Add dual paths where commands open the workspace directly if no watcher is
running: rejected for this wave. The single-writer invariant is easier to reason
about when one root has one active owner. App-specific one-shot verbs can be
designed later against a concrete workflow and the lease.
