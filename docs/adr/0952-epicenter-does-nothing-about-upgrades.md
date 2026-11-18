# 0952. Epicenter does nothing about upgrades

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) on how the command learns serve's version.
- **Relates:** [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) (serve is a program you keep running), [ADR-0943](0943-epicenters-core-invariants.md) (rules 2, 7 and 8).
- **Unbuilt:** all of it. Serve still sends `x-epicenter-version`, and the command still warns on a mismatch.

## Context

Serve loads the library and every app's packages once, and re-reads only an
app's own files on each call. After `bun install` changes packages, serve
keeps running the old ones until it restarts. To catch a forgotten restart,
serve stamps `x-epicenter-version` on every answer (`packages/cli/src/http.ts`,
`serve-call.ts`), and the command prints "Epicenter is running version X and
this command is version Y. Stop `epicenter serve` and start it again"
(`packages/cli/src/cli.ts`). The warning comes after the call already ran on
the old code.

The alternative considered first was for serve to watch `bun.lock` and exit
when it changes. That adds a watcher and a deliberate exit, and it assumes
something restarts serve, which ADR-0941 leaves to the owner.

## Decision

**Epicenter does nothing about upgrades. Serve is a program: you restart it
after upgrading it, like any other program.**

- Upgrading is: edit both versions in the root `package.json`, run
  `bun install && bun run build`, then restart serve the way you keep it
  running.
- Serve does not send its version, watch `bun.lock`, or exit by itself. The
  command does not compare versions.
- `init` writes no `upgrade` script. The restart depends on how the owner
  keeps serve running (ADR-0941), which `init` does not know, and an owner
  who wants one line can add it to their own `package.json`.

## Consequences

- Removed: `x-epicenter-version` and `VERSION_HEADER`, the `version` field
  serve's answer carries back to the command, and the mismatch warning.
- A forgotten restart shows nowhere. The bare `epicenter` listing reports the
  installed version, which the command reads from its own `node_modules`, not
  the version serve is running. Until the restart, serve runs the old code and
  a page rebuilt for the new client may fail in ways that do not name the
  cause. The upgrade steps in `init`'s `AGENTS.md` and the command's README end
  with the restart for this reason.
- Nothing here conflicts with ADR-0941: serve stays a program that does not
  restart itself or anything else.

## Considered alternatives

- **Serve exits when `bun.lock` changes, and its supervisor starts it
  again.** No forgotten restart, but it adds a watcher and a self-exit, and a
  serve started in a terminal stays down until the owner notices.
- **Keep the header, renamed `Epicenter-Version`.** It catches a forgotten
  restart, but only after a call ran on old code, and it costs a header on
  every answer and a comparison in every command.
- **The listing asks serve for its version.** It makes a forgotten restart
  visible on request, but needs the same header or a version route to answer.
