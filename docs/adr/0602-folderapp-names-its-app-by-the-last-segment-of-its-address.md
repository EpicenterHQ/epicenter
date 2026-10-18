# 0602. `<FolderApp>` names its app by the last segment of its address

- **Status:** Superseded
- **Date:** 2026-10-17
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the desktop host; Epicenter builds no desktop host, no app registry or installed apps, and no native capabilities.
- **Amends:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at the deleted `epicenter.app.json`, its `title`, and its `id`: the name `<FolderApp>` shows, and a browser folder's commit author, come from the last segment of the app's address.
- **Unbuilt:** all of it: `<FolderApp>` reading `definition.app` for its name and its commit author.

## Context

`<FolderApp>` (`packages/svelte/src/folder-app.svelte`) takes
`app={manifest}` and shows `app.title` in "Opening <title>…" (`:98`), in
"<title> could not open its folder" (`:86`), and in its refusal (`:101`),
and in a browser it names the folder's commit author with it and with
`${app.id}@localhost` (`:64`).
ADR-0586 deletes the `app` prop, and ADR-0589 deletes `epicenter.app.json`
and its `title`. A Definition carries the app's address as `app`
(ADR-0585).

## Decision

**`<FolderApp>` shows its app's name as the last path segment of
`definition.app`,** wherever it shows `app.title` today:
`github.com/EpicenterHQ/todos` reads "todos", as in "Opening todos…".

**A browser folder's commit author is derived from the same address:** its
name is that segment and its email is `<segment>@localhost`, as in
`todos@localhost`, in place of `${app.id}@localhost`, whose `app.id` is
deleted.

## Consequences

- An app chooses its displayed name by choosing its repository's name;
  there is no second name to keep in step.
- The name shows as the repository spells it, so a name with a space is not
  available.
