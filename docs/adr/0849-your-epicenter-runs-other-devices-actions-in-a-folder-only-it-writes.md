# 0849. Your Epicenter runs other devices' actions in a folder only it writes

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md) (schedules and `epicenter tick`, the front door and the OS timer, a meeting point per app, the door into a box branch, the backup check, the secrets experiment) and [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md) (recorded writes, hashes, run phases, undo of an action's own paths).
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at where an action commits: only in your Epicenter's own folder; in a person's copy an action's writes are that person's edits. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at the browser runner, which is refused, and at what Epicenter Cloud is.
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (the app contract, unchanged), [ADR-0847](0847-an-app-brings-its-providers-credentials-with-a-default-in-its-code.md) (an app's provider credentials).
- **Unbuilt:** all of it. `packages/cli/src/run.ts` commits in whatever folder an action runs in and undoes that folder's changed paths when the action throws; `epicenter serve` does not exist.

## Context

The author has one always-on Mac, which is also their daily machine, plus a
laptop, a phone, and agents that edit app code all day. ADR-0842 committed every
action in the folder it ran in. ADR-0846 added schedules, a front door, an OS
timer, and a meeting point per app; ADR-0848 patched what concurrent edits did to
the commit. Three rounds of review, the last starting from ten concrete scenes
and none of the earlier proposals, found every hole in the same two places: code
writing a folder a person or agent was editing, and one app's actions running
unattended in more than one place. The author then dropped schedules: every run
is started by a person or their agent.

## Decision

**Your Epicenter is one always-on computer.** The author's Mac now; Epicenter
Cloud later, for people without one. It holds the apps' sign-ins, is every app's
meeting point (devices pull from it and push to it), and runs `epicenter serve`,
which answers the phone, pages, and remote agents (HTTP and MCP, over
Tailscale).

**It keeps each app in a folder only Epicenter writes.** An action asked for
from another device runs there, one at a time per app, on the latest commit.
When it returns, Epicenter commits every change, named for the action; when it
throws, Epicenter discards the changes. Both are safe because nothing else
writes that folder. A push from a device is accepted only as a fast-forward and
lands between runs.

**Every other folder of an app is a copy, and a copy is yours.** `~/Code/vault`,
`~/Epicenter/mail` on the Mac, and an agent's worktree are Git clones a person or
agent edits. An action run in a copy behaves like a script: its writes become
uncommitted edits when `run` returns, and none happen when it throws. Epicenter
never commits in a copy.

**An action runs where it is asked, unless that computer lacks what it needs.**
The phone sends every action to your Epicenter. A laptop runs an action itself,
and sends it to your Epicenter when it needs a sign-in the laptop does not hold;
`--remote` sends it there on purpose. Actions declare nothing about where they
run.

**A sign-in lives on the computer that set it up.** `epicenter mail connect` on
your Epicenter puts Gmail's there. Actions use it through `secrets` (ADR-0841).

**Backup is a second Git remote.** Your Epicenter pushes to it after every
commit it makes and every push it accepts: a private GitHub repository now,
Epicenter Cloud (a repository on Cloudflare Artifacts) later. A cloud agent that
cannot reach your Epicenter pushes a branch there, and a person merges it from a
copy. The people who can read an app are whoever holds a copy, your Epicenter,
and the backup host; Epicenter builds no encryption.

**There are no schedules.** Nothing runs unless a person or their agent asks.

The app contract is unchanged: `defineApp` with actions (name, description,
typed input, `run`) receiving `folder`, `cache`, and `secrets`.

## Consequences

- `run.ts`'s commit and discard move to your Epicenter's own folder, where they
  are correct; in a copy the CLI stops committing and applies an action's writes
  only when it returns.
- An action that needs no sign-in runs offline on a laptop, and can read the
  page being edited there.
- On the Mac, a remote action's result reaches `~/Epicenter/<app>` when that copy
  pulls.
- While your Epicenter is down (a FileVault reboot waits at the unlock screen),
  the phone's and remote requests wait; copies keep working and push later.
- Epicenter Cloud is a hosted Epicenter: `epicenter serve` in a container, its
  folders' meeting point on Cloudflare Artifacts.

## Considered alternatives

- **Commit in every folder an action runs in (ADR-0842, ADR-0848).** Each scheme
  left a hole when a person or agent edited the same folder.
- **Every action runs only on your Epicenter.** Loses offline actions and actions
  on a page being edited.
- **Schedules (ADR-0846).** Most hard cases came from runs nobody started; they
  return when a real job needs one.
- **A meeting point per app, such as GitHub for the vault (ADR-0846).** One
  meeting point is simpler; GitHub becomes the backup.
- **End-to-end encrypted hosting.** Key management, and no hosted runs.
- **A runner in the browser.** Nothing needs it.
