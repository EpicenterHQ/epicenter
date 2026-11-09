# 0846. Epicenter owns no infrastructure, and each repository has one meeting point

- **Status:** Accepted (2026-11-08)
- **Date:** 2026-11-08
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at how the runner is reached: no surface keeps a runner alive between calls, `epicenter mcp` included.
- **Relates:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) (the repository is the sync), [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md) (what an action's run may touch).
- **Unbuilt:** all of it: `epicenter setup`, the front door, `schedules` and `epicenter tick`, `--on <host>`, merging into the box through `merge-tree`, `epicenter sync <app> --from <branch>`, the backup check, and per-call MCP. Before any remote path ships, the secrets experiment below.

## Context

The author's always-on Mac is also their daily machine (a Mac Studio with
FileVault on, `pmset autorestart 0`, no Time Machine destination, no offsite
backup, the Tailscale GUI app). They want the runtime to self-host on macOS,
Linux, and Windows. A long-running runner service was rejected: a process that
lives for days holds imports made hours ago, locks, and caches, and needs a
lifecycle and a reload mechanism for code agents edit all day. An encrypted
GitHub remote with `git-remote-gcrypt` was rejected: over a Git URL it uploads
the whole history on every push, and every push effectively forces. A council
of three reviewers (workflow, mechanics, premises) tested the resulting design
against the author's weeks, measured it, and agreed on what follows.

## Decision

**Epicenter owns the app contract, the runner, the commit rule, and the pages.
The operating system, SSH, Git, and Tailscale supply the rest.** "Your
Epicenter" is the machine that holds the box-placed repositories and runs
unattended actions; for the author, the always-on Mac. "Always on" describes
the machine, not a program.

**Every action is one short process,** on every surface: the terminal, an
agent, a page, a schedule, and `epicenter mcp`, which spawns
`epicenter <app> <action> --json` per tool call and re-reads its tools on each
`tools/list`. Measured on the author's Mac: `bun -e 0` 4 ms, an empty listing
about 66 ms, of which about 30 ms is the MCP SDK, loaded only for `mcp`.

**Five operations; only `run` takes a process and the app's lock.**

| Operation | Does | Needs |
| --- | --- | --- |
| run | an action, then its commit (ADR-0848) | the app's code, its lock, a process |
| read | a file, or `git show HEAD:<path>`; HEAD's sha as the ETag | nothing of the app's code; no lock |
| watch | report new commits | one watch on the branch ref, in the front door |
| due | run schedules that are due | `epicenter tick` from one OS timer each minute; last-run times and refusals in the cache; each due run its own process |
| replicate | fetch and push | Git over SSH |

**The front door** is a small HTTP process the OS keeps running (launchd with
`AbandonProcessGroup`, systemd with `KillMode=process`, Task Scheduler starting
actions with `CREATE_BREAKAWAY_FROM_JOB`), so restarting it never kills a
running action. It spawns runs and streams their output, serves reads, and
watches refs. It answers only requests carrying Tailscale's identity header and
the ts.net Host (or listens on a Unix socket). A request may carry an
idempotency key, checked under the app's lock: written as a commit trailer when
the action commits, kept in the cache only when it commits nothing. `tick` and
the front door try the lock once and answer busy; terminals wait, bounded.

**Placement is per app, and each repository has exactly one meeting point.**
An app whose truth is a provider (Mail and its Gmail) lives only on your
Epicenter, which is its meeting point; other devices reach it through pages,
`ssh home epicenter …`, or an editor over SSH. A hand-written app (the vault,
Vocab) keeps clones for offline work. The vault's meeting point is GitHub, and
your Epicenter is one more clone of it. `epicenter <app>` prints the meeting
point.

**One door into an app's branch on your Epicenter.** Every change to that
branch other than an action's commit or the person's own commit of their hand
edits goes through the same path: a clone's push to `incoming/<device>`, a pull
from a remote meeting point, and deploying code from a worktree branch
(`epicenter sync <app> --from <branch>`). Each runs under the app's lock with
`git merge-tree --write-tree`, moves the branch with a compare-and-swap
`update-ref`, and updates the files only when the merge is clean and does not
overlap the person's uncommitted edits; a conflict is refused and resolved on
the device that made it. The folder that runs actions never holds a merge in
progress. `setup` installs hooks that warn, never block, when the folder changed
another way: a hand `git pull` in the vault is allowed and reported.

**Backup is the machine's, and Epicenter insists on it.** Epicenter performs
none; Time Machine to an encrypted disk and an offsite backup that encrypts
before upload do. The listing and `setup` warn while no backup destination
exists or the last backup is a week old, and the warning cannot be silenced
while there is none. Recordings that exist nowhere else wait for it: Whispering
keeps each recording on the device until your Epicenter confirms its commit,
retries with the recording's id as the idempotency key, and never discards one
it could not deliver; your Epicenter refuses to keep audio until a backup
destination exists. Audio stays outside Git history; the repository holds the
transcript and a reference.

**`epicenter setup` makes a machine your Epicenter.** It makes `~/Epicenter`,
installs the front door and the one-minute timer, enables Remote Login
(OpenSSH) with keys on macOS and Windows (the Tailscale SSH server needs
`tailscaled`, not the GUI app; on Linux it is optional), sets
`pmset autorestart 1` and no sleep on macOS, and puts `epicenter` on the
non-interactive SSH path. `--on home` sends the input as JSON on stdin, so no
remote shell parses it.

**Native apps are clients with capabilities on the device you hold**, and write
only by calling actions.

## The gate before any remote path ships

Store a secret with build N of the compiled binary, then read it over SSH,
from the timer, from a LaunchAgent with the screen locked, and after a rebuild,
on each operating system. If macOS fails, sign the binary with a stable
identity; if headless Windows or Linux fail, keep secrets in a file only the
user can read, on an encrypted disk.

## Considered alternatives

- **A long-running runner service.** Stale imports, a lifecycle, a reload
  mechanism.
- **No clones anywhere (one global default).** Right for Mail; for the vault
  it loses the note written on a plane.
- **The box merges in its working tree.** One conflicting push leaves
  `MERGE_HEAD` and every action for that app refused until someone resolves it
  at the box.
- **Unattended runs import a checkout of HEAD from the cache.** Actions that
  find files relative to their own module would run from the cache while
  writing the folder; refusing uncommitted code (ADR-0848) is simpler.
- **`git-remote-gcrypt` as the everyday remote; a plain private host.** The
  first forces pushes between writers and re-uploads history; the second reads
  everything. A host stays a choice for hand-written apps such as the vault.

## Consequences

- With FileVault on, a reboot is an outage for box-placed apps until someone
  unlocks the Mac. To be measured once with a power-cut test (with
  `autorestart 1`, and macOS 26 unlock over SSH tried), and recorded here.
- Under this placement Git is history and undo for box-placed apps, and
  ADR-0842's sync applies to hand-written apps with clones.
- Every run pays a process start and an app import; reads do not.
