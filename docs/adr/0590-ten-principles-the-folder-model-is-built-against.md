# 0590. Ten principles the folder model is built against

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at `repository_alias`, "Moving a repository to another namespace, or renaming it, updates its row and leaves an alias", and the consequence that moving or renaming is one row update and an alias: the hosted Git service offers no rename, move, or alias. [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "Sharing a folder is moving it into a group" and the `manage` role's rename and move: neither is offered; share-by-move is reopened only if it becomes product work.
- **Relates:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0586](0586-you-open-a-folder-never-an-app.md), [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md), and [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) decide the principles; [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) makes the CLI the desktop host's TypeScript half.
- **Unbuilt:** deleting hosted repository rename, move, and aliases, with the migration that drops `repository_alias`; the package boundaries under Consequences.

## Context

ADR-0585, 0586, 0587, and 0589 replaced several mechanisms at once:
publication, ownership, containment, the merge driver, `local`, the scope
registry, Epicenter's own folder, the manifest, and building on the
person's machine. Each record decides one part. A change made later needs
the whole in one place, to check itself against.

One mechanism outside those records contradicts them. The hosted Git
service renames and moves repositories and leaves an alias for the old
name (`renameRepository` and `moveRepository`, `packages/server/src/repositories.ts:309`, `:327`;
`repository_alias`, `packages/server/src/db/schema/repository.ts:51`; the
alias branch of the access query,
`packages/server/src/auth/resource-access.ts:157-166`). Its promise is that
every existing clone keeps working (ADR-0546). Without the alias, an old
clone would push to the old name, and the first push to a name nobody holds
creates a repository (`packages/server/src/routes/git.ts:362-370`): a
second repository, silently.

## Decision

**A folder is what a person owns and opens; an app is code the host hands
one folder; machine state belongs to the host.**

```txt
PERSON-OWNED, SYNCED                         MACHINE-OWNED, NEVER SYNCED
FOLDER  ~/Epicenter/<name>/ or OPFS root     HOST  desktop shell | browser origin | CLI
  files            anything                    lists folders, launches by epicenter.json's app
  epicenter.json   app, tables: describes      <data_dir>/apps/<encoded address>/   installed clones
  .gitignore       what never syncs            approvals.json   address + commit
  .git/            history; template upstream  connections.json + keychain
        ▲                                      windows: label -> one commit, one folder
        │ handed exactly one
WINDOW  one approved app commit + one folder, for its lifetime
        │ runs
APP     host/owner/repo: built files on the default branch, folder template on `template`
ENGINE  @epicenter/folder: files, tables typed by a definition, one write, merge by unit, history, Sync
```

**The principles.** Each is one rule, then what it deletes and what it rules
out.

1. **A folder is a directory a person owns, and its files and Git history
   are the only authority** (ADR-0585). Deletes publication and ownership;
   rules out state a folder depends on that lives outside it.
2. **Every real, non-dot directory in `~/Epicenter` is a data folder, named
   by its directory** (ADR-0585, ADR-0586). Deletes the `epicenter.json`
   marker, `title`, and app-named folders; rules out a second name for a
   folder.
3. **`epicenter.json` describes and never governs** (ADR-0585). Deletes
   containment and `DefinitionMismatch`; rules out an app reading or
   writing it to decide what is correct.
4. **Epicenter merges by file content and extension, never refuses to
   commit a file, and leaves mistakes to Git** (ADR-0585). Deletes table
   classification, the merge driver, and `local`; rules out a refusal keyed
   on a schema, an app, or a path an app wants kept.
5. **A folder starts as a copy of its app's published template, and that
   template is its Git upstream** (ADR-0585, ADR-0589). Deletes the two-way
   diff and per-device template synthesis; rules out an app update changing
   folder files.
6. **An app is one Git repository of built files at an address, and one
   approved commit supplies every byte that runs** (ADR-0589). Deletes the
   install-time build, the manifest, and reverse-domain ids; rules out
   bytes between approval and serving that the commit does not hold.
7. **A window opens exactly the folder it was handed, on exactly the build
   it opened on** (ADR-0586; ADR-0588 in pull request #2565). Deletes the
   scope registry, own folders, and the `app` option; rules out a page
   choosing its folder or its build.
8. **The page API is a contract that changes only by addition after the
   first release** (ADR-0589). Deletes rebuilding installed apps with each
   shell; rules out a breaking change to a command a published app calls.
9. **Machine state belongs to the host, in app data or the keychain**
   (ADR-0586, ADR-0587). Deletes `so.epicenter` and synced connection
   choices; rules out a synced pointer to machine-local state.
10. **The hosted Git service stores data repositories and nothing else.**
    Deletes repository rename, move, and aliases; rules out serving apps
    or resolving app addresses there.

**The hosted Git service offers no rename, move, or alias.** Deleted:
`renameRepository` and `moveRepository` in
`packages/server/src/repositories.ts`, `repository_alias` and its relation
in `packages/server/src/db/schema/repository.ts`, the alias branch of the
access query in `packages/server/src/auth/resource-access.ts`, and one
migration that drops the alias table. A person who wants another name
pushes the folder to a new repository and deletes the old one.

## Consequences

- A change is checked against these principles before a record or code
  adds a refusal, a second name, a synced machine state, or a per-app rule.
- Package boundaries follow:
  - `packages/folder` names no app: no `own`, no `app` in `Opening`, no app
    id as a folder id.
  - `packages/cli` is the desktop host's TypeScript half (ADR-0556) and the
    only owner of the install layout, which
    `apps/epicenter/src-tauri/src/app_data.rs` duplicates today
    (`apps_dir`, `builds_dir`); publishing and installing are separate
    modules there.
  - `<FolderApp>` in `packages/svelte` loses its `app` prop.
- A folder's hosted repository keeps its name for life; renaming the folder
  on disk changes nothing remote.
- Sharing a folder with a group waits until it is product work.

## Considered alternatives

- **Keep rename and move with aliases.** The alias exists only so an old
  clone keeps working, and it keeps a name taken until a new repository
  claims it; without a product feature that needs moving, it is a promise
  with no caller.
- **Rename and move with an HTTP redirect instead of an alias.** An old
  clone that pushes to the old name creates a new repository through
  first-push creation, so a redirect does not keep a clone working.
