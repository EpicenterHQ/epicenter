# 0560. An app's manifest only names it, and every installed app is offered on every folder

- **Status:** Superseded
- **Date:** 2026-10-16
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the full desktop app platform; only a local built-app runner over chosen data repositories remains, without source installation, build approvals, or general native services.
- **Amends:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at its manifest block, the `opens` paragraph with its committed shape and its reason "so Epicenter can match it to folders without building or running the app", and the defaults of `build` and `output`, while installing, approval, trust, and serving stand.
- **Amends:** [ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md) at the consequence that the Folders window derives "Open in" from the shapes of installed apps, and at "the Folders window shows it as able to edit only": the Folders window reads no shape, the app's own window shows that it can only edit, and the lens check stands.
- **Amends:** [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at "`opens`, `build`, and `output` in `epicenter.app.json` are relative to that folder": the manifest is `id` and `title`, and the build is `bun run build:installed` in the folder, writing `dist/`.
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at the `apps` row's "the shape it opens": no shape leaves the app.
- **Amended by:** [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) at "open a handed folder with `openDataFolder({ id, lens })`": an app's `openFolder({ app, definition })` opens the folder the shell handed its window, through its definition unless it is the app's own.
- **Amended by:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "the app's lens decides" and Whispering's mismatch refusal: an app opens any folder it is handed with its own definition, and rows that do not fit read as invalid rows.
- **Amended by:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) at "The Folders window offers every installed app that can run on every data folder": a new opening chooses the app a folder's `epicenter.json` names.
- **Amended by:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at `epicenter.app.json` and `bun run build:installed` in the folder: there is no manifest and no build on the person's machine.
- **Amended by:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at "Epicenter builds every app with `bun run build:installed` in its folder and keeps `dist/`": Epicenter builds every app with `bun run build` at its repository's root, writing `dist/`.
- **Unbuilt:** marking an app and folder pair that refused once, so "Open in" stops offering a pair that will refuse again.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

[ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)
made `epicenter.app.json` five fields:

```json
{
  "id": "so.epicenter.todos",
  "title": "Todos",
  "opens": "shape.json",
  "build": "bun run build:installed",
  "output": "dist"
}
```

`opens` named a committed `shape.json`, `formatDeclaration` of the app's
definition. `inspect` in `f16c69134b49:apps/epicenter/src-tauri/src/installed_apps.rs` read
it from the clone and returned it as `InstalledApp.opens`; `installedOpeners`
and `openersOf` in `apps/epicenter/src/folders/openers.ts` offered an app
under "Open in" only on a folder whose `epicenter.json` contained that shape,
by `shapeProblems` from `@epicenter/definition`. Each of Todos, Capture,
<!-- doc-path-check: ignore-next-line -->
Whispering, and Honeycrisp carried `shape.json`, a `scripts/shape.ts` that
<!-- doc-path-check: ignore-next-line -->
wrote it, a `scripts/shape.test.ts` that failed when it drifted from the
definition, and a `shape` script; Whispering also carried
`tsconfig.scripts.json` for the one script. All four manifests set `build`
and `output` to the same two values.

The match was a second copy of a check the app already makes. Todos, Capture,
and Honeycrisp open a handed folder with `openDataFolder({ id, lens })`
([ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md)),
which refuses a folder whose declaration lacks the lens with `ShapeMismatch`,
listing each missing table and field; each app's leaf names the folder in the
message: "Todos cannot open the folder 'Recipes': The folder declares no
'todos' table." Whispering's desktop workspace opened `WHISPERING_FOLDER_ID`
whatever `?folder=` said. The committed shape could also lie: a commit in the
clone that changed the definition was matched against the old `shape.json`
until someone ran `bun run shape`.

The id and title are read before anything of the app runs. `list_repository`
reads each manifest with `git cat-file blob` from a clone made with
`--no-checkout --filter=blob:none`; `install` names `Apps/<app-id>/` from the
id; the approval screen says "Approve {title}?". The id appears in no
definition, since `defineFolder` refuses one.

## Decision

**`epicenter.app.json` holds `id` and `title` and nothing else.**

```json
{ "id": "so.epicenter.todos", "title": "Todos" }
```

