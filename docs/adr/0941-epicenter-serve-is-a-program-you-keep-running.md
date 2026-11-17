# 0941. `epicenter serve` is a program you keep running

- **Status:** Accepted
- **Date:** 2026-11-17
- **Amends:** [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md) on who writes serve's job: `epicenter` writes none, and `epicenter service` is removed.
- **Relates:** [ADR-0865](0865-the-epicenter-mac-app-runs-epicenter-serve-so-the-computer-it-is-on-is-your-server.md) (the Mac app registers its own LaunchAgent), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve per home runs every action).

## Context

`epicenter service install|uninstall|restart|status` wrote and drove a macOS
LaunchAgent for serve ([`service.ts` at d1980af95a](https://github.com/EpicenterHQ/epicenter/blob/d1980af95a/packages/cli/src/service.ts)). Linux and Windows each
needed a writer and tests of their own, and neither was built. ADR-0865 already
has the Mac app register its own LaunchAgent, and rejects one that `epicenter`
installs for itself.

## Decision

**Start `epicenter serve` and keep it running, as you would any program.
Epicenter installs nothing to do that for you.** It runs in a terminal, under
the person's own systemd unit or LaunchAgent, or under the Mac app (ADR-0865).
The `epicenter` command writes no job and restarts nothing. A serve that stops
stays stopped, and every action command prints
``Epicenter is not running for this home. Start it with `epicenter serve`.``
and exits 2.

## Consequences

- Without the Mac app, a Mac user writes their own LaunchAgent to keep serve up
  across a restart.
- Linux and Windows cost the CLI nothing.
- `service` is no longer a command name, so an app can take it.

## Considered alternatives

- **Keep `epicenter service` and add systemd and Windows writers.** One writer
  and one test suite per operating system, for a job ADR-0865 gives the Mac app.
- **Copyable systemd and LaunchAgent files in the README.** Paths and labels
  guessed from the reader's computer, in two formats Epicenter keeps nowhere
  else.
- **A parent process that restarts serve after a crash.** An action that throws
  already returns a failed answer (`runAction` in `packages/cli/src/run.ts`).
  What remains, such as an action calling `process.exit`, is a bug that a
  restart would hide.
