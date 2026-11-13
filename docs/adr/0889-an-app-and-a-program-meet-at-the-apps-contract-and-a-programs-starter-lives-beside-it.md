# 0889. An app and a program meet at the app's contract, and a program's starter lives beside it

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) at where Whispering's folder lives: `~/Whispering`, not `~/Epicenter/whispering`, and its folder holds only what its app's contract declares.
- **Relates:** [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (programs with the folder), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (`epicenter.ts`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a UI), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (`@epicenter/app`), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (this repository holds no apps), [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-and-pushes-to-it-and-the-host-files-what-it-receives.md) (clones).
- **Unbuilt:** all of it: `programs/whispering/`, its `starter/`, the mirror, `sites/landing/`, and the removal of `defineContract`.

## Context

Whispering is a desktop program people install on its own. Its folder of
recordings was described as an Epicenter app with special rules: a folder at
`~/Epicenter/whispering` (ADR-0858), an `epicenter.ts` someone would write
later (ADR-0853 left "how Whispering's folder gets one" open), and a contract
written a second time with `defineContract` in `apps/whispering/src/lib/contract.ts`
beside `defineCollection` in `packages/app/src/collection.ts`. Every rule that
touched Whispering asked which kind of app it was.

## Decision

**An app runs on Epicenter; a program works with it. They meet at the app's
contract and nowhere else.**

| Noun | What it is | Example |
| --- | --- | --- |
| app | a folder in an Epicenter whose `epicenter.ts` `epicenter` runs | `~/Epicenter/apps/vocab/` |
| contract | an app's collections: their path templates and fields | `defineCollection` in `epicenter.ts` |
| program | software that runs on its own and reads and writes a folder | Whispering |
| starter | an app's code repository, which someone else takes (ADR-0866) | Whispering's `starter/` |
| clone | a program's clone of an app's data repository (ADR-0887) | `~/Whispering` once connected |

People read "app" for both, as they would anywhere; records, code, and
directory names say `program` where the distinction matters.

- **A program's contract is its starter's `epicenter.ts`, written once.** The
  program imports it as a type, as a UI does, so its bundle carries no
  `@epicenter/app`; its tests check written files against the real
  collections. `defineContract` and an authored `contract.json` go: the
  command prints the contract as JSON Schema with `epicenter <app> --json`.
- **A file must satisfy its contract, and nothing else.** Any program that
  writes valid files is a valid writer, with no one's permission.
- **A program's folder is its own.** Whispering's is `~/Whispering`, and alone
  it mentions Epicenter only in the setting that connects it. On the host, a
  person may point Whispering at `~/Epicenter/apps/whispering/data` instead
  and not connect; it then writes as any editor on the host does.
- **A program's folder holds only what its app's contract declares.** What
  belongs to one device (the microphone, a shortcut, window state) is program
  state in the program's own data directory, and its secrets are in the
  Keychain (ADR-0858, ADR-0870). A preference that should follow the person is
  a collection in the contract.
- **A program's starter lives beside it.** The starter may carry a `ui/`,
  which is a UI over the app's actions (ADR-0860) and shares no code with the
  program but components copied from `packages/ui`. CI mirrors each
  `programs/<program>/starter/` to a repository of its own on each release
  (`git subtree split`), so `epicenter new <app> --from <repository>` and
  `epicenter update` stay Git operations on a whole repository.

```txt
EpicenterHQ/epicenter
  packages/cli                  the command
  packages/app                  @epicenter/app, carried by the command
  packages/ui                   components apps and programs copy
  programs/whispering/          the desktop program
  programs/whispering/starter/  epicenter.ts, README.md, package.json; later ui/
  sites/landing/                the website
```

## Consequences

- No rule asks which kind of app something is: an app and a program sit on
  opposite sides of the contract.
- `apps/` in this repository is renamed `programs/` when the old product
  leaves, and `apps/landing` moves to `sites/landing`.
  `apps/posthog-reverse-proxy` is deleted with the rest of the old product.
- A third party builds a program the same way: a program anywhere, in any
  language, and a starter repository. Epicenter owns neither.
- Two things are named Whispering. "Whispering" alone is the program; "the
  `whispering` app" is the folder in an Epicenter made from its starter.
- The starter ships with `epicenter.ts` alone at first; its `ui/` comes when
  someone wants their recordings in a browser on another device.

## Considered alternatives

- **Two kinds of app, "runs on" and "works with".** Every rule about layout,
  writers, and docs grows a branch for the second kind.
- **Starters in a top-level `starters/`.** The only starters in this
  repository belong to its programs; other apps' starters are their own
  repositories (ADR-0877).
- **`epicenter new --from <repository>#<subfolder>`.** `update` becomes a
  subtree merge, which ADR-0866 declined to own.
- **Keep `apps/`, Turborepo's convention.** It names Whispering with the one
  word this project defines differently.
- **"Template" for a starter.** "Template" already names a collection's path
  template, and a starter is a working app, not a form to fill in.
