# 0904. Copying is the only way to take an app's code

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Supersedes:** [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md): a starter cloned and kept as `upstream`, and `epicenter update` merging it. Its layout of an app's code and its `origin` rule stand in ADR-0877, ADR-0880, and ADR-0851.
- **Amends:** [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) at "Taking an app and taking changes stay ADR-0866's", at "Forks and pull requests work in both directions", and at the rejected "Copying code with its source commit": taking an app copies it, and nothing merges. [ADR-0886](0886-vocab-practises-with-a-tutor-on-the-persons-own-model-and-zhongwen-is-vocab-cloned-for-chinese.md) at "keeps Vocab as its `upstream`", at "an Epicenter rebuilt on another computer still merges from it", and at "`epicenter update zhongwen` merges Vocab's changes". [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) at the noun `starter`: what is taken is any app's code. [ADR-0891](0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md) at "Every starter, Whispering's included, is a repository of its own", at "updated by a Git merge", and at the rejected `--from <repository>#<subfolder>`. [ADR-0902](0902-this-repositorys-outside-apps-stay-in-apps.md) at "Its rule that every starter is a repository of its own stands". [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) at "the app is updated, as from its starter". [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) at "which others take and `update` merges".
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (`epicenter add`, the first copy), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (`epicenter.ts`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a UI is a view over actions), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (`epicenter install` and its `Source` trailers), [ADR-0884](0884-an-epicenter-is-a-repository-that-lists-the-repositories-inside-it-and-init-from-rebuilds-it.md) (`repositories.json`), [ADR-0901](0901-an-app-is-inside-an-epicenter-or-outside-it.md) (`source`, a different noun).
- **Unbuilt:** nothing.

## Context

`epicenter new <name> --from <git url|path>` cloned a starter, an app's code
repository, into `apps/<name>`. It renamed the clone's remote to `upstream`
and left the branch tracking nothing. `epicenter update [<app> [<remote>]]`
fetched that remote and merged its default branch into the app's code
(ADR-0866, `01a596b402:packages/cli/src/update.ts`). Every copy of an app's
code shared one history, which ADR-0877 kept so that forks and pull requests
would work in both directions.

Four facts count against it.

- **Where an app's code came from was recorded in one clone's `.git/config`
  and nowhere else.** `repositories.json` lists each repository with its
  `origin` (`packages/cli/src/epicenter-repository.ts`). An Epicenter rebuilt
  with `epicenter init --from` had no `upstream`, and `epicenter update`
  answered `<app>: no upstream; left alone`. ADR-0886 said a rebuilt Epicenter
  "still merges from it".
- **A conflict ended in a raw merge.** `update` aborted the merge and printed
  `git -C <folder> merge <remote>/<branch>`. That command writes conflict
  markers into code that `epicenter serve` runs as it sits on disk (ADR-0880).
- **The merge never reached the data.** A changed path template or field can
  leave existing records not fitting their collection, and ADR-0866 said so:
  "Git merges code; it does not migrate data."
- **The merge made a starter a whole repository.** ADR-0891 rejected
  `--from <repository>#<subfolder>` for one reason, that `update` would
  become a subtree merge. Each app someone could take then needed a
  repository of its own.

Vocab, at `~/Epicenter/apps/vocab` on 2026-11-14, shows what a merge carried.
Its `epicenter.ts` is one file whose only import is `@epicenter/app`. Its UI
imports that file as a type and calls the actions through `connect()` from
`@epicenter/app/client`. 96 of its 104 tracked files are under `ui/`.

Taking code was designed as a copy twice before. ADR-0841's `epicenter add`
was to copy the files a repository tracks at one commit. ADR-0864's
`epicenter install` copied a list of files and committed them with `Source:`
and `Source-Commit:` trailers. ADR-0866 replaced both with the clone.

shadcn/ui distributes components as copied code its user owns, and since its
CLI v4 (March 2026) its documentation suggests asking an agent to merge
registry updates with local changes.

## Decision

**An app is its `epicenter.ts` over its data, and a UI is one replaceable
view of it.** `epicenter.ts` declares the collections and the actions, and
it is the app's contract. Code under `ui/` reaches the app through those
actions alone (ADR-0860). So a typecheck of a UI against an `epicenter.ts`
says whether that UI is valid for that app.

**Copying is the only way to take an app's code.**
`epicenter new <name> --from <git url>[#<folder>]` and
`epicenter new <name> --from <path>` copy the files Git tracks in one
folder, at one commit, into `apps/<name>`. The copy is the one commit of a
new repository.

```txt
epicenter new zhongwen --from https://github.com/someone/vocab
epicenter new mail --from https://github.com/someone/apps#mail
epicenter new vocab --from ~/Code/apps/vocab

apps/zhongwen/
  .git/             one commit, no remote:
                      new zhongwen
                      Source: https://github.com/someone/vocab
                      Source-Commit: <sha>
  epicenter.ts      copied: the contract
  ui/               copied: one view of it
  package.json  README.md  .gitignore
  data/             a new, empty data repository (ADR-0877)
```

- **A Git URL names a repository, and `#<folder>` a folder inside it.**
  `<url>` alone takes the repository's root.
- **A path names the folder itself.** It is a repository's root or any
  folder inside one, and takes no `#`. It must be inside a Git repository.
