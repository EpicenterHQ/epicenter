# 0849. Your Epicenter is one always-reachable computer that runs named actions

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md): schedules and `epicenter tick`, the front door and its OS timer, a meeting point per app, the door into a box branch, the backup check, and the secrets experiment.
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at who runs a named action (your Epicenter only), the laptop's own runner (a folder path instead), and the browser runner (refused). [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at discovery: `~/Epicenter` exists on your Epicenter and is not moved by an environment variable, and another computer lists your Epicenter's apps.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (the commit rule), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (the remote), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder or ask), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP).
- **Unbuilt:** `epicenter setup`, forwarding to `serve`, and `epicenter serve` over HTTP. Built: `epicenter serve --stdio`, which replaced `epicenter mcp`, and the home at `$HOME/Epicenter` with `EPICENTER_HOME` removed.

## Context

The author has one always-on Mac, which is also their daily machine, plus a
laptop, a phone, and agents. Three rounds of review traced every hard case to
runs nobody started (schedules) and to one app's actions running in several
places. The author dropped schedules and chose to keep the Mac reachable rather
than design for its absence. A later pass found two ways in (SSH for the CLI and
agents, `serve` for screens) where the CLI already forwarded to Epicenter Cloud
over HTTP. Claude's custom connectors, in every Claude client, and ChatGPT's
connect to an MCP server from their vendor's cloud and need a public HTTPS
address (checked 2026-11-08).

## Decision

**Your Epicenter is one computer the person keeps reachable.** The author's Mac
now; an Epicenter Cloud container for anyone who cannot keep one on. When it is
not reachable, a named action fails and says so, and nothing else is designed
around its absence. `epicenter setup` asks whether this computer is your
Epicenter or connects to one. "This one" creates `~/Epicenter`, starts
`epicenter serve` as a login service, and keeps the machine reachable (restart
after power loss, Tailscale). "Connect" stores your Epicenter's address, the only
state another computer keeps.

**`~/Epicenter` lists the apps, and it is the only list.** Each entry is an app
folder or a link to one. Tests and containers that need another place set
`HOME`; there is no `EPICENTER_HOME`.

**`epicenter serve` is the only way in.** It offers every app's actions over MCP
(ADR-0853), on the tailnet. Each call runs in a fresh `epicenter` process, so
code pulled or edited a moment ago is what runs. On another computer the CLI
forwards a named action to it as a tool call, printing the result and returning
the exit code; Claude Code connects to its address; Claude Desktop runs
`epicenter serve --stdio` locally, which forwards named actions the same way.

**How a command is written decides where it runs.**

```txt
epicenter vocab define serendipity     on your Epicenter, forwarded from anywhere else
epicenter ./vocab define serendipity   here, in that folder
```

A folder path runs in that folder, on this computer, for developing an app,
working offline, or a folder of one's own. Both follow the same rule: a run
commits only when its action calls `folder.commit` (ADR-0850), and runs do not
take turns.

**Sign-ins live on your Epicenter.** `epicenter mail connect` runs there.
Keychain access does not stop another program running as the same user, so the
person's agent permission rules are the gate for now.

**There are no schedules.** Your Epicenter runs nothing on its own: an action
runs because a person, their agent, or a page they opened asks for it.

**Reach from the phone and claude.ai is not built.** Claude and ChatGPT on the
phone, and claude.ai in a browser, need `serve` at a public HTTPS address with a
sign-in. That comes, with a per-action allow-or-ask policy enforced by `serve`,
when the author wants an app on the phone; until then those surfaces do not
reach apps.

## Consequences

- Deleted: schedules, the timer, routing between computers, sign-ins on laptops,
  forwarding over SSH, a meeting point per app, and `EPICENTER_HOME`.
- The CLI's forwarding maps an MCP result to its output and exit code, and an
  interruption to a cancelled request. Long runs report progress through MCP
  progress notifications.
- While your Epicenter is unreachable (a FileVault reboot waits at the unlock
  screen), every named action is down; folder paths and editing still work.
  Remote FileVault unlock over SSH, an administrator's step, is to be tried
  before the first trip.

## Considered alternatives

- **An action runs where it is typed, falling back to your Epicenter when a
  sign-in is missing.** A hidden route and one command with two behaviors.
- **SSH for the CLI and agents beside `serve` for screens.** Two ways in, and two
  ways for the CLI to forward.
- **A long-running `serve` importing app code once.** Runs stale code after a
  pull or an edit (ADR-0846's objection).
- **Schedules (ADR-0846), or reminders that run what is due when a page opens.**
  Runs nobody asked for, moved from a timer into a screen. Reminders return as an
  ordinary app if a real job needs one.
- **The desktop app or the CLI keeps its own list of apps.** A second list.
- **Running actions in the browser or on the phone.** Nothing needs it.
