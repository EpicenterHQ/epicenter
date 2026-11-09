# 0844. One runner runs anywhere, and every surface is a view over it

- **Status:** Accepted (2026-11-08)
- **Date:** 2026-11-08
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (the app contract and its context), [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) (an action is a commit; Epicenter Cloud), [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) (what the hub's data view reads).
- **Amended by:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md): no surface keeps a runner alive between calls; `serve` is a front door that runs each request as one process, and schedules run from one OS timer.
- **Spec:** [specs/20261107T222922-epicenter-is-where-personal-software-lives.md](../../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
- **Unbuilt:** `epicenter serve`; the CLI as a client of a runner on another computer; the cache root and a secrets fallback for Linux and Windows (the CLI uses `~/Library/Caches` and `Bun.secrets` today); the hub; Epicenter Cloud.

## Context

Epicenter's pieces are an app's data (a Git repository of readable files), its
code (TypeScript actions), something that runs the actions, and the ways a
person or an agent reaches them: a terminal, an agent's tools, pages on a
desktop or a phone. The data already replicates anywhere through Git, and
`@epicenter/app` already runs in any JavaScript host that can supply a folder.
What remained open was where actions run and how each way of reaching them
relates to the others. The author has an always-on Mac and wants the runtime to
self-host on macOS, Linux, and Windows; agents that work around the clock need
somewhere that is always up.

## Decision

**There is one runner, and where it runs is a deployment detail.** The runner
imports apps, runs an action with its context, and commits what it changed
(ADR-0842). It runs on a laptop, on the person's always-on box, or on Epicenter
Cloud, and it is the same code on each.

**Every surface is a view over the runner.** Nothing else writes an app's data,
except the person editing files by hand.

| Surface | What it is |
| --- | --- |
| `epicenter <app> <action>` | the runner on this computer, or a client of one elsewhere |
| `epicenter mcp` | the same actions as an agent's tools |
| `epicenter serve` | the same actions over HTTP, and the pages that call them |
| the hub | a desktop window around `serve`: an action view and a data view |
| the phone | the hub's pages, opened from the box over Tailscale |

A page never writes files and never writes through native bindings; it calls
actions. Native code (Rust in a Tauri window) exists only for capabilities a
page cannot have, such as recording or a global shortcut.

**The hub is the person's side of the same two things an agent has.** Its
action view is a command palette: choose an action, fill the form its fields
give, run it. Its data view browses an app's folder, as files, or through the
collections the app declares (ADR-0845) as tables and forms. An edit made in
the data view is the person's edit, and the hub commits it when it is saved,
named for the file.

**The desktop bundles the runner once.** The hub is a Tauri shell that starts
`epicenter serve` as a sidecar and opens apps' pages in windows. A
standalone-feeling app is a launcher that opens its page in the hub, not a
second copy of the runner.

**Each host supplies the context its own way.** The contract never requires
Bun or a particular operating system; an action that uses `folder.path`,
`cache.sqlite`, or `secrets` runs only where the host provides them.

| | macOS | Linux | Windows | browser (later) | test |
| --- | --- | --- | --- | --- | --- |
| `folder` | disk | disk | disk | OPFS and Git in WebAssembly | memory |
| `cache` root | `~/Library/Caches/so.epicenter.apps` | `$XDG_CACHE_HOME`, else `~/.cache`, `/so.epicenter.apps` | `%LOCALAPPDATA%\so.epicenter.apps` | OPFS | memory |
| `secrets` | Keychain | libsecret when a secret service runs, else an encrypted file | Credential Manager | none | memory |

**The always-on box is the primary runner.** It runs `epicenter serve`, runs
`epicenter sync` and scheduled actions, holds the warm caches and the
sign-ins, and is where agents work around the clock. A laptop keeps clones and
its own runner for working offline; with the box reachable, the laptop's CLI may
send actions to the box instead.

**Epicenter Cloud is a hosted box.** The three stores map onto it exactly: an
app's repository on Cloudflare Artifacts, its cache on a Cloudflare Container's
disk (thrown away when the container sleeps, rebuilt when it wakes, which is
why a cache is never migrated), and its secrets in a per-person store. It runs
the same runner and the same apps; a person chooses their box or Epicenter's.

## Considered alternatives

- **Every app bundles its own runner.** Simple to ship one app, but each copy
  costs the runtime's size, and two runners on one computer are two writers of
  the same repositories.
- **Pages write through Tauri bindings to the files directly.** Fast and
  offline, but a second write path that skips the commit, and nothing a phone
  or a browser could use.
- **A runner on the phone.** iOS runs no Bun and spawns no processes, and its
  rules forbid running code the app did not ship. The phone reaches the box;
  if a browser runner arrives (OPFS, Git in WebAssembly), it can hold one later
  without changing an app.
- **The desktop app keeps its own list of projects.** Two registries to agree.
  The home stays the only one: adding a project in the hub makes the link
  `~/Epicenter/<name>`, and forgetting it removes the link.

## Consequences

- `epicenter serve` comes early: the hub, the phone, and the box all need it.
- The context gains host implementations rather than new concepts. When a
  runner other than Bun appears, `cache.sqlite` returns a small interface both
  SQLite builds satisfy instead of Bun's own `Database`.
- The box holds data in the clear while it computes on it; disk encryption
  covers a machine that is lost. A hosted runner that cannot read the data needs
  confidential computing, which is not a dependency.
