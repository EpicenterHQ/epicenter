# 0583. A folder's declaration is published only by the app it is named after

- **Status:** Superseded
- **Date:** 2026-10-17
- **Superseded by:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at all of it: no app publishes `epicenter.json`, a folder is made from its app's template, an app opens a folder with its own definition and no containment check, and `folder.own` is deleted. One `openFolder` per entry and the shell's `window_folder` hand-off stand.
- **Amends:** [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md) at its script openers, `openFolder({ root, definition, git })` and `openDataFolder({ root, git })`: one `openFolder({ root, app?, definition?, git })`. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at its two openers, `openFolder` for an application's own data and `openDataFolder` for a folder whose schema belongs to it: one `openFolder` per entry, and `{ id }` reads the folder's own `epicenter.json`; the rule that only an application's own folder publishes stands. [ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md) at its opener table and the `lens` option: an app reads another folder through its `definition`, with the same containment check. [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) at "the app's own for `openFolder`, the folder's declaration for `openDataFolder`": the app's own in its own folder, the folder's declaration in any other. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "open a handed folder with `openDataFolder({ id, lens })`": the app's `openFolder({ app, definition })` opens the handed folder.

## Context

`@epicenter/folder` had two openers in every entry. `openFolder({ id,
definition })` opened the folder `id` and published `definition` to its
`epicenter.json` before the first write. `openDataFolder({ id, lens? })`
opened a folder with its own `epicenter.json`, never wrote it, and with a
`lens` refused a folder whose declaration did not contain the lens
(ADR-0535, ADR-0538).

The desktop shell hands an installed app's window a folder as
`?folder=<scope>` (ADR-0560): the app's own, or any folder a person chose
"Open in" on. Only `openHandedFolder` in `@epicenter/folder/tauri` read that
parameter and chose between the two openers. The root `openFolder`, which the
root `README.md` teaches, granted the `id` it was given and ignored the
hand-off. An app written from the README published its definition into its
own folder when the person had chosen another one.

## Decision

**A folder's `epicenter.json` is published by the app the folder is named
after, and every other opener reads through its definition.**

An app's own folder is the one named by the app's id: the scope
`so.epicenter.todos` on the desktop, the OPFS directory `so.epicenter.todos`
in a browser, a directory named `so.epicenter.todos` in Bun. "Reads through
its definition" is what ADR-0538 calls a lens: the folder's declaration must
contain the definition (`shapeProblems`), the handle has only the
definition's tables, every write is checked against the folder's own
declaration, `epicenter.json` is never written, and an untracked file the
definition's `local` patterns match is never committed, while a file the
folder already tracks stays tracked (`appLocal` in `git/history.ts`, the
desktop shell's `--app-local` to the `epicenter` CLI).

**On the desktop the shell decides which folder a window opens, never the
page's URL.** The folder plugin records, for each window label, the app the
window runs and the folder it was handed (`Folders::hand`), and answers the
page `window_folder`. The shell hands each installed app's window its folder
as it permits it (`admit_installed_window`), and hands Settings
`so.epicenter` as Epicenter's own; the Folders window runs no app. A page
whose `app` differs from its window's is refused `AppMismatch` before any
grant.

**Each entry exports one opener, `openFolder`, and the definition stays
identity-free.** `defineFolder` still refuses an `id`.

| Call | Which folder | Publishes |
| --- | --- | --- |
| `openFolder({ app, definition })`, desktop | the scope `window_folder` answers, when the window runs `app` | only when that scope is `app` |
| `openFolder({ app, definition })`, browser | the OPFS directory `app` | yes |
| `openFolder({ id })` | `id`, with its own `epicenter.json` | never |
| `openFolder({ id, definition })` | `id`, through `definition` | never |
| `openFolder({ root, app, definition, git })`, Bun | the directory `root` | only when `basename(root)` is `app` |
| `openFolder({ root, git })`, `openFolder({ root, definition, git })`, Bun | the directory `root` | never |

**The handle says which folder it is.** `folder.id` is the scope the shell
granted, the OPFS directory's name, or the Bun directory's name. `folder.own`
is `true` exactly when the handle may publish its definition, decided at
open; publication itself is best effort before the first write. Todos offers
Connect only when `folder.own`; Honeycrisp sets up a missing layout only then.

**A folder that does not contain the definition is `ShapeMismatch`, named.**
Its message names the folder by its directory's name, and an app opener by
its definition's `title`: "Todos cannot open the folder 'Recipes': The folder
declares no 'todos' table." Any other reader's says "The folder 'Recipes' does
not declare what this definition reads: ...".

**In Bun a directory is named by its directory's name, and the name is the
whole test.** The CLI's `isApplicationFolder`
(`packages/cli/src/history-commands.ts`) is stricter: it also requires the
directory to sit directly under the Epicenter folder root and its app to be
installed, which a directory opener is not told. An own directory may get a
repository inside another repository's working tree; any other may not
(ADR-0517).

## Consequences

- The root `openFolder` opens the folder a person chose "Open in" on, with no
  app code beyond `{ app, definition }`. A first-party app and one written from
  the README take the same path. A page that navigated or reloaded opens the
  same folder, and a page cannot open Epicenter's folder as Epicenter.
- Installed apps rebuild against the new shell commands (ADR-0581): the
  shell no longer puts the folder in the window's URL.
- `openDataFolder` (four exports), `openHandedFolder`, `HandedFolder`,
  `OpenDataFolder`, `OpenDataFolderOptions`, `DataFolderOptions`, and the
  `lens` option are deleted. `OpenFolder` is two overloads: a form with a
  definition, typed by it, and `{ id }` alone, which takes no definition type.
- The app opener's handle types `definition` as `FolderDefinition`, since it is
  the app's definition only in the app's own folder; `Folder<T>` defaults its
  second parameter to `FolderDefinition`.
- An app that opens a second folder of its own, such as
  `so.epicenter.todos.work`, no longer publishes there: that folder is not
  named after the app, so it is read through the definition and must already
  declare its tables.
- A Bun script or test that opens a temporary directory as an app's own names
  the directory after the app. `apps/todos/scripts/native.ts` reads any
  checkout not named `so.epicenter.todos` through `todosDefinition`, and says
  so when it refuses an empty one.

## Considered alternatives

- **The handed folder in the window's URL (`?folder=`).** In-app navigation
  drops it, and a page can name any folder its window is permitted into,
  `so.epicenter` included.
- **An `own` option on the opener.** It lets a caller publish into any folder,
  which is the bug this record removes.
- **Keeping `openDataFolder` beside a handed-folder `openFolder`.** Two openers
  that differ only in whether a definition is published is the split the root
  selector got wrong.
- **The CLI's whole `isApplicationFolder` in Bun.** It needs the Epicenter
  folder root and the installed apps, which a directory opener is not given.
