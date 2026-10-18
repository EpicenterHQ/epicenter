# 0608. Apps never talk to each other; they share paths

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "the person may change it before the first push" and "After the first push the directory may be renamed freely": a folder's directory name is its repository name, made valid when the folder is made, and is never changed. [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) at the consequence "renaming the folder on disk changes nothing remote": no local rename is offered either.
- **Relates:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) (an app opens any folder by id), [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) (principle 2: a folder is named by its directory), [ADR-0586](0586-you-open-a-folder-never-an-app.md) (a folder's id is its directory name), [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (`epicenter.json` describes tables), [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) (Sync refuses a link), [ADR-0165](0165-browser-origins-contain-independent-epicenter-replicas.md) (each browser origin holds its own replica).
- **Unbuilt:** all of it: `resolve(path)` and `listFolders()` in `@epicenter/folder`; the refusal of a path that escapes the root; `openFolder` refusing an absent folder; reporting a reference to an absent folder, with the offer to clone a named repository; cloning only under the repository's own name, refusing another destination or an existing directory; the desktop folder id as the directory name, with `DataFolderScopes` (`apps/epicenter/src-tauri/src/data_folders.rs:124`) and its `data:<name>` and app-id scopes deleted (ADR-0586); and `field.reference('table')`, which stores a bare file stem within one folder, storing a relative path.

## Context

Apps keep their data in folders under `~/Epicenter` (ADR-0590), and after
ADR-0607 any app opens any folder by its id. Nothing says how one app's data
points at another's, or how an app finds a table it did not make.
`field.reference('pages')` (`packages/definition/src/field/builders.ts:9`)
stores a bare file stem, which names a row only inside the folder that holds
it.

The folder id is not yet one name on both hosts. In a tab it is the
directory name at the OPFS root (`packages/folder/src/browser-adapter.ts`,
header). On the desktop it is a scope, `data:<name>` or an app id, mapped
from directory names only in `DataFolderScopes`
(`apps/epicenter/src-tauri/src/data_folders.rs:124`), which is filled
only when the Folders window lists folders. ADR-0586 already makes the id
the directory name, unbuilt.

A probe of the browser opener resolved `../../crm/people/alex.md` from
`journal/entries/2026-10-17.md` to the folder `crm` and its file
`people/alex.md`, opened `crm` by id, and read the row, with `crm` open or
closed. It refused `../../../etc/passwd` and absolute paths. In a second
origin holding no `crm`, `openFolder({ id: 'crm' })` succeeded with an empty
folder: the library never reports that a folder is absent.

A folder's directory name is not yet one name everywhere either. `epicenter
clone` accepts any destination (`packages/cli/src/repository-commands.ts`),
and a directory renamed after its first push keeps its hosted name
(ADR-0546, ADR-0593). A link by directory name then reaches a different
folder, or none, on another device.

## Decision

> **`~/Epicenter` is one tree of paths. A folder is only where Git starts (a directory holding `epicenter.json` and `.git`). A table is a directory a folder describes. A reference is a relative path. Apps open paths.**

The parenthetical describes a typical folder; principle 2 of ADR-0590 still
decides what a folder is: every real, non-dot directory directly in
`~/Epicenter`, with or without `epicenter.json` (ADR-0585).

**Apps never talk to each other; they share paths.** No app calls another,
sends it an intent, loads it as a plugin, or embeds it. Two apps meet when
both open the same path.

**A reference is a plain relative path, as in a Markdown link, resolved
from the file that holds it.** One that crosses a folder boundary names a
sibling folder by its directory name (principle 2), and the library opens
that folder by its id:

```txt
~/Epicenter/
  journal/                  a folder: epicenter.json, .git/
    entries/2026-10-17.md   links ../../crm/people/alex.md
  crm/                      a folder: epicenter.json, .git/
    people/alex.md          the file that link reaches: folder crm, path people/alex.md
```

- A path that escapes the root (`~/Epicenter` on the desktop, the origin's
  OPFS root in a tab) is refused.
- `field.reference(table)` stores such a relative path instead of a bare
  stem within `table` (`packages/definition/src/field/builders.ts`, read by
  `packages/folder/src/projection.ts:150`). No app's definition calls
  `field.reference` at `e9027cc744`; only tests, READMEs, and the generic
  editor's hint handling name it. The change is a clean break with no stored
  data to rewrite.

**A folder's directory name is its hosted repository's name, on every device
and in every origin.**

- Making a folder gives its directory a valid repository name (ADR-0546's
  rule) that does not begin with `app-` (ADR-0605), and its first push uses
  that name unchanged.
- Cloning a folder uses the repository's name as the directory. It refuses
  a destination of another name, and refuses when a directory of that name
  exists, rather than cloning under another name.
- No local rename is offered, as the hosted service offers none (ADR-0593).

**Whether a person keeps tables in one folder or several is only where Git
boundaries are drawn; apps do not depend on it.** An app finds a table
through the descriptions `listFolders()` returns, used as hints, never by
assuming which folder holds it, and follows existing references as written.

**The library resolves paths and lists folders:**

```txt
openFolder({ id })   exists: opens the folder whose directory name is id; unbuilt: refuses an id naming no directory
resolve(path)        unbuilt: a path from the root, such as crm/people/alex.md, to { folder: 'crm', path: 'people/alex.md' },
                     refused when it escapes the root, and reported absent when no directory crm exists;
                     it checks existence without reading or creating anything; a caller joins a reference to
                     its file's path first
listFolders()        unbuilt: every real, non-dot directory at the root (principle 2), each with its
                     epicenter.json description when it has one, as a hint
```

A folder's id is its directory name on both hosts, so a link resolves the
same way in a tab and on the desktop.

**A reference to a folder that is not there is reported as absent, never
opened empty.** `openFolder` refuses an `id` that names no directory, with
or without a definition, so absence cannot race a listing. Making a folder
stays a separate, explicit act (from its app's template, ADR-0609). The app offers
to clone the absent folder, naming the repository explicitly, such as
`<namespace>/crm` on the hosted service, and cloning it lands under `crm`.

**In a browser, folders are sibling directories at the origin's OPFS root,
so a path resolves as on the desktop, but each app origin holds its own
clones.** OPFS is per origin (ADR-0165): two apps in two tabs hold separate
clones of one folder, which meet only through Sync.

## Consequences

- No folder is renamed, so no reference silently retargets. The cost: one
  root cannot hold two folders with one name, even from two namespaces,
  and a person who wants a new name makes a new repository and deletes the
  old one (ADR-0593), and an agent rewrites the references into it.
- A table's shape becomes a contract other apps read, so changing it
  reaches apps its author does not know.
- In a tab, each app origin clones every folder it follows a link into, so
  one folder can be stored once per origin.
- References within one folder survive any change to which other folders
  exist.

## Considered alternatives

- **Symlinks between folders.** Sync refuses a tree holding a link
  (ADR-0592), and OPFS has none.
- **App-to-app calls, intents, or plugins.** Each pair of apps needs a
  contract and a running peer, where a path needs only files.
- **Embedding one app in another in an iframe.** The embedded app runs on
  its own origin with its own storage, so it sees none of the host app's
  folders, and one app's screen depends on another's deployment.
- **One repository for everything.** Every device clones all of it, one bad
  merge touches all of it, and a person cannot share or template a subset.
