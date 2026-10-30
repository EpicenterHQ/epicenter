# Files

Files shows any repository as folders and files, and is where a link falls
back when its own app is not installed
([ADR-0694](../../docs/adr/0694-installing-an-app-is-trusting-it.md)). It is
a first-party app at `files.epicenter.so` with no collections of its own: it
reads and writes every file through the plain file API, `repo.files`
([`@epicenter/repository`](../../packages/repository#every-file-by-its-path)).
So it shows every file, whichever app wrote it, and files in no collection
at all.

This package exports its manifest (`@epicenter/files`) and its bundle
(`@epicenter/files/bundle`: `mount`, from `mountSvelte`). A new device
installs it with Todos and Honeycrisp, and every repository's page lists it
([`apps/web`](../web)).

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
Licensed under AGPL-3.0-or-later.

## What its path names

| Path | Shows |
| --- | --- |
| `/` | The repository's root folder. |
| `/<folder>/` | That folder: the trailing `/` makes it one. |
| `/<file>` | That file, in its folder. |

Each segment is encoded (`pathOfFile`, `pathOfFolder` in `src/tree.ts`).
Git keeps no folders, so a folder is the shared prefix of the files under
it, and one with no file under it does not exist. A link to an app that is
not installed opens the same path here: Honeycrisp's
`/notes/<stem>.md` is a file path in Files too.

## What it does

- **Browse.** The folder shows its folders and files, and marks a file that
  is not yet sent or is held here with its reason.
- **Edit notes.** A Markdown (`.md`) file opens in the source editor
  (`<SourceEditor>` from `@epicenter/svelte`), with its exact text as the
  repository holds it, saved as the person types. Its status says whether the
  frontmatter parses.
- **View files.** Other files store bytes through Git LFS. Images, audio, and
  video open in media views; other types have a download link. Files fetch
  missing bytes from the server when available, with a retry for temporary
  failures. The displayed path can be copied into a note link.
- **Create note.** This makes a new Markdown file in the folder shown. The name may hold
  `/`, which makes folders. The new file is refused when a file or folder is
  already there, by any spelling.
- **Add file.** Pick a file from the device to add it under the folder shown.
  A picked `.md` file becomes a text note; every other file is stored as
  bytes. The new file opens at its linkable path. Existing names, size limits,
  storage limits, and repository availability are reported in the folder.
- **Rename.** This is a delete and a write in one transaction. It runs once
  the editor has saved everything typed, so the rename carries it. A rename
  onto an existing file is refused. Renaming keeps notes as `.md` and files
  of bytes as non-notes.
- **Delete.** This asks first, then returns to the folder.

## Checks

From `apps/files`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | The package and its tests. |
| `bun run test` | `tree.ts`, then `test:dom`. |
| `bun run test:dom` | The bundle mounted through its `mount`, as the shell mounts it, over the repository API on a replica in this process. |

The browser tests are the shell's: `apps/web/browser-tests/files/` covers
two profiles syncing notes through create, edit, rename, delete and reload,
plus a PNG added in one profile and decoded in the other.
