# 0590. Every change to the folder model is checked against ten principles

- **Status:** Accepted
- **Date:** 2026-10-17
- **Relates:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0586](0586-you-open-a-folder-never-an-app.md), [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md), [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md), and [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) decide the principles; [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) makes the CLI the desktop host's TypeScript half.
- **Unbuilt:** the package boundaries under Consequences.

## Context

The records this cites replaced publication, ownership, containment, the
merge driver, `local`, the scope registry, Epicenter's own folder, the
manifest, building on the person's machine, and hosted rename. Each decides
one part. A later change needs the whole in one place to check itself
against.

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

**Every change is checked against these principles:**

1. A folder is a directory a person owns, and its files and Git history are
   the only authority (ADR-0585).
2. Every real, non-dot directory in `~/Epicenter` is a data folder, named by
   its directory, with no second local name (ADR-0585).
3. A folder's `epicenter.json` describes and never governs: nothing reads it
   to refuse or rewrite data (ADR-0585).
4. Epicenter merges by file content and extension (ADR-0591), never refuses
   to commit a file because of what it holds, refuses only what another
   device could not write back as plain files, and leaves mistakes to Git
   (ADR-0592).
5. A folder starts as a copy of its app's published template, and that
   template is its Git upstream (ADR-0585, ADR-0589).
6. An app is one Git repository of built files at an address, and one
   approved commit supplies every byte that runs (ADR-0589).
7. A window opens exactly the folder it was handed, on exactly the build it
   opened on (ADR-0586, ADR-0588).
8. The page API is a contract that changes only by addition after the first
   release (ADR-0589).
9. Machine state belongs to the host, in app data or the keychain
   (ADR-0586, ADR-0587).
10. The hosted Git service stores data repositories and nothing else
    (ADR-0593).

## Consequences

- A record or change that adds a refusal, a second name for a folder, a
  synced pointer to machine state, or a per-app rule in shared code names
  the principle it breaks and the record that changes it.
- Package boundaries:
  - `packages/folder` names no app: no `own`, no `app` in `Opening`, no app
    id as a folder id.
  - `packages/cli` is the desktop host's TypeScript half (ADR-0556) and the
    only owner of the install layout, which
    `apps/epicenter/src-tauri/src/app_data.rs` duplicates today
    (`apps_dir`, `builds_dir`); publishing and installing are separate
    modules there.
  - `<FolderApp>` in `packages/svelte` loses its `app` prop.
