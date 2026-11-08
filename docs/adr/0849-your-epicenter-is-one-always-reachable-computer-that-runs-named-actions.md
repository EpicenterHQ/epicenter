# 0849. Your Epicenter is one always-reachable computer that runs named actions

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md): schedules and `epicenter tick`, the front door and its OS timer, a meeting point per app, the door into a box branch, the backup check, and the secrets experiment.
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at who runs a named action (your Epicenter only), the laptop's own runner (a folder path instead), and the browser runner (refused). [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at discovery: `~/Epicenter` exists on your Epicenter, and another computer lists your Epicenter's apps.
- **Relates:** [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md) (the commit rule), [ADR-0851](0851-each-app-has-one-git-remote-its-meeting-point-and-backup.md) (the remote), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (the five nouns), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP and programs that ask), [ADR-0855](0855-reminders-are-an-app-and-a-screen-runs-what-is-due-when-it-opens.md) (reminders).
- **Unbuilt:** all of it: `epicenter setup`, forwarding to `serve`, `epicenter serve`.

## Context

The author has one always-on Mac, which is also their daily machine, plus a
laptop, a phone, and agents. Three rounds of review traced every hard case to
runs nobody started (schedules) and to one app's actions running in several
places. The author dropped schedules and chose to keep the Mac reachable rather
than design for its absence. A greenfield review then showed that letting an
action run wherever it was typed, with a hidden fallback to the Mac, gave one
command two behaviors. A later pass found two ways into your Epicenter, SSH for
the CLI and agents and `epicenter serve` for screens, where screens already
required `serve` and the CLI already forwarded to Epicenter Cloud over HTTP.

## Decision

**Your Epicenter is one computer the person keeps reachable.** The author's Mac
now; an Epicenter Cloud container for anyone who cannot keep one on. Epicenter
assumes it is reachable: when it is not, a named action fails and says so, and
nothing else is designed around its absence. `epicenter setup` asks one
question, whether this computer is your Epicenter or connects to one. "This one"
creates `~/Epicenter`, starts `epicenter serve` as a login service, and keeps the
machine reachable (restart after power loss, Tailscale). "Connect" stores your
Epicenter's address, the only state another computer keeps.

**`~/Epicenter` lists the apps, and it is the only list.** Each entry is an app
folder or a link to one (`~/Epicenter/vault → ~/Code/vault`); `EPICENTER_HOME`
moves it. The CLI, MCP, `serve`, and the desktop app all read it, and adding an
app anywhere means making an entry.

**`epicenter serve` is the only way in.** It offers every app's actions over
MCP (ADR-0853). On another computer the CLI forwards a named action to it as a
tool call, printing the result and returning the exit code; Claude elsewhere
connects to its address; the Epicenter app and other pages call it. Your own Mac and an Epicenter Cloud container differ
only in address. On a person's own computer `serve` listens only on their
tailnet, so only their devices reach it; on Epicenter Cloud the person's
Epicenter account signs them in.

**How a command is written decides where it runs.**

```txt
epicenter vocab add serendipity …      on your Epicenter, sent to serve from anywhere else
{ "type": "http",                      Claude on another computer gets every action
  "url": "https://<your Epicenter>/mcp" }
epicenter ./vocab add serendipity …    here, in that folder
```

A folder path runs in that folder, on this computer, for developing an app,
working offline, or a folder of one's own. Both follow the same commit rule
(ADR-0850). Runs of one app on one computer take turns. On your Epicenter
itself, Claude can also use `epicenter serve --stdio`.

**Sign-ins live on your Epicenter.** `epicenter mail connect` runs there.

**There are no schedules.** Your Epicenter runs nothing on its own: an action
runs because a person, their agent, or a page they opened asks for it. Reminders
are an app (ADR-0855).

## Consequences

- Deleted: schedules, the timer, routing between computers, sign-ins on laptops,
  forwarding over SSH, Remote Login and `epicenter` on SSH's path as setup
  steps, and a meeting point per app.
- The CLI's forwarding maps an MCP result to its output and exit code, and an
  interruption to a cancelled request, which SSH gave for free.
- While your Epicenter is unreachable (a FileVault reboot waits at the unlock
  screen), every named action is down; folder paths and editing still work.
  Remote FileVault unlock over SSH, an administrator's step outside Epicenter,
  is to be tried before the first trip.
- Claude on the phone reaches `serve` only through a public address (Tailscale
  Funnel or a relay) with a sign-in; that comes later.

## Considered alternatives

- **An action runs where it is typed, falling back to your Epicenter when a
  sign-in is missing.** A hidden route and one command with two behaviors.
- **SSH for the CLI and agents beside `serve` for screens.** Two ways in, two
  ways for the CLI to forward (SSH to one's own machine, HTTP to Epicenter
  Cloud), and setup steps only one of them needs.
- **Schedules (ADR-0846).** Most hard cases came from runs nobody started.
- **The desktop app or the CLI keeps its own list of apps.** A second list that
  can drift from the folder.
- **Running actions in the browser or on the phone.** Nothing needs it.