- **The folder must track an `epicenter.ts`.** One repository can hold
  several apps, and any app's code repository is something to take from.
- **The copy is what Git tracks at the commit the repository's `HEAD`
  names.** An ignored `data/`, `node_modules/`, a build, and an uncommitted
  change do not come along. The new repository holds none of the other
  repository's history and has no remote.
- **The commit records where it came from** in two trailers:
  `Source: <the --from argument>` and `Source-Commit: <sha>`. A path is
  recorded absolute, and an http(s) URL without any credentials it carried,
  since the commit is pushed with the app. No command reads the trailers.
  `Source` here is where code was copied from, not ADR-0901's
  `source`, where a pull copies items from.
- **A folder that tracks anything under `data/` is refused.** Data never
  travels (ADR-0876).
- **Taking an app is the decision to trust it.** `new --from` installs the
  app's packages and loads its `epicenter.ts`, as running any repository's
  code does.

**There is no `upstream` remote and no `epicenter update`.** Both are
removed with no deprecation period: `update` leaves the table in
`packages/cli/src/commands.ts`, and `new --from` adds no remote. An
`upstream` remote an app already has stays where it is, and no command uses
it.

**Taking later changes is work the person's agent does.** The `epicenter-app`
skill holds the procedure (`.agents/skills/epicenter-app/SKILL.md`):

1. Read `Source` and `Source-Commit` from the app's first commit.
2. Fetch that repository into a temporary directory outside the Epicenter.
3. Compare `epicenter.ts` first. It is the only change that can affect data.
   When a collection changed, plan how the existing records are migrated
   before taking it.
4. Take the UI changes wanted: replace `ui/` whole in one commit, which
   `git revert` takes back, or port the pieces wanted.
5. Run the app's typecheck and tests, and say what was and was not taken.

**An app's code stays a Git repository.** A commit before a replacement and
a revert after it are what make replacing code safe, and `epicenter history`,
snapshots, and `epicenter sync` work on that repository (ADR-0850, ADR-0851).
It holds the app's own history. It does not link the app to where its code
came from.

**An app's `epicenter.ts` and its UI stay in one code repository.** A UI is
valid against one version of `epicenter.ts`, and one commit states that the
two were valid together.

**A fix every app needs arrives through `epicenter`,** which supplies
`@epicenter/app` (ADR-0873). An app's own code is changed where it is, by
its person or their agent.

## Consequences

- One repository can publish several apps as folders. ADR-0891's rule that
  every starter is a repository of its own goes, and "starter" stops naming
  a kind of thing: what is taken is an app's code.
- Deleted: `epicenter update`, `01a596b402:packages/cli/src/update.ts` and
  its test, the rename of a clone's remote to `upstream`, the snapshot and
  lock `update` took before merging, and the answer
  `<app>: no upstream; left alone`.
- Where an app's code came from is in its first commit. An `origin` backup
  holds it, and `epicenter init --from` restores it with the repository.
- `Source` holds the `--from` argument. A path names a place on one
  computer and means nothing on another.
- Forks and pull requests through shared history are given up. ADR-0877
  kept one history for them. A change made in someone's copy now reaches the
  author as a diff someone reads, on GitHub or in a patch.
- The mechanical merge between two near-identical apps is given up.
  Zhongwen (ADR-0886) took Vocab's changes by four `update` merges on
  2026-11-12, while 24 of its files differed from Vocab's. That work is now
  an agent's comparison of two folders.
- A clone that already shares history with the code it came from can still
  run `git merge` by hand.
- Nothing tells an app that the code it was copied from has changed. A
  person asks their agent to look.
- Taking a change costs an agent's reading of a diff each time, where
  `update` was one command when it did not conflict.

## Considered alternatives

- **Shared history, with a folder merged by plain Git.** A prototype merged
  one folder of a repository into an app by wrapping `<commit>:<folder>`
  trees in synthetic commits. It works. It needs a throwaway repository,
  synthetic history, and a fetch workaround specific to GitHub, and its
  conflicts still land in code `serve` runs.
- **A three-way merge reconstructed from `Source-Commit`.** The recorded
  commit is a merge base, so `epicenter` could merge file by file. ADR-0877
  rejected this as `epicenter add`, because `epicenter` would own a merge
  Git already does. Copying with a recorded commit owns no merge.
- **Separate repositories for `epicenter.ts` and the UI.** A UI is valid
  against one version of the contract, and one commit says the two were
  valid together. Each added repository also adds a line in
  `repositories.json`, an `origin` to back up, and a clone on restore.
- **A registry or catalog of apps to take.** `--from` already takes any
  repository or folder by its address. A list adds something to host and
  keep current, and makes no app takeable that is not already.
- **Keep `update` for apps that still share history.** Two ways to take
  changes, one of which no new app could use.

## Not decided

- Several UIs side by side in one app. `serve` finds one folder named `ui/`
  (`packages/cli/src/ui.ts`).
- How an app records that it has taken changes up to a later commit.
  `Source-Commit` on the first commit does not move.
- Where Whispering's contract lives. ADR-0891 named
  `EpicenterHQ/whispering-starter` because every starter was a repository of
  its own. A folder of another repository would now serve.
