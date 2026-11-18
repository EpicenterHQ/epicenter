# 0929. `new` copies an app's code from a folder in Git or a folder on GitHub

- **Status:** Superseded
- **Date:** 2026-11-16
- **Amends:** [ADR-0904](0904-copying-is-the-only-way-to-take-an-apps-code.md) at "`epicenter new <name> --from <git url>[#<folder>]`" and at "`Source` holds the `--from` argument": a source is a folder on disk or `owner/repo/folder#ref` on GitHub, and `SOURCE.md` records repository, folder, ref, and commit as fields. [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) at "`new --from <path|url>[#folder]`". [ADR-0912](0912-shared-app-code-comes-from-the-app-we-maintain.md) at "Recipients use `new <name> --from <repository>#<folder>`".
- **Superseded by:** [ADR-0955](0955-new-makes-a-blank-app-and-taking-an-app-is-copying-its-folder.md): `new --from` no longer exists; taking an app is copying its folder.
- **Relates:** [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md) (export writes app code to a folder), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (the same move for the network: `serve` stops choosing addresses and the owner's tools bring devices in).

## Context

`new --from` accepted any Git URL, an optional folder after `#`, or a local
path. It cloned the default branch only, so no version could be chosen. Its
own grammar collided with every neighbor's: `#` means a version to npm, pnpm,
degit, giget, and shadcn, but a folder in Epicenter, so `repo#v2` quietly
copied a folder named `v2`. `@`, the other common version mark, is part of
SSH addresses (`git@host:`) and legal in folder names. Git itself has a
standard for a repository and a standard for "this folder at this commit"
(`<rev>:<path>`), but none for both in one string, which is why each tool
invents one.

An app is one folder, and it always lands in `apps/<name>/code/`. Moving
folders between computers, at any version, with any credentials, is what Git
already does. Everything `new` added on top of Git was a second, weaker way to
fetch.

shadcn's `add` shows the shape that works for a copy-and-own tool: its base is
a source it can read directly, and its GitHub form, `owner/repo/item#ref`, is
a shortcut that needs no build or hosting. Most of its registry format exists
because a shadcn item scatters files across a project; an Epicenter app does
not, so a folder needs no manifest.

## Decision

`--from` takes one of two things.

**A folder in a Git checkout, written as a path.** A path starts with `/`,
`./`, `../`, or `~/`. Git says which repository holds the folder, and its
current commit is copied, including a detached commit after
`git checkout v2`. Any host, protocol, credential, or version works because
Git fetched it first:

```sh
git clone https://gitlab.com/someone/apps ~/Code/someone-apps
epicenter new notes --from ~/Code/someone-apps/notes
```

**A folder on GitHub, written `owner/repo[/folder][#ref]`.** `ref` is a
branch, a tag, or a full commit; without it, the default branch is copied.
`new` clones shallow without file contents, so only the copied folder's files
are downloaded, then copies it exactly as it copies a local folder:

```sh
epicenter new writing --from EpicenterHQ/epicenter/examples/writing
epicenter new tasks --from someone/shared-apps/apps/tasks#v2
```

Anything else is refused with a hint: a Git URL is told to clone first, and a
bare word is told to write `./word`. When the named folder holds several apps,
`new` lists them and prints the `--from` for one.

`code/SOURCE.md` records fields, not the typed string:

```text
Repository: https://github.com/EpicenterHQ/epicenter
Folder: examples/writing
Ref: v2
Commit: 2a75142ba47ccd9f226a439868c7d302e096bb64
```

`Repository` is the GitHub address, or a local checkout's `origin` with HTTP
credentials removed, else its path. `Folder` is the folder actually copied,
including a `code/` wrapper `new` descended into. `Ref` appears only when one
was named. Together the fields are what a later comparison needs:
`git diff <Commit>..<new> -- <Folder>`. No command reads the file.

The examples stay in this repository. The GitHub form fetches only their
folder, and the release check copies them from the same commit as the CLI it
tests.

## Consequences

- The first run is one command again, and downloads one example folder, not
  the repository.
- Choosing a version is ordinary Git: `#ref` on GitHub, `git checkout`
  anywhere else.
- `new` no longer parses URLs or strips credentials from them. It owns one
  GitHub-shaped address and the clone that serves it.
- Copying from GitLab or a self-hosted server takes two commands. A private
  GitHub repository reached only over SSH does too, since the GitHub form
  clones over HTTPS.
- A GitHub folder has no working tree to compare, so `notCopied` is absent for
  it, as it was for a remote URL.
- `--from <url>#<folder>` is refused. Apps copied with it keep their old
  `Source:` lines; nothing reads them.
- `export` still writes to a folder. Publishing stays `git push`.

## Considered alternatives

- **Keep any Git URL with `#folder` and add `--ref`.** One command for every
  host, at the cost of keeping a URL grammar whose `#` contradicts every
  neighbor's, plus credential handling Git already does.
- **Host prefixes such as `github:owner/repo/folder@v2`.** A third dialect no
  one has in their clipboard, needing a host table and an escape for GitLab
  subgroups.
- **Pasted browser URLs (`…/tree/<ref>/<folder>`).** The string a person
  holds, but per-host parsers and an extra round trip to split branch names
  that contain `/`.
- **A registry format like shadcn's `registry.json`.** A manifest describes
  where scattered files land; an app is one folder that describes itself in
  `epicenter.ts`.
- **Moving the examples to their own repository.** A small clone, but a second
  repository to keep current, examples no longer tested against the same
  commit as the CLI, and attention split across two repositories.
- **Built-in app names (`epicenter new writing`) and named registries
  (`@owner/app`).** Each is a later shortcut onto the same copy. Neither is
  needed while the examples sit at one GitHub address.
