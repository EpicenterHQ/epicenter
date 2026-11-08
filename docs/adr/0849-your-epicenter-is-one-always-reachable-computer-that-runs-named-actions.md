# 0849. Your Epicenter is one always-reachable computer that runs named actions

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md): schedules and `epicenter tick`, the front door and its OS timer, a meeting point per app, the door into a box branch, the backup check, and the secrets experiment.
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at who runs a named action (your Epicenter only), the laptop's own runner (a folder path instead), and the browser runner (refused). [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at discovery: `~/Epicenter` exists on your Epicenter, and another computer lists your Epicenter's apps.
- **Relates:** [ADR-0850](0850-an-action-commits-exactly-the-files-it-wrote-wherever-it-runs.md) (the commit rule), [ADR-0851](0851-each-app-has-one-git-remote-its-meeting-point-and-backup.md) (the remote), [ADR-0852](0852-epicenter-is-one-contract-and-four-open-slots.md) (the slots), [ADR-0853](0853-collections-give-an-app-its-reading-actions-and-screens-are-clients.md) (screens).
- **Unbuilt:** all of it: `epicenter setup`, forwarding over SSH, `epicenter serve`.

## Context

The author has one always-on Mac, which is also their daily machine, plus a
laptop, a phone, and agents. Three rounds of review traced every hard case to
runs nobody started (schedules) and to one app's actions running in several
places. The author dropped schedules and chose to keep the Mac reachable rather
than design for its absence. A greenfield review then showed that letting an
action run wherever it was typed, with a hidden fallback to the Mac, gave one
command two behaviors.

## Decision

**Your Epicenter is one computer the person keeps reachable.** The author's Mac
now; an Epicenter Cloud container for anyone who cannot keep one on. Epicenter
assumes it is reachable: when it is not, a named action fails and says so, and
nothing else is designed around its absence. `epicenter setup` asks one question,
whether this computer is your Epicenter or connects to one. "This one" creates
`~/Epicenter`, starts `epicenter serve`, and keeps the machine reachable (restart
after power loss, Remote Login, `epicenter` on the non-interactive SSH path,
Tailscale). "Connect" stores your Epicenter's address, the only state another
computer keeps.

**`~/Epicenter` lists the apps, and it is the only list.** Each entry is an app
folder or a link to one (`~/Epicenter/vault → ~/Code/vault`); `EPICENTER_HOME`
moves it. The CLI, MCP, `serve`, and the desktop app all read it, and adding an
app anywhere means making an entry.

**How a command is written decides where it runs.**

```txt
epicenter vocab add serendipity …      on your Epicenter
ssh <your Epicenter> epicenter mcp     an agent elsewhere gets every action
epicenter ./vocab add serendipity …    here, in that folder
```

A named action runs on your Epicenter; on any other computer the CLI forwards it
there, over SSH to a machine of the person's own or over HTTP to an Epicenter
Cloud container. A folder path runs in that folder, on this computer, for developing an
app, working offline, or a folder of one's own. Both follow the same commit rule
(ADR-0850). Runs of one app on one computer take turns.

**`epicenter serve` offers HTTP and MCP**, over Tailscale, for the folders in
`~/Epicenter` or for a folder it is given.

**Sign-ins live on your Epicenter.** `epicenter mail connect` runs there.

**There are no schedules.** Nothing runs unless a person or their agent asks.

## Consequences

- Deleted: schedules, the timer, routing between computers, sign-ins on laptops,
  an HTTP server for agents (SSH carries MCP), and a meeting point per app.
- While your Epicenter is unreachable (a FileVault reboot waits at the unlock
  screen), every named action is down; folder paths and editing still work.
  Remote FileVault unlock over SSH is to be tried before the first trip.
- Claude on the phone reaches `serve` only through a public address (Tailscale
  Funnel or a relay) with a sign-in; that comes later.

## Considered alternatives

- **An action runs where it is typed, falling back to your Epicenter when a
  sign-in is missing.** A hidden route and one command with two behaviors.
- **Schedules (ADR-0846).** Most hard cases came from runs nobody started; they
  return when a real job needs one.
- **The desktop app or the CLI keeps its own list of apps.** A second list that
  can drift from the folder.
- **A runner in the browser or on the phone.** Nothing needs one.
