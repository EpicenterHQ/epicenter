# 0952. Serve exits when its packages change

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md), whose consequence "a changed dependency shows after serve restarts" left the restart to the person.
- **Relates:** [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) (whatever keeps serve running starts it again), [ADR-0951](0951-the-command-reaches-serve-through-a-socket-file-in-the-root.md).
- **Unbuilt:** all of it.

## Context

Serve loads the library and every app's packages once, and re-reads only an
app's own files on each call. After `bun install` changes packages, serve keeps
running the old ones until someone restarts it. Two things exist to catch a
forgotten restart: the upgrade steps say to restart serve, and serve stamps
`x-epicenter-version` on every answer so the command can warn "Epicenter is
running version X and this command is version Y. Stop `epicenter serve` and
start it again" (`packages/cli/src/cli.ts`). The warning comes after the call
already ran on the old code.

## Decision

**Serve watches the root's `bun.lock`. When it changes, serve stops taking
calls, lets running calls finish, and exits. Whatever keeps serve running
starts it on the new packages.**

- The login item from ADR-0941 restarts it within seconds. A serve started by
  hand in a terminal prints that packages changed and to start it again.
- `bun.lock` changes on every install that changes any package, the library's
  or an app's, and on no other install.

## Consequences

- Removed: the `x-epicenter-version` header, the command's version warning,
  and "restart serve" from the upgrade steps, which become: edit the version,
  then `bun install && bun run build`.
- A call that arrives during the restart finds no socket and is told serve is
  not running; trying again a few seconds later works.
- The command and serve come from the same `node_modules`, so after the
  restart they are the same version by construction.

## Considered alternatives

- **Keep the header, renamed `Epicenter-Version`.** It still only warns,
  after the call ran on old code, and asks the person to do what serve can do
  itself.
- **Check `bun.lock` on each call and exit before running it.** Then the call
  that noticed must be retried; watching exits before any call can run on the
  old packages, except one already running.
