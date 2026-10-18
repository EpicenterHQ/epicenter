# 0590. Every change to the folder model is checked against ten principles

- **Status:** Superseded
- **Date:** 2026-10-17
- **Superseded by:** [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md): the folder model and its desktop host are replaced by repositories, tables, and browser clones, and nine principles summarize them.
- **Amended by:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at principle 6, the diagram's bare clones, detached `HEAD`, "one approved app commit", and "one build on the default branch", the Context's "building on the person's machine" among the replaced ideas, and the consequence "publishing and installing are separate modules there": principle 6 reads as ADR-0605 restates it. [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at principle 7, "A window opens exactly the folder it was handed, on exactly the build it opened on", the bold "an app is code the host hands one folder", and the diagram's "handed exactly one", "windows: label -> one commit, one folder", and "+ one folder, for its lifetime": principle 7 reads "A window runs exactly its build", and an app opens any data folder by id. [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md) at principle 5 and the diagram's "template upstream" and "folder template on `template`": principle 5 reads as ADR-0609 restates it, and a folder's only remote is the person's own.
- **Relates:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0586](0586-you-open-a-folder-never-an-app.md), [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md), [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md), [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md), [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md), [ADR-0595](0595-the-self-hosted-git-store-accepts-a-force-push.md), [ADR-0596](0596-native-dictation-code-no-page-can-reach-compiles-only-behind-an-off-by-default-cargo-feature.md), [ADR-0597](0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [ADR-0600](0600-an-approved-commit-supplies-a-windows-page-and-its-relative-assets.md), and [ADR-0602](0602-folderapp-names-its-app-by-the-last-segment-of-its-address.md) decide the principles; [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) makes the CLI the desktop host's TypeScript half.
- **Unbuilt:** the package boundaries under Consequences.

## Context

The principles are a maintained summary: when a record they cite changes,
the principle is restated here in the same change, and the cited record
governs where the two differ.

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
  epicenter.json   app, tables: describes      <data_dir>/apps/<encoded address>/   bare clones
  .gitignore       what never syncs              HEAD, detached: the approved commit
  .git/            history; template upstream  connections.json + keychain
        ▲                                      windows: label -> one commit, one folder
        │ handed exactly one
WINDOW  one approved app commit + one folder, for its lifetime
        │ runs
APP     host/owner/repo: one build on the default branch, folder template on `template`
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
   (ADR-0592), whose force push the self-hosted Git store accepts
   (ADR-0595).
5. A folder starts as a copy of its app's published template, and that
   template is its Git upstream (ADR-0585, ADR-0589).
6. An app is one Git repository of built files at an address, built once
   for every host (ADR-0589, ADR-0598). One approved commit, its bare
   clone's detached `HEAD`, supplies a window's page and the assets it
   loads by relative path (ADR-0597, ADR-0600).
7. A window opens exactly the folder it was handed, on exactly the build it
   opened on (ADR-0586, ADR-0588).
8. The page API is a contract that changes only by addition after the first
   release, so nothing enters it that no page calls (ADR-0589).
9. Machine state belongs to the host, in app data or the keychain
   (ADR-0586, ADR-0587).
10. Epicenter offers no app hosting: its Git service accepts any Git
    content a person pushes, and only its owner reaches a repository
    (ADR-0593, ADR-0594).

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
  - `<FolderApp>` in `packages/svelte` loses its `app` prop and names its
    app by the last segment of `definition.app` (ADR-0602).
