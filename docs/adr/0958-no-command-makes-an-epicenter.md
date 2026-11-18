# 0958. No command makes an Epicenter

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) on "the home commits itself": no checkpoint routine or script arrives with a home. [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) and [ADR-0944](0944-an-app-builds-its-own-ui-and-serve-only-serves-it.md) on who runs `bun install`: no command does.
- **Relates:** [ADR-0943](0943-epicenters-core-invariants.md) (rules 1 and 7), [ADR-0957](0957-home-is-retired-the-folder-is-your-epicenter-and-root-in-code.md).

## Context

`epicenter init` was 350 lines. It wrote `EPICENTER.md`, a starter
`AGENTS.md`, the workspace `package.json`, a checkpoint routine and its
script, `.gitignore`, `bunfig.toml` and Git LFS attributes; ran `git init`,
`bun install` and a first commit; refused a folder inside another Epicenter
or one without a Git identity; and patched an existing `.gitignore`. Each
of those is a file or a command the owner can type. By rule 7 of ADR-0943,
Epicenter does not wrap them. The only Epicenter there is to serve today is
one its owner already has.

## Decision

**No command makes an Epicenter, and Epicenter ships no template. An
Epicenter is a folder its owner makes: `EPICENTER.md`, the workspace
`package.json`, a `.gitignore` that keeps `/apps/*/local/` and `.env*` out of
Git, and `apps/`. The owner then runs
`git init` and `bun install`.**

- The command's README states those files. It is the only description of a
  new Epicenter.
- A command run where no folder is marked refuses with
  `mkdir -p <folder> && touch <folder>/EPICENTER.md`.
- Committing the home is the owner's: by hand, or from a routine that runs
  their own script. No script ships.

## Consequences

- Removed: `init.ts`, `install.ts`, the `init` entry in the command table,
  the starter `AGENTS.md`, the checkpoint routine and script and their tests,
  and the tests of nesting refusal, identity refusal and `.gitignore`
  patching.
- A new Epicenter is safe only if its owner writes the `.gitignore` lines
  before the first commit. Nothing checks it. A credential in `.env` or
  `local/` reaches origin the first time a commit stages everything.
- An Epicenter inside another is no longer refused when made. Root
  discovery takes the nearest marked folder, so the inner one wins inside
  it.
- Existing Epicenters keep the files init wrote; they are the owner's.
- Making an Epicenter for a test writes the same files; the CLI's fixture
  already does.

## Considered alternatives

- **Init copies a `template/` folder the package ships.** It keeps the
  safety files right by default, but keeps a command and a folder to
  maintain for a step that happens once per owner.
- **A starter repository used as a GitHub template.** Plain Git, and the
  safety files arrive with it, but it is a second repository whose version
  pin must follow every release.
