# 0602. `<FolderApp>` names its app by the last segment of its address

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at the deleted `epicenter.app.json` and its `title`: the name `<FolderApp>` shows is the last segment of the app's address.
- **Unbuilt:** all of it: `<FolderApp>` reading `definition.app`.

## Context

`<FolderApp>` (`packages/svelte/src/folder-app.svelte`) takes
`app={manifest}` and shows `app.title` in "Opening <title>…" (`:98`), in
"<title> could not open its folder" (`:86`), and in its refusal (`:101`),
and in a browser it names the folder's commit author with it (`:64`).
ADR-0586 deletes the `app` prop, and ADR-0589 deletes `epicenter.app.json`
and its `title`. A Definition carries the app's address as `app`
(ADR-0585).

## Decision

**`<FolderApp>` shows its app's name as the last path segment of
`definition.app`,** wherever it shows `app.title` today:
`github.com/EpicenterHQ/todos` reads "todos", as in "Opening todos…".

## Consequences

- An app chooses its displayed name by choosing its repository's name;
  there is no second name to keep in step.
- The name shows as the repository spells it, so a name with a space is not
  available.
