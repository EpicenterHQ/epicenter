# 0540. An app is installed by building its source, and approving a commit trusts it fully

- **Status:** Proposed
- **Date:** 2026-10-15
- **Built:** `epicenter.app.json`; installing from a Git URL or a local path, building, approving, and updating (`apps/epicenter/src-tauri/src/installed_apps.rs`); `approvals.json`; serving installed apps at `/apps/<app-id>/` and opening each in its own window on the folder it is offered on; the Folders window's install, approval, and Update (`apps/epicenter/src/folders/App.svelte`).
- **Unbuilt:** moving Todos and Capture into their own repositories; customizing a built-in app by cloning it (installing a built-in app's id is refused today); a full diff view in the approval (it shows `git log` and `git diff --stat`); removing an installed app from the window; sandboxed builds; an `opens` shape written as TypeScript.

## Context

Installed apps were parked when the Rust folder owner was deleted
([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
Built-in apps live in the Epicenter monorepo and are compiled into the host, so
nobody can change one without building Epicenter.

## Decision

**An app is a Git repository with `epicenter.app.json` at its root.**

```json
{
  "id": "com.example.board",
  "title": "Board",
  "opens": "shape.json",
  "build": "bun run build",
  "output": "dist"
}
```

`opens` is the repository path of the shape of [ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md),
committed as a declaration (`formatDeclaration` of the app's definition), so
Epicenter can match it to folders without building or running the app.
Every app is a Vite single-page app built with a relative `base`; `build` and
`output` default to the values shown.

**Installing an app clones it into `~/Epicenter/Apps/<app-id>/`, then builds
it.** A person pastes a Git URL; Epicenter clones, shows the approval, runs
`bun install --frozen-lockfile --ignore-scripts` and the build, writes the
output to `~/Library/Caches/so.epicenter/builds/<app-id>/<commit>/`, and adds
the row `so.epicenter/apps/<app-id>.md`
([ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md)).
There is no prebuilt download.

**Approval guards code that arrived from elsewhere.** A commit fetched from any
remote runs only after a person approves it, shown its diff. A commit made on
this machine, by the person or an agent, runs without asking: every commit
since the approved one is unreachable from every remote-tracking ref and from
`FETCH_HEAD`, and building it records it as approved. `approvals.json`
records `{ commit, approvedAt }` per app id and nothing else.

**Approving an app trusts it fully.** Building runs its code natively, with the
person's permissions, so no boundary after the build protects anything the
build could not already reach. Every app is served from Epicenter's origin, as
Todos is, and every app window may open any folder.

**Trust covers code, never data.** A folder synced from elsewhere is untrusted
however trusted the app opening it is. The shell's path rule, link refusal,
`run_git` allowlist with hooks disabled, and layout checks stay
([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).

**Customizing an app is committing in its clone.** Updating is fetching
upstream and rebasing. A built-in app is customized by cloning its repository
into `~/Epicenter/Apps/<app-id>/`; the row overrides the built-in.

## Consequences

- Agents write and modify apps in place, with history.
- One origin means installed apps share Web Locks, `BroadcastChannel`, and
  storage with Todos. A malicious approved app can read another app's browser
  storage; it could already read every file during its build.
- Todos and Capture each move into a standalone repository before they can be
  forked.
- **Revisit when** Epicenter runs code it did not build: prebuilt downloads,
  apps opened from a URL, or sandboxed builds. Isolation then protects
  something, and each app needs its own origin.

## Considered alternatives

- **An origin per app** (a port per app, `epicenter-app://<id>/`, or
  `<id>.localhost`). Protects nothing a build has not already exposed.
- **Prebuilt output as the default for others' apps.** Avoids running a build,
  at the cost of a distribution channel; deferred until there is a public
  registry.
- **Approval per folder.** Under full trust, the list guards nothing.
- **Apps as hosted URLs.** No local source for agents to edit, and no offline
  use.
