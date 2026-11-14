# 0878. The OS keeps `epicenter serve` running, under a job the person installs

- **Status:** Accepted
- **Date:** 2026-11-11
- **Unbuilt:** the Mac app's registration; the Studio's `serve` still runs from a monorepo worktree until the person runs `epicenter service install` there. Built: `epicenter service install|uninstall|restart|status` as a macOS LaunchAgent and as a systemd user unit, each with the installing shell's `PATH` (`packages/cli/src/service.ts`), and `AGENTS.md` read on each MCP initialize (`packages/cli/src/mcp.ts`).
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (your server is the computer that runs `serve`), [ADR-0865](0865-the-epicenter-mac-app-runs-epicenter-serve-so-the-computer-it-is-on-is-your-server.md) (the Mac app), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (several Epicenters on one computer), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (the installed command).

## Context

`serve` must outlive the terminal or agent that started it and come back after
a reboot or a crash. On the Studio today it is
`bun <worktree>/packages/cli/src/bin.ts serve`, started by an agent: deleting
that worktree stops the server, switching its branch changes it, and nothing
starts it again. An agent asked to install a LaunchAgent was stopped by its
permission checks; a program that starts at every login is the person's
decision.

`serve` needs restarting less than it seems. Each action runs in a fresh
child process and each UI file is read when asked for, so changing an app or
rebuilding its UI needs no restart. What does: a new `epicenter`, a changed
`EPICENTER.md`, and today a changed `AGENTS.md`, which `serve` reads once.

## Decision

**`epicenter serve` is a foreground process, and the operating system keeps it
running.** It stops cleanly on `SIGINT` and `SIGTERM` and supervises nothing.

**`epicenter service install` writes the job; the person runs it, once per
Epicenter.**

- On macOS it is a LaunchAgent in `~/Library/LaunchAgents/`, one per
  Epicenter, labelled from the Epicenter's folder, with `RunAtLoad` and
  `KeepAlive`. It runs the `epicenter` found on `PATH` by absolute path, or the
  compiled binary, in the Epicenter's folder. Its `PATH` is the installing
  shell's `PATH`. It logs to
  `~/Library/Logs/Epicenter/<label>.log`.
- On Linux it is a systemd user unit in `~/.config/systemd/user/` (or
  `$XDG_CONFIG_HOME`), one per Epicenter, named from the same label, enabled
  for `default.target` with `Restart=always` and no start limit. It runs the
  same `epicenter` with the installing shell's `PATH`, and `TZ` when set, in
  the Epicenter's folder. It logs to the journal, read with
  `journalctl --user -u <unit>`.
- Neither job carries the shell's Git variables, so `install` refuses until
  Git's own configuration says who commits.
- `epicenter service restart` restarts the job (`launchctl kickstart -k`, or
  `systemctl --user restart`); `status` says whether it runs, its port, and on
  Linux whether linger is on. Agents may run both.
  `install` and `uninstall` are the person's.
- Upgrading is installing the new `@epicenter/cli`, then
  `epicenter service restart`.

**`serve` reads `AGENTS.md` when each MCP client initializes,** as it reads a
UI's files when asked. Only a new `epicenter` or a changed `EPICENTER.md`
needs a restart.

## Consequences

- After a reboot `serve` returns once the person's session starts, so an
  always-on Mac logs in automatically. With FileVault on, a reboot after a
  power loss waits at the unlock screen.
- On a Linux server, linger replaces automatic login: once the person runs
  `loginctl enable-linger`, systemd starts their units at boot and keeps them
  after they log out, and `install` and `status` say when it is off. A rented
  server has no unlock screen: when the provider restarts the machine, `serve`
  comes back at boot. `systemctl --user` needs the person's own session, so
  `install` run without one, as through `sudo su` on many servers, refuses and
  names another way in.
- No agent finds a port or a process to stop: restarting is one command.
- `epicenter init` writes nothing that starts at login; tests and agents run it
  in throwaway folders.
- The Mac app's "Run Epicenter" registers this same job (ADR-0865), so there is
  one supervisor whichever way `serve` was set up.

## Considered alternatives

- **The Mac app as the supervisor.** A second program to keep alive, and only
  for people who install the app; launchd already does this on every Mac.
- **`serve` daemonizing itself, with a pid file and `epicenter stop`.** It
  reinvents what launchd and systemd do, and still cannot start after a reboot.
- **Installing the job in `epicenter init`.** `init` is run in temporary
  folders by tests and agents, and starting a program at every login is not
  setup a person should get without asking for it.
</content>
</invoke>
