# 0608. Apps share data through ordinary files

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "the person may change it before the first push" and "After the first push the directory may be renamed freely": a folder's directory name is its repository name, made valid when the folder is made, and is never changed. [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) at the consequence "renaming the folder on disk changes nothing remote": no local rename is offered either.
- **Amended by:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at "A folder's directory name is its hosted repository's name, on every device and in every origin": a clone lives in a directory of any name.
- **Amended by:** [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at "The library resolves paths and lists folders" and "`openFolder` refuses an `id` that names no directory": the library has no `resolve` or `listFolders`, and `open` returns `undefined` when this origin holds no grant.
- **Relates:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) (an app opens any folder by id), [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) (principle 2: a folder is named by its directory), [ADR-0586](0586-you-open-a-folder-never-an-app.md) (a folder's id is its directory name), [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (`epicenter.json` describes tables), [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) (Sync refuses a link), [ADR-0165](0165-browser-origins-contain-independent-epicenter-replicas.md) (each browser origin holds its own replica).
- **Unbuilt:** client integration over shared file conventions; automatic cross-repository reference resolution and a new reference-field format are deferred.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

Apps keep their data in folders under `~/Epicenter` (ADR-0590), and after
ADR-0607 any app opens any folder by its id. Nothing says how one app's data
points at another's, or how an app finds a table it did not make.
`field.reference('pages')` (`packages/definition/src/field/builders.ts:9`)
stores a bare file stem, which names a row only inside the folder that holds
it.

The folder id is not yet one name on both hosts. In a tab it is the
directory name at the OPFS root (`9d13dd25854e:packages/folder/src/browser-adapter.ts`,
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

**Apps integrate by reading and editing shared file formats.**
Two apps need no running peer, intent protocol, or embedded interface to
use the same files. A schema states what one reader expects; it grants no
ownership over the table or another app's data.

**Paths within opened data are relative to that data's root.**
They address files available through that handle. A Markdown link remains
literal content and can be interpreted relative to its containing file by
an app that follows it. A path conveys no permission to another repository.

**Cross-repository reference navigation is deferred.**
Clone directory names are freely chosen under ADR-0612. A link naming a
sibling directory therefore has no automatic portability guarantee across
machines or web origins. The core API has no resolve or listFolders operation
under ADR-0626. An app needs a separately designed destination and access
contract before automatically opening another repository.

**Existing record-reference IDs remain unchanged for the first release.**
The earlier proposal for field.reference to store relative paths instead
of bare record IDs is deferred. It introduces no stored-field migration.
Ordinary Markdown links can remain in files without acquiring that new
reference-field meaning.

## Consequences

- Apps opening one disk folder see its files. Separate web origins hold
  independent copies and exchange changes through synchronization.
- A hosted repository ID, its label, and a clone's directory name are
  different values. No fixed ~/Epicenter tree is a universal address space.
- Moving a table to another repository changes the data and access boundary;
  the library does not promise that all existing references keep resolving.

## Considered alternatives

- **One globally fixed directory name per repository.** Conflicts with
  freely named clones and does not supply cross-origin permissions.
- **Replace reference IDs with relative paths in the naming pass.** Changes
  stored data before cross-repository navigation has been designed.
