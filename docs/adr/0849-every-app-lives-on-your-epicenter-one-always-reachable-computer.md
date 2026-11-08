# 0849. Every app lives on your Epicenter, one always-reachable computer

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md) (schedules and `epicenter tick`, the front door and the OS timer, a meeting point per app, the door into a box branch, the backup check, the secrets experiment) and [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md) (recorded writes, hashes, run phases, undo of an action's own paths).
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at where an action commits: only in `~/Epicenter` on your Epicenter; anywhere else an action's writes are the person's edits. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at who runs a named action (your Epicenter only), what the hub is (a window onto `epicenter serve`), the browser runner (refused), and Epicenter Cloud (a hosted Epicenter). [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at discovery: `~/Epicenter` holds the apps themselves on your Epicenter, and another computer lists your Epicenter's apps.
- **Relates:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) (collections: the declared data layout), [ADR-0847](0847-an-app-brings-its-providers-credentials-with-a-default-in-its-code.md) (an app's provider credentials).
- **Unbuilt:** all of it. `packages/cli/src/run.ts` commits in whatever folder an action runs in and undoes changed paths when the action throws; `epicenter serve` and forwarding over SSH do not exist; the vault is linked into `~/Epicenter`, not kept there.

## Context

The author has one always-on Mac, which is also their daily machine, plus a
laptop, a phone, and agents that edit app code all day. ADR-0842 committed every
action in the folder it ran in; ADR-0846 added schedules, a front door, an OS
timer, and a meeting point per app; ADR-0848 patched what concurrent edits did to
the commit. Three rounds of review found every hole in two places: code writing
a folder a person or agent was editing, and one app's actions running in more
than one place. The author then dropped schedules, chose to keep the Mac
reachable at all times rather than design for its absence, and moved the vault
onto it. A greenfield review of an intermediate draft showed that letting an
action run wherever it was typed, with a hidden fallback to the Mac, gave one
command two behaviors and left Mail's batch workflow nowhere to happen.

## Decision

**Your Epicenter is one computer the person keeps reachable.** The author's Mac
now; Epicenter Cloud for people who cannot keep one on. Epicenter assumes it is
reachable and does not design around its absence: when it is not, a named action
fails and says so, while editing and runs in a folder still work. `epicenter
setup` keeps it reachable (restart after power loss, Remote Login, `epicenter`
on the non-interactive SSH path, Tailscale).

**Every app lives there**, in `~/Epicenter/<app>`: one Git repository of its code
and its data, the vault included. Only actions and deploys write these folders.
Nobody hand-edits them, on the Mac included.

**A named action runs on your Epicenter, from anywhere.** `epicenter <app>
<action>` runs there directly, and on any other computer forwards over SSH
(`ssh <your Epicenter> epicenter …`); an agent elsewhere adds `ssh <your
Epicenter> epicenter mcp` as its MCP server. Runs of one app take turns on the
latest commit. When an action returns, Epicenter commits every change, named for
the action; when it throws, Epicenter discards the changes. Then it pushes to the
backup.

**A folder path runs here.** `epicenter ./<folder> <action>` runs an action in
that folder like a script: its writes stay as uncommitted edits, and nothing
commits. It is for developing an app, working offline, or a folder of one's own.

**Every other folder is a copy.** A Git clone a person or agent edits: the vault
in Obsidian on the laptop or the Mac, an agent's worktree for an app's code.
Copies pull from and push to your Epicenter. A push is a deploy, accepted as a
fast-forward between runs.

**`epicenter serve` is the one surface for screens.** It serves a folder's actions
as pages, HTTP, and MCP. On your Epicenter it serves every app to the phone and
the desktop over Tailscale; the desktop app is a window onto that address. On
any computer, `epicenter serve ./<folder>` serves that folder with a folder
path's rules.

**Sign-ins live on your Epicenter.** `epicenter mail connect` runs there; actions
use the sign-in through `secrets`.

**Backup is a second Git remote.** Your Epicenter pushes every change to it: a
private GitHub repository now, Epicenter Cloud (Cloudflare Artifacts) later.
Whoever holds a copy, your Epicenter, and the backup host can read an app;
Epicenter builds no encryption.

**A standalone app needs no Epicenter runtime.** It calls an app's actions on
your Epicenter, or writes the app's declared files (its collections) in a copy
and pushes them.

**There are no schedules.** Nothing runs unless a person or their agent asks.

The app contract is unchanged: `defineApp` with actions (name, description,
typed input, `run`) receiving `folder`, `cache`, and `secrets`.

## Consequences

- Deleted: routing between computers and `--remote`, sign-ins on laptops,
  clones of Mail and Vocab on every device, a meeting point per app, an HTTP
  server for agents (SSH carries MCP), and a runtime inside the desktop app.
- `run.ts`'s commit and discard become correct by moving to `~/Epicenter` on your
  Epicenter; everywhere else the CLI stops committing.
- While your Epicenter is unreachable (a FileVault reboot waits at the unlock
  screen), every named action is down. Remote FileVault unlock over SSH is to be
  checked before the first trip.
- The vault exists twice on the Mac: in `~/Epicenter/vault`, which actions write,
  and in the clone the person edits.
- Claude on the phone reaches `serve` only through a public address (Tailscale
  Funnel or a relay) with a sign-in; that comes after the phone's pages.

## Considered alternatives

- **An action runs where it is typed, falling back to your Epicenter when a
  sign-in is missing** (this record's first draft). A hidden route, one command
  with two behaviors, and Mail's batch written where no one can edit it.
- **Commit in every folder an action runs in (ADR-0842, ADR-0848).** Each scheme
  left a hole when a person or agent edited the same folder.
- **Schedules (ADR-0846).** Most hard cases came from runs nobody started.
- **The vault keeps GitHub as its meeting point.** Two meeting points; under the
  reachability rule one place is simpler, and GitHub becomes the backup.
- **Bundle Epicenter in standalone apps.** The file layout and the actions are
  the interface; a bundled runtime would be a second writer.
- **End-to-end encrypted hosting; a runner in the browser.** Key management and
  no hosted runs; nothing needs a browser runner.
