# 0889. An app runs on Epicenter, a program works with it, and they meet at the app's contract

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Relates:** [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (programs with the folder), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (`epicenter.ts`), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (`@epicenter/app`), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (what is published), [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) (clones), [ADR-0890](0890-a-programs-folder-is-its-own-and-holds-only-what-its-apps-contract-declares.md) (a program's folder), [ADR-0891](0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md) (where programs and starters live).
- **Unbuilt:** all of it: Whispering's starter, a front matter reader and writer a program can bundle, and the removal of `defineContract`.

## Context

Whispering is a desktop program people install on its own. Its folder was
described as an Epicenter app with special rules: an `epicenter.ts` someone
would write later (ADR-0853 left "how Whispering's folder gets one" open), and
a contract written a second time with `defineContract` in
`programs/whispering/src/lib/contract.ts`, beside `defineCollection` in
`packages/app/src/collection.ts`. Every rule that touched Whispering asked
which kind of app it was.

## Decision

**An app runs on Epicenter; a program works with it. They meet at the app's
contract and nowhere else.**

| Noun | What it is | Example |
| --- | --- | --- |
| app | a folder in an Epicenter whose `epicenter.ts` `epicenter` runs | `~/Epicenter/apps/vocab/` |
| contract | an app's collections: their path templates and fields | `defineCollection` in `epicenter.ts` |
| program | software that runs on its own and reads and writes a folder | Whispering |
| starter | an app's code repository, which someone else takes (ADR-0866) | `EpicenterHQ/whispering-starter` |
| clone | a program's clone of an app's data repository (ADR-0887) | `~/Whispering`, once connected |

People read "app" for both, as they would anywhere. Records, code, and
directory names say `program`. "Whispering" alone is the program; "the
`whispering` app" is the folder in an Epicenter made from its starter.

- **A file must satisfy its contract, and nothing else.** Any program that
  writes valid files is a valid writer, with no one's permission.
- **A program's contract is its starter's `epicenter.ts`, written once.** The
  program imports it as a type, as a UI does, so its bundle carries no
  `@epicenter/app` runtime, and its tests check the files it writes against
  the real collections. `epicenter <app> --json` prints the contract as JSON
  Schema for a program in another language. `defineContract` goes.
- **A program writes records with Epicenter's front matter reader and
  writer,** bundled from `@epicenter/app/front-matter`, an entry that imports
  no `node:` module and holds no runtime state, so a record
  it rewrites keeps every line it did not change (ADR-0888).
- **A starter may carry a `ui/`,** a UI over the app's actions (ADR-0860) for
  other devices. It shares no code with the program except components copied
  from `packages/ui`. Whispering's starter ships with `epicenter.ts` alone.

## Consequences

- No rule asks which kind of app something is: an app and a program sit on
  opposite sides of the contract.
- A third party builds a program the same way: a program anywhere, in any
  language, and a starter repository. Epicenter owns neither.
- A recorder on a phone that writes `recordings/<id>.md` is a valid Whispering
  writer.

## Considered alternatives

- **Two kinds of app, "runs on" and "works with".** Every rule about layout,
  writers, and docs grows a branch for the second kind.
- **"Template" for a starter.** "Template" already names a collection's path
  template, and a starter is a working app, not a form to fill in.
- **A program writes its own front matter.** A writer that reorders keys or
  requotes values turns a one-line edit into a whole-file clash.
