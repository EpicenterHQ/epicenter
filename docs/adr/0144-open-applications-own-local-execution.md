# 0144. Open applications own local execution

- **Status:** Accepted
- **Date:** 2026-07-14
- **Supersedes:** [ADR-0112](0112-the-cli-watcher-is-not-a-callable-action-server.md)
- **Relates:** [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md)

## Context

The generic watcher survives to synchronize mounted workspaces and keep
materializers alive after every application closes. That lifecycle requires a
root lease, process metadata, logs, signals, stable installation identity, and
generic mount composition. The product makes no promise that Epicenter work
continues when every relevant application and explicit command is closed.

## Decision

An open application owns its local execution. It catches up synchronized data,
runs local projections, and performs interactive or approved actions for as
long as its browser, extension, desktop, or CLI process is alive. A desktop app
may remain open in the background or tray when the user wants that behavior.

An application may expose three execution commands when its product needs
them:

- `sync` performs one catch-up pass and exits.
- `status` reads durable application state, reports freshness and pending work,
  optionally checks the upstream service, and exits.
- `watch` runs that application's catch-up loop in the foreground until the
  operator stops it.

The `epicenter` CLI may later offer a terminating convenience command that
discovers configured applications, invokes each app's `sync`, reports their
results, and exits. That is fan-out, not a folder runtime. It may not own PID
files, restart policy, process status, resident logs, or a process that outlives
the invoked app engines. Adding those responsibilities would be a new daemon
product decision, not a harmless CLI simplification.

These are application commands over one named engine. They are not generic
mounts, daemon fallbacks, or an Epicenter automation host. `watch` owns no
process registry, PID metadata, installation identity, backgrounding, log
store, or remote control protocol. Ctrl-C stops an interactive watch. An OS
service manager or scheduler may run `watch` or invoke `sync` periodically when
closed-app freshness is an explicit deployment choice; that manager also owns
restart, shutdown, and log capture.

`status` describes the data, not the process. A useful status answers questions
such as when the last successful sync completed, which cursor was persisted,
whether writes are pending, and whether the upstream service is reachable. It
does not enumerate running Epicenter processes or imply that a live process
means the data is current.

Epicenter builds no generic local automation executor. Repeatable catch-up work
runs when an app next opens, when `sync` is invoked, or while that app's
foreground `watch` is running. Concurrent catch-up is handled by the
application's cursor, idempotency, and writer lock rather than by machine
identity. A side effect that requires a present human runs only after approval
in the active app. Only a future feature that explicitly promises guaranteed
unattended execution may introduce a cloud-owned job runtime; that feature must
own job identity, retry, idempotency, and leases. This decision creates no such
runtime in advance.

## Consequences

The generic watcher, mount runtime, watcher lifecycle commands, root lease,
presence logging, and daemon-specific persistence are deleted after their last
application consumer moves to an open-app or application-command owner.
Application-specific engines such as Local Mail and Local Books remain valid
because their durable cursors and SQLite mirrors belong to those products.

There is no generic equivalent of `up`, `down`, `status`, and `logs`. A product
may provide `watch` and data-oriented `status`; Ctrl-C or the invoking service
manager stops it, and ordinary stdout and stderr are its logs.

If every application and command is closed, local work stops. Data catches up
when a process opens again. Super Chat may still be left open as a product host,
and its remote-attach identifiers remain scoped to that live session rather
than becoming machine identity.
