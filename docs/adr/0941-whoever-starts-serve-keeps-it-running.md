# 0941. Whoever starts serve keeps it running

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md) on who writes the job: the `epicenter` command writes none, and `epicenter service` is removed. Its rule that `serve` reads `AGENTS.md` on each MCP initialize stands.
- **Relates:** [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve per home; its lines about `epicenter service install` are edited to match), [ADR-0865](0865-the-epicenter-mac-app-runs-epicenter-serve-so-the-computer-it-is-on-is-your-server.md) (the desktop app runs serve), [ADR-0903](0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md) (a rented home on Linux).
- **Unbuilt:** the desktop app's start-at-login, tray status, and start and stop for serve (ADR-0865).

## Context

ADR-0878 had the CLI write the operating system's job for serve.
`epicenter service install|uninstall|restart|status` wrote and drove a macOS
LaunchAgent (`packages/cli/src/service.ts`, removed in this change). The Linux
systemd unit and anything for Windows were never built. Each operating system
needs its own writer, its own tests against a faked `launchctl` or
`systemctl`, and its own upgrade and uninstall story, all inside the CLI. The
planned desktop app (ADR-0865) is built on Tauri, whose autostart already
covers macOS, Linux, and Windows.

## Decision

**`epicenter serve` is one plain process.** It stops on `SIGINT` and
`SIGTERM`. If it crashes, it stays stopped: the CLI starts no child to watch
it and restarts nothing.

**Whoever starts serve keeps it running.**

| Where serve runs | What keeps it running |
| --- | --- |
| The desktop app | the app: start at login, a tray status, start and stop (ADR-0865) |
| A headless computer | the person, with the OS's own tool: a systemd user unit with `Restart=on-failure`, or a launchd LaunchAgent with `KeepAlive` |
| A terminal | the person |

**A stopped serve is visible.** Every action command answers
``Epicenter is not running for this home. Start it with `epicenter serve`.``
and exits 2. A newer command talking to an older serve prints
``Stop `epicenter serve` and start it again.``

`packages/cli/README.md` ("Keep serve running") carries a systemd unit and a
LaunchAgent plist to copy.

## Consequences

- The CLI loses `service.ts`, its tests, and the `service` entry in
  `commands.ts`. `service` is no longer a reserved word, so it can name an app.
- A Mac user loses the one-command install until the desktop app exists. The
  README snippets cover that gap with a file to copy and one command to load.
- Linux and Windows cost the CLI nothing. A Linux user writes the same unit
  ADR-0878 would have written, and `loginctl enable-linger` keeps it up on a
  headless box.
- Upgrading is installing the new `epicenter` and restarting serve however it
  was started; the CLI no longer offers `epicenter service restart`.
- Routine commands still share serve's process group. Ctrl-C in serve's
  terminal, or stopping its systemd unit or LaunchAgent, stops them too.

## Considered alternatives

- **Keep `epicenter service` for macOS only.** It covers one OS of three and
  duplicates what the desktop app will own.
- **Have serve restart itself through a supervising parent.** A second process
  that every OS job manager already provides, and that hides crashes the
  refusal message now shows.
