# 0009. The CLI dispatches through a mandatory daemon; automation lives in library scripts

- **Status:** Superseded
- **Date:** 2026-06-16
- **Superseded by:** [ADR-0112](0112-the-cli-watcher-is-not-a-callable-action-server.md)

## Context

`epicenter run`, `epicenter list`, and `epicenter peers` once had two execution
modes: talk to a running daemon if one existed, otherwise `loadConfig` and run
the work inline (the cold path). That dual path made sense while the daemon's job
was framed as "amortize cold-start cost for repeated CLI calls." It stops making
sense once the daemon is reframed as a callable peer in the device mesh: a device
either *is* online (a daemon is running) or it *is not*; there is no coherent
third state for a transient peer that exists for the duration of one CLI call. The
dual path also carried real complexity (nested `Result`, schema/`Ctx`
duplication, a `*Core` extraction whose only consumer was the cold path, a
startup state enum).

## Decision

`run`, `list`, and `peers` require a live local daemon and have no `loadConfig`
cold-path fallback. They dispatch over the Unix socket via `getDaemon(root)`
<!-- doc-path-check: ignore-next-line -->
(`packages/workspace/src/daemon/client.ts`), which pings the socket and returns
`DaemonError.Required` when nothing answers; the command prints the hint and
exits non-zero. The daemon is started by `epicenter daemon up` and is a long-lived
foreground process: one daemon per Epicenter root, exposing that root's mount as a
callable mesh peer (`run --peer <id>` dispatches RPC to a remote peer; `peers`
lists presence).

The daemon-lifecycle verbs (`daemon up`, `daemon down`, `daemon ps`,
`daemon logs`) do not touch the RPC plane and need no running daemon. Power-user
automation belongs in workspace-library scripts (`bun ./script.ts` calling the
workspace API directly), which can compose, loop, branch, and dispatch RPC across
the mesh. The CLI is a one-shot shell shortcut over a one-line invocation, not the
automation surface.

## Consequences

- Running `run`/`list`/`peers` without `epicenter daemon up` is now an error with a
  one-line hint, not a slow-but-working cold start. Casual first-run UX is worse;
  the hint and the README mitigate it.
- The four cold-path-only complexities (nested `Result`, hand-written `Ctx`
  shadow types, the `*Core` extraction, the startup state enum) are gone, because
  they all traced to the dual-path commitment.
- A crashed daemon blocks `run`/`list`/`peers` for that root until restart;
  `daemon ps` and `daemon logs` make that observable.
- The library API is untouched: scripts still open a workspace and dispatch
  locally or to remote peers. Narrowing the CLI did not narrow the library.

## Considered alternatives

- **Keep the cold-path fallback.** Rejected: it amortizes a repeated-invocation
  cost the user does not actually pay through the CLI (real loops live in
  library scripts), and it was the root of every cold-path-only complexity.
- **Auto-spawn a daemon on first `run`/`list`/`peers`.** Rejected: it
  reintroduces the "transient peer for one call" state this decision exists to
  remove, by another name.
- **An `epicenter exec ./script.ts` that runs TypeScript inside the daemon.**
  Rejected: a code-injection surface; the answer for a warm workspace is to write
  the script and `bun` it directly.
