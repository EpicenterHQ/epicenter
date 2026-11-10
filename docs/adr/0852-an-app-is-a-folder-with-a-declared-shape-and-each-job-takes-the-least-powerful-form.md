# 0852. An app is a folder with a declared shape, and each job takes the least powerful form

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at Epicenter Cloud, which hosts a remote and a computer rather than being a separate product. [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at `epicenter add`, which also links a folder, at `epicenter new`, which becomes `add` from a built-in template, and at the `{ from, sha }` record, which the `upstream` branch already holds.
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (the commit rule), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (`origin`), [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (MCP), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (binary files), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0857](0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md) (the declaration), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, no catalog). [docs/vision.md](../vision.md) explains the whole.
- **Built:** `new` as the built-in template; `epicenter link <folder> [<name>]` (`packages/cli/src/new.ts`); `epicenter install` for code from a source, which replaced `add <git url>` and gives way to `new --from` and `update` (ADR-0866).

## Context

Earlier drafts named categories that did not hold (four "slots", "verbs" beside
actions, a "runner" that meant four things, "standalone apps") and mechanisms that
did not earn their place (schedules, a sync engine, an action as a transaction).
Each repair chose less machinery for the same job. An independent review of
three reviewers, run before anything was built, found the same pattern in what
remained and agreed on the result recorded across ADR-0849 to ADR-0857.

## Decision

**Each job takes the least powerful form that does it.** This is the rule of
least power: choose the least powerful language or mechanism suitable for a
purpose. A proposal is reviewed by asking whether a less powerful form does the
same job.

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare an app | `epicenter.json`, data that cannot run (ADR-0857) | it has code: `epicenter.ts` |
| Describe a field | JSON Schema, an existing standard (ADR-0857) | never: no schema language of Epicenter's own |
| Change data | edit a file and commit it | it needs a rule, a sign-in, or reach: an action |
| An action | a collection's `list`, `get`, `set`, `delete` (ADR-0853) | it needs logic: one the author writes |
| Record what an action did | its own files, and a commit by whoever knows the intent (ADR-0850) | never: no transactions or run log |
| Two programs sharing data | share the folder | never: programs do not call each other |
| Move data between computers | Git, with no merging by Epicenter (ADR-0851) | never: no sync engine |
| Big files | a line in `.gitattributes` (ADR-0856) | never: no Epicenter setting |
| Reach from anywhere | an existing protocol, MCP (ADR-0853) | never: no Epicenter API |
| Run something later | a person or agent asks | never: no scheduler (ADR-0849) |
| Where code runs | a program on the device | it needs sign-ins or reach: an action on your server |

One step up is deliberate: your server is a computer that is always on,
because a phone and Claude anywhere need something to answer them.

**An app is a folder with a declared shape.** Its `epicenter.json` describes it
and declares the collections programs and people write; its `epicenter.ts`, when
present, holds its actions (ADR-0857). An app belongs to Epicenter by that
declaration, not by its runtime: a folder with only `epicenter.json` needs no
program at all to be an app.

**Code goes where what it needs is.** Code that needs the device (a microphone,
a global shortcut, pasting into another program) lives in a program on that
device. Code that needs the person's sign-ins, or must be reachable from
anywhere, is an action run on your server. Every app has the same shape with
different parts filled in: Mail has actions and no program of its own;
Whispering has a program and, until someone adds some, no actions.

**A program has the folder or asks.** With the folder, it writes files and
commits them when it knows the intent, or leaves them to `epicenter sync`
(ADR-0850, ADR-0851). Without it, or when it needs a sign-in
or an app's rule, it asks for an action over MCP. Programs never call each
other; two programs sharing an app meet at its folder. No program changes how it
writes because another program is installed.

**An app is one of yours when its folder is in `~/Epicenter`:** cloned there,
linked there, or made there by a program or by `epicenter new`. Its name is
its entry there. `~/Epicenter` holds nothing else of Epicenter's: no list of
apps, no settings. `epicenter link ~/Code/vault` joins a folder where it lives,
so its path, scripts, and remotes keep working: it checks the folder's
`epicenter.json` and a free name, then makes the symlink, and commits and moves
nothing. `epicenter new <name> --from <git url|path>` makes an app from a
starter, a repository with no data, and keeps it as the app's `upstream`
remote, whose changes `epicenter update` merges (ADR-0866).
`epicenter new <name>` alone makes the folder from a built-in template:
`epicenter.json` with its `$schema` and a `.gitignore` with `node_modules/`,
`.cache/`, `*.local`, and `*.local.*` (ADR-0858); it makes the folder a
repository and commits the template. An app that comes to hold binary files
adds its own `.gitattributes`, and Git LFS's filter is set up once per
computer (`git lfs install`), never per repository (ADR-0856). Sharing an app is sharing its Git URL; there is no
second way, such as an npm package an app re-exports.

**Epicenter's defaults are ordinary instances of open standards.** A remote is
any Git host, GitHub by default (ADR-0851); reach is MCP (ADR-0853); a view is
a web page that asks over MCP (ADR-0860). A hosted Epicenter, if one comes, runs
the same `epicenter serve` rather than being a product of its own; ADR-0864
leaves it undecided. A developer uses any Git host, their own computer, or their
own program without changing an app.

## Consequences

- The vault joins by a link, `~/Epicenter/vault`, to `~/Code/vault`.
- Mail is written in `~/Epicenter/mail`, not published as a package.
- An app works in every program that asks over MCP once it is added.

## Considered alternatives

- **One contract and four slots (this record's earliest draft).** A category for
  swappable pieces that were not one kind of thing.
- **Programs only ask for actions, never write files.** A program that writes
  only its own files would ship `epicenter` (about 70 MB, measured) or depend on
  it, to run three Git commands.
- **A program that writes files until `epicenter` is installed, then asks.** Two
  write paths in every program.
- **Apps ship their interface in the folder, and the Epicenter app hosts it
  through an API of its own.** Rebuilds the platform layer the earlier Mail died
  of, and makes Epicenter a gate. Views (ADR-0860) are web pages that ask over
  MCP, as any agent does.
- **Actions as WebAssembly, run by a CLI rewritten in Rust.** Sandboxing and
  actions that run anywhere, at the cost of a build step, most of npm, and
  Claude's edit-and-run loop. Revisit when apps from strangers run with a
  person's sign-ins.
- **A Rust core for collections, Git, and MCP.** None of those need JavaScript
  once shapes are JSON, so a small core could serve code-free apps and be linked
  into other programs. Revisit when a second program wants to embed it.
- **Epicenter Cloud as its own product with its own sync.** A second
  implementation of the remote and of your server.
