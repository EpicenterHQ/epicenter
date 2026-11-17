# 0942. A home is one Bun workspace, and Epicenter is a dependency of it

- **Status:** Proposed
- **Date:** 2026-11-17
- **Supersedes:** [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (the command supplies `@epicenter/app` to every app), once accepted.
- **Amends:** [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) on package installs and the engines check. [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) on an app that is a link to code outside the home: it no longer loads.
- **Relates:** [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) (the person keeps serve running; Epicenter writes no job), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) (Epicenter does not wrap tools the owner has), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve per home).
- **Unbuilt:** publishing. `@epicenter/app`, `@epicenter/cli` and `@epicenter/theme` are publishable and not yet on a registry, and the owner's home still runs the earlier program with a package folder per app.

## Context

`epicenter` was a program installed on the computer, apart from any home. It
carried its own copy of the library an app imports, handed that copy to each
`epicenter.ts` through a Bun plugin, wrote it to a folder under the user's
account, and linked every app's `node_modules` to it. Each app had its own
`package.json`, lock file and `node_modules`, and `epicenter install` ran
`bun install` in each and made the link. Each app named the Epicenter
versions it accepted, and the command checked.

All of that existed to get one library into eleven apps, and it left three
things outside the home: the program, the copy of the library, and which
version the home runs. A trial on a clone of the owner's home ran it as one
plain Bun workspace: 1.2 GB of installed packages became 238 MB, eight copies
of Svelte became one, and a repeat install took half a second.

## Decision

**A home is one Bun workspace, and Epicenter is an ordinary dependency of
it.**

```json
{
  "private": true,
  "workspaces": ["apps/*/code"],
  "dependencies": { "@epicenter/cli": "0.5.0", "@epicenter/app": "0.5.0" }
}
```

- **One install.** `bun install` at the top of the home installs every
  app's packages and Epicenter. `epicenter install` is that command, found
  from anywhere in the home. There is one lock file, committed, and one
  `node_modules`, ignored.
- **One copy of the library, by ordinary resolution.** The command and every
  app find `@epicenter/app` in the home's `node_modules`. There is no
  plugin, no link and no copy outside the home. The command says so plainly
  when an app resolves a different copy.
- **The version a home runs is a line in a file in Git.** Upgrading is
  `bun update`, and going back is a revert and an install. The engines field
  and its check are gone.
- **The command runs from the home's install, with Bun.** There is no
  single-file program. Whatever keeps serve running (ADR-0941) runs Bun and
  `<home>/node_modules/.bin/epicenter serve`.
- **The packages are published.** `@epicenter/app`, `@epicenter/cli` and
  `@epicenter/theme` ship their TypeScript source under AGPL-3.0-or-later.
  An app that imports the library and is shared is AGPL as well, which is
  the point of the license.
- **A package nested inside an app is a workspace member the owner adds.**
  `init` writes `apps/*/code`; a second package inside an app is listed by
  hand.

## Consequences

- About 1,900 lines leave the command: the carried copy, the plugin, the
  link, the engines check, the installer, the compile and release scripts
  and their tests.
- Bun must be installed. `epicenter` is the home's own command, so it is
  run from inside the home.
- A changed dependency shows after serve restarts: packages are now outside
  the app folder serve forgets before each call. An edit to an app's own
  code still shows on the next call.
- An app whose folder is a link to code outside the home does not load. Bun
  resolves a package from where a file really is, so that code cannot find
  the home's install. Keep an app's code inside the home.
- An app must declare what it imports. Three of the owner's apps imported
  packages they had not declared, which worked only by how each app's
  packages happened to be laid out.
- Copying an app renames its package and drops its lock file, since two
  members cannot share a name and the home has one lock.
- Working on Epicenter itself gains a step: to try an unreleased change
  against a home, pack the packages and point the home's `overrides` at the
  tarballs. Bun caches a tarball by its path, so the pack script names the
  folder by its content.
- Full Disk Access for an app that needs it is granted to Bun, which is
  broader than one program.

## Considered alternatives

- **Keep the separate program and its link.** It works, and it is three
  things outside the home that the home's history knows nothing about.
- **One link at the top of the home, with everything else as it was.** It
  removes the per-app link and nothing else: the program, its copy of the
  library and the version stay outside.
- **Tarballs committed inside the home, with no registry.** The trial made
  it work. It needs content-named files and `overrides` to stay in step, to
  avoid a publish.
- **Bind an app's records to the folder beside its code, and drop the
  per-call context.** A separate trial: it removes about 500 lines, and a
  test can then no longer point an app at a scratch folder, so a careless
  test would write to live records. The context stays; one copy of the
  library, which it needs, is now true by construction.
- **One process per app, started in its own folder.** The folder question
  disappears, and serve gains eleven programs to start, restart and watch.
