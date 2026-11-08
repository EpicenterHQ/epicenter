# 0852. An app is a folder with a declared shape, and each job takes the least powerful form

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at Epicenter Cloud, which hosts a remote and a computer rather than being a separate product. [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at `epicenter add`, which also links a folder, at `epicenter new`, which becomes `add` from a built-in template, and at the `{ from, sha }` record, which the `upstream` branch already holds.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (your Epicenter), [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md) (the commit rule), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (`origin`), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (collections and programs), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (binary files), [ADR-0857](0857-an-apps-declaration-is-plain-data-in-epicenter-json-or-epicenter-ts.md) (the declaration).
- **Unbuilt:** the registry, the built-in template as a source, `add` linking a folder and offering history, and Epicenter Cloud.

## Context

Earlier drafts named categories that did not hold: four "slots", "verbs" beside
actions, a "runner" that meant four things, "standalone apps", and "general
programs" beside "programs made for one app". Each time, the fix was to choose
less machinery for the same job, and the decisions since (ADR-0849 to ADR-0857)
turned out to be one move applied to different jobs.

## Decision

**Each job takes the least powerful form that does it.** This is the rule of
least power: choose the least powerful language or mechanism suitable for a
purpose, as the web keeps documents as data and scripts as an optional step up.

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare an app | `epicenter.json`, data that cannot run (ADR-0857) | the app has code: `epicenter.ts` |
| Change data | edit a file | it needs a rule, a sign-in, or reach: an action |
| An action | a collection's `list`, `show`, `save`, `delete` (ADR-0853) | it needs logic: one the author writes |
| Two programs sharing data | share the folder | never: programs do not call each other |
| Move data between computers | Git (ADR-0851) | never: no sync engine |
| Run something later | run it when someone opens a screen (ADR-0855) | never: no scheduler |
| Big files | a line in `.gitattributes` (ADR-0856) | never: no Epicenter setting for them |
| Reach from anywhere | an existing protocol, MCP (ADR-0853) | never: no Epicenter API |
| Where code runs | a program on the device | it needs sign-ins or reach: an action on your Epicenter |

A proposal is reviewed by asking whether a less powerful form does the same job.
Two bends are deliberate. An app with code keeps its declaration inside
`epicenter.ts`, beside its code, rather than in a second file (ADR-0857). Your
Epicenter is a computer that is always on, because a phone and Claude anywhere
need something to answer them.

**Epicenter has five nouns.**

| Noun | What it is |
| --- | --- |
| an app | a folder whose `epicenter.json` or `epicenter.ts` declares its shape: its collections and actions |
| an action | something a person or program can ask an app to do. Each collection gives four; the author writes the rest |
| `epicenter` | the program that runs an action in a folder: it checks the input, runs it, makes one commit or nothing (ADR-0850), and pushes. `epicenter serve` is the same program at an address |
| your Epicenter | the computer where `epicenter serve` always runs and the person's sign-ins live (ADR-0849) |
| Git | commits, `origin`, `upstream`, `.gitignore` (so `.cache/`, ADR-0854), and LFS (ADR-0856) |

Everything else is a program: a person's editor, Claude, the Epicenter app,
Whispering. Reminders, templates, and the registry are apps and Git URLs.

**An app belongs to Epicenter by its shape, not its runtime, and code goes where
what it needs is.** Code that needs the device (a microphone, a global shortcut,
pasting into another program) lives in a program on that device. Code that needs
the person's sign-ins, or must be reachable from anywhere, is an action run on
your Epicenter. A plain record change needs no code: it is a collection's action
or an edit. Every app has the same shape with different parts filled in: Mail
has actions and no program of its own; Whispering has a program and no actions;
Vocab may have both.

**Every app climbs one ladder, and each rung is optional.**

| Rung | What the person adds | What every app gains |
| --- | --- | --- |
| 1. Files | nothing: a folder in `~/Epicenter` with a declared shape | any program reads and writes it |
| 2. History | Git, `git-lfs`, an `origin` | backup, history, copies elsewhere; programs commit what they write |
| 3. Actions | `epicenter` on this computer | the four collection actions and the app's own, in the terminal and for Claude here |
| 4. Reach | your Epicenter, always serving | the same actions from the phone and Claude anywhere, with sign-ins |

Apps differ in how high they must climb to be useful, not in kind. Whispering is
whole at rung 1; Mail needs rung 4, because its code needs a sign-in on an
always-on computer.

**A program has the folder or asks.** With the folder, it writes files and
commits exactly what it wrote. Without it, or when it needs a sign-in or an
app's rule, it asks for an action over MCP. Programs never call each other: two
programs sharing an app meet at its folder, and each brings what only it can.
No program changes how it writes because another program is installed.

**`epicenter add` makes something one of your apps.** From a Git URL it copies
the app's files into a new repository and keeps the source as its `upstream`
branch, which records where it came from and at which commit (ADR-0841). From a
folder it links the folder into `~/Epicenter`, and, if the folder is not yet a
Git repository, offers to make one, committing what is there as its first
commit. The `epicenter` listing shows each app's next missing rung until it is
taken. `epicenter new <name>` is `add` from a built-in template: an
`epicenter.json` with its `$schema`, a `.gitignore` with `node_modules/` and
`.cache/`, and a `.gitattributes` (ADR-0856).

**Epicenter provides defaults, each an ordinary instance of an open standard.**
The registry is a list of Git URLs. Epicenter Cloud hosts an app's `origin` (a
repository on Cloudflare Artifacts, with LFS from the Epicenter API) and can be
your Epicenter (a container running the same `epicenter serve`). The Epicenter
app is a program that asks over MCP. A person who takes every default installs
the Epicenter app, signs in, and never sees Git; a developer uses any Git host,
their own computer, or their own program without changing an app.

## Consequences

- The vault joins with `epicenter add ~/Code/vault` instead of a hand-made link.
- An app works in every program that asks over MCP once it is added.
- Leaving a default is changing `origin` or running `epicenter setup` on one's
  own computer.

## Considered alternatives

- **One contract and four slots (this record's earliest draft).** A category for
  swappable pieces that were not one kind of thing.
- **"Verb" for every action, and "action" for the hand-written ones.** Two words
  for one thing a program sees.
- **Programs only ask for actions, never write files.** A program that writes
  only its own new files would ship `epicenter` (about 70 MB, measured) or depend
  on it, to run three Git commands.
- **A program that writes files until `epicenter` is installed, then asks.** Two
  write paths in every program, and behavior that depends on what else is
  installed.
- **Apps ship their interface in the folder, and the Epicenter app hosts it.**
  Removes programs made for one app, but rebuilds the platform layer the earlier
  Mail died of, and makes Epicenter a gate no app can work without.
- **Actions as WebAssembly, run by a CLI rewritten in Rust.** Sandboxing by
  permission and actions that run anywhere, at the cost of a build step, most of
  npm, and Claude's edit-and-run loop. Deferred until apps from strangers run
  with a person's sign-ins.
- **A Rust core for collections, Git, and MCP.** None of those need JavaScript
  once declarations are data (ADR-0857), so a small core could serve data-only
  apps and be linked into other programs. Deferred until a second program wants
  to embed it.
- **Epicenter Cloud as its own product with its own sync.** A second
  implementation of the remote and of your Epicenter.
