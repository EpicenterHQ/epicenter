# 0849. Your server is one always-reachable computer that runs named actions

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md): schedules and `epicenter tick`, the front door and its OS timer, a meeting point per app, the door into a box branch, the backup check, and the secrets experiment.
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at who runs a named action (your server only), the laptop's own runner (a folder path instead), and the browser runner (refused). [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at discovery: `~/Epicenter` exists on your server and is not moved by an environment variable, and another computer lists your server's apps.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (the commit rule), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (the remote), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder or ask), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, the server's; its address and sign-in).
- **Unbuilt:** `epicenter setup`, and `epicenter serve` over HTTPS with its sign-in. Built: `epicenter serve --stdio`, which replaced `epicenter mcp`, and the home at `$HOME/Epicenter` with `EPICENTER_HOME` removed.

## Context

The author has one always-on Mac, the Mac Studio, which is also their daily
machine, plus a laptop, a phone, and agents. Three rounds of review traced every
hard case to runs nobody started (schedules) and to one app's actions running in
several places. The author dropped schedules and chose to keep the Mac reachable
rather than design for its absence. A later pass found two ways in (SSH for the
CLI and agents, `serve` for screens) where the CLI already forwarded to
Epicenter Cloud over HTTP. Claude's custom connectors, in every Claude client,
and ChatGPT's connect to an MCP server from their vendor's cloud and need a
public HTTPS address (checked 2026-11-08).

## Decision

**Your server is a computer the person keeps on, and it holds the one copy of
each app** (ADR-0864). For the author it is the Mac Studio. Every client asks
it: an agent, a view in a browser, claude.ai, Claude on the phone. Only a
program whose own work must go on offline, such as Whispering, keeps a copy on
another computer and syncs it with Git. When the server is not reachable, every
named action fails and says so, and nothing else is designed around its
absence. `epicenter setup` on that computer creates `~/Epicenter`, starts
`epicenter serve` as a login service, and keeps the machine reachable (restart
after power loss, Tailscale). Another computer has nothing to set up.

**`~/Epicenter` lists the apps, and it is the only list.** Each entry is an app
folder or a link to one. Tests and containers that need another place set
`HOME`; there is no `EPICENTER_HOME`.

**SSH is the way in for you and your agents.** You `ssh` to your server and
run `epicenter` there; an agent elsewhere uses `ssh <your server> epicenter
serve --stdio` as its MCP server, which offers every app's actions (ADR-0853).
Each call runs in a fresh `epicenter` process, so code pulled or edited a moment
ago is what runs.

**`epicenter serve` over HTTPS is the way in for everything without a shell.**
Your own devices reach it over your tailnet. Claude.ai and ChatGPT connect from
their vendors' servers, so `serve` also has one public HTTPS address, through
Tailscale Funnel, and signs a client in with OAuth, as MCP requires: adding the
connector opens a page on your server where you approve it with a passkey, and
the client receives a token you can revoke (ADR-0864).

**A command means this computer.** `epicenter vocab define serendipity` runs
the Vocab folder on the computer it is typed on, and never forwards.
`epicenter ./vocab define serendipity` runs the folder at that path, for
developing an app or a folder of one's own. Every write commits itself, and
writes to one app take turns (ADR-0850).

**A sign-in lives where the actions that use it run:** Gmail's in your server's
Keychain, where `epicenter mail connect` runs. Epicenter holds no third-party
credentials (ADR-0864). Keychain access does not stop another program running
as the same user, so the person's agent permission rules are the gate for now.

**There are no schedules.** Your server runs nothing on its own: an action
runs because a person, their agent, or a page they opened asks for it.

## Consequences

- Deleted: schedules, the timer, routing between computers, sign-ins on laptops,
  forwarding over SSH, a meeting point per app, and `EPICENTER_HOME`.
- The CLI stores no address and has one behavior on every computer. Long runs
  report progress through MCP progress notifications.
- While your server is unreachable (a FileVault reboot waits at the unlock
  screen), every named action and every client that asks is down. Whispering
  keeps recording into its own copy and pushes later. Remote FileVault unlock
  over SSH, an administrator's step, is to be tried before the first trip.
- A hosted server, for a person who does not keep a computer on, is not decided
  (ADR-0864).

## Considered alternatives

- **An action runs where it is typed, falling back to your server when a
  sign-in is missing.** A hidden route and one command with two behaviors.
- **The CLI forwards a named action to your server.** One command with two
  meanings by computer, a stored address, and an argv parser that needed each
  action's positionals over MCP; the author always reaches the Studio by `ssh`
  first.
- **A long-running `serve` importing app code once.** Runs stale code after a
  pull or an edit (ADR-0846's objection).
- **Schedules (ADR-0846), or reminders that run what is due when a page opens.**
  Runs nobody asked for, moved from a timer into a screen. Reminders return as an
  ordinary app if a real job needs one.
- **The desktop app or the CLI keeps its own list of apps.** A second list.
- **Running actions in a browser.** Git, LFS, and sign-ins in a browser; a view
  in a browser asks your server instead (ADR-0860).
- **A copy of each app on every device, with your server optional.** Git, a
  merge, and App Review on the phone, for offline use nobody asked for
  (ADR-0864).