`parse_manifest` refuses a missing field and any other field, `opens`, `build`,
and `output` included, with the field named in the error.

**Epicenter builds every app with `bun run build:installed` in its folder and
keeps `dist/`.** The script stays in the app's `package.json`, where a person
runs it to reproduce an installed build.

**The Folders window offers every installed app that can run on every data
folder, and the app's lens decides.** `installedOpeners` returns every app in
the `ready` or `unbuilt` state, by title, and each folder offers all of them as
"Open in <app>" or "Open with…". The app opens the handed folder through
`openDataFolder({ id, lens })`, which refuses a folder that does not contain
its shape. `InstalledApp` has no `opens`, and the shell reads no shape. An
app whose lens cannot add rows shows that in its own window, not in the
Folders window.
Whispering's desktop workspace (`caf928c446fc:apps/whispering/src/lib/workspace/desktop.ts`)
opens a handed folder the same way, refuses a mismatch with "Whispering cannot
open the folder '<name>': …", and records into the scope it opened
(`Workspace.folderId`).

**Each app imports its id from its own `epicenter.app.json`.**
`TODOS_FOLDER_ID`, `CAPTURE_FOLDER_ID`, `WHISPERING_FOLDER_ID`,
`HONEYCRISP_FOLDER_ID`, and Todos's auth `appId` read `manifest.id`.
`APPS.TODOS`, `APPS.CAPTURE`, `APPS.WHISPERING`, and `APPS.HONEYCRISP` in
`@epicenter/constants/apps` carry no `id`.

## Consequences

- An app is offered as soon as it is installed and approved, built or not.
  Opening an `unbuilt` app builds it first.
- A folder that does not fit an app still offers it. Choosing it opens the
  app's window, which shows the refusal naming the folder and what is missing.
- "Open in" cannot drift from the code that runs, since the app's own lens is
  the only check.
- `shapeProblems` and `schemaContainment` stay in `@epicenter/definition`;
  `openDataFolder`'s lens is their caller.
<!-- doc-path-check: ignore-next-line -->
- Deleted: `shape.json`, `scripts/shape.ts`, and `scripts/shape.test.ts` in
  each of the four apps (12 files), the four `shape` scripts, Whispering's
  `tsconfig.scripts.json`, the manifest's `opens`, `build`, and `output` with
  `DEFAULT_BUILD`, `DEFAULT_OUTPUT`, and the shell command line,
  `InstalledApp.opens`, `openersOf` and `declarationContains`, and the
  first-party app ids written in `@epicenter/constants/apps` and in each app's
  source.
- The Unbuilt item of ADR-0540, "an `opens` shape written as TypeScript", is
  void: no shape leaves the app.

## Considered alternatives

- **A shape the build writes, `dist/epicenter.shape.json`**, from the app's
  definition through a Vite plugin in `@epicenter/vite-config`. A plugin and a
  file to keep a check the lens already makes, and an app missing from "Open
  in" until its first build succeeds, or after a cache is wiped. Its name
  would have been `epicenter.shape.json`: `epicenter.json` would make a build
  output look like a data folder to the epicenter CLI and to agents, a generic
  `.config.json` breaks the `epicenter.*.json` pattern of `epicenter.json` and
  `epicenter.app.json`, and renaming the data folder's `epicenter.json` is a
  migration of every folder for one name.
- **The app's own folder's `epicenter.json`**, which `openFolder` publishes on
  first write. A folder's declaration is not the app's needs: it may come from
  another version of the app through sync, may declare tables the app does not
  read, and does not exist until the app first writes.
- **A committed shape (ADR-0540).** Drifts from the definition between
  `bun run shape` runs.
- **The manifest as a key in `package.json`.** Discovery by file name needs
  one blob per app: 548 bytes over 4 files in this repository. Every
  `package.json` would have to be fetched and parsed, about 41 KB over about
  30 files, and the npm `name` is not the app id.
- **The id or title from the definition.** Both are read before approval;
  reading them from TypeScript runs the app's code before a person approves it.
- **One build for the browser and Epicenter.** Todos, Capture, and Honeycrisp
  choose their `#platform` leaves and folder adapter at build time
  ([ADR-0391](0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md)),
  so the installed build stays its own.
