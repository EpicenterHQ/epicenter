# 0569. The installed apps are the clones in Apps/, not rows in so.epicenter

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at the `apps` table, the `defaultApp` setting, "Every app is a row", and the consequences that an agent lists apps by editing `so.epicenter` and that connecting it carries a person's apps to another machine: `so.epicenter` holds the `connections` table only, and the installed apps are the clones in `Apps/` with `approvals.json`.
- **Amends:** [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at "every app is a row, and the row gains `folder`" and the `apps` row's `folder` that lets another machine install the same app: there is no row, and `epicenter.folder` in the clone is the only record of the folder.
- **Amended by:** [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) at "The CLI owns `so.epicenter`'s declaration and publishes it at every launch": there is no `so.epicenter` and no declaration.
- **Amended by:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) at `~/Epicenter/Apps/`: the clones are in `<data_dir>/apps/`.
- **Amended by:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "the clones in `~/Epicenter/Apps/`": the installed apps are clones of built repositories in `<data_dir>/apps/<encoded address>/`.
- **Amended by:** [ADR-0597](0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md) at "the approvals in `approvals.json`": the bare clones alone record what is installed and approved.
- **Amended by:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at the clones of built repositories and "the bare clones alone record what is installed and approved": the installed apps are the person's clones of app source in `<data_dir>/apps/<encoded address>/`, and nothing records an approval.

## Context

ADR-0539 gave `so.epicenter` an `apps` table, one row per installed app at
`apps/<app-id>.md` holding `title`, `source`, `folder`, and `commit`, and a
`defaultApp` setting in `kv.json` mapping a folder id to an app id. ADR-0552
added the row's `folder`, "so another machine can install the same app from
the row".

The Folders window owned that declaration
(`epicenter-folder.ts` in `apps/epicenter/src/folders/`, deleted in 1c01c98ff6). It
published `epicenter.json` when it opened, and after each listing it wrote a
row for every app whose state was `ready` (`recordInstalledApps`,
`writeAppRows`). Three facts made the table wrong:

- Nothing read it. `inspect` in `packages/cli/src/installed-apps.ts` reads an
  app's source from `origin`, its folder from `epicenter.folder`, and its
  commit from `HEAD`; no code read an `apps` row or `defaultApp`.
- The CLI and the Folders window disagreed. `epicenter app list` reads the
  clones; the rows held what the Folders window last listed. Nothing deleted a
  row when `epicenter app remove` deleted a clone.
- A terminal `epicenter app install` wrote no row. Its app had one only after
  a person next opened the Folders window.

## Decision

**The installed apps on a machine are the clones in `~/Epicenter/Apps/` with
the approvals in `approvals.json`, and `epicenter app list` is the one reader
of them.**

```txt
~/Epicenter/Apps/<app-id>/                             a clone; source from origin, folder from epicenter.folder, commit from HEAD
~/Library/Application Support/so.epicenter/approvals.json   { [appId]: { commit, approvedAt } }
~/Epicenter/so.epicenter/epicenter.json                declares the connections table only
```

- `listInstalled` in `packages/cli/src/installed-apps.ts` lists every
  directory of `Apps/` that does not start with `.`, and `inspect` reads each
  app and its approval. The Folders window lists through the same command
  (`list_installed_apps` in `apps/epicenter/src-tauri/src/installed_apps.rs`
  runs `epicenter app list --json`).
- `so.epicenter` has no `apps` table and no `defaultApp` setting.
  `epicenterDefinition` in `packages/cli/src/epicenter-folder.ts` declares
  `connections` ([ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md))
  and an empty `kv`.

**The CLI owns `so.epicenter`'s declaration and publishes it at every
launch.** `epicenter declare-epicenter-folder` writes
`so.epicenter/epicenter.json` (`declareEpicenterFolder` in
`packages/cli/src/epicenter-folder.ts`). The shell runs it in the background
at every launch (`spawn_epicenter_folder_declaration` in
`apps/epicenter/src-tauri/src/cli.rs`, called from `run` in
`apps/epicenter/src-tauri/src/lib.rs`) and opens no installed app until it has
finished, whichever window opened first.

## Consequences

- An app installed, updated, or removed in a terminal is listed the same way
  in the Folders window, with no step that writes a row.
- Another machine cannot see through `so.epicenter` which apps are installed
  elsewhere. Reinstalling there is `epicenter app install <repository-url>`
  with the folder, as on the first machine.
- A person who wants a default app per folder has no setting for it until a
  reader exists; a later decision adds the setting with its reader.
- An `apps/` directory or a `defaultApp` key in an existing `so.epicenter` is
  left in place and read by nothing.

## Considered alternatives

- **Keep the rows, written by the CLI on install, update, and remove.** It
  fixes the disagreement and the terminal install, and still writes a table
  nothing reads. A row synced from another machine would also need an install
  path that reads it, which ADR-0539 left unbuilt.
