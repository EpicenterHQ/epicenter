# 0621. Epicenter's library writes only text to a repository in v1

- **Status:** Accepted
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md) and [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md), a blob as a file in its folder and audio kept in the folder but off Git: the library writes no binary file in v1, and Whispering's audio stays outside the repository.
- **Amends:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at "Audio stays on this machine while the folder's `.gitignore` ignores it" and "Whispering's template ships `.gitignore` with `audio/`": Whispering keeps audio in the app's own storage, outside the repository; `.gitignore` deciding what a commit leaves out stands.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`check`), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (rows and row folders).
- **Unbuilt:** all of it: the library refusing a write that is not text; Whispering keeping audio in its own storage. Git LFS pointers with their bytes in an object store come later and are not designed.

## Context

A blob was to be a file in its folder whose bytes travel by Git LFS, with
Epicenter's hosted blob storage as the LFS server
([ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md)).
[ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) then kept
Whispering's audio in the folder's `audio/`, left out of every commit, and
[ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md)
moved that rule into Whispering's template `.gitignore`. No LFS route or
client exists. Every clone of a repository, in a browser
([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md))
or on disk, downloads every version of every file, so a binary committed
once costs every clone.

## Decision

**In v1 the library writes only text: UTF-8 with no NUL byte.** A row's
body and fields, and every file written through `files`, are text, a
`table.json` included
([ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md)).
The library offers no binary write.

**The Git service still accepts any Git content, and `check` does not list
a binary file.** Text only is a rule for what the library writes, not a
defect in what plain Git committed.

**Binary files come later as Git LFS pointers, with their bytes in an object
store.** Nothing of that is built in v1.

**Whispering's audio stays in the app, outside the repository.** A
recording's row may live in the repository; its audio is the app's own
storage on the machine that recorded it.

## Consequences

- Every byte an app writes through the library merges as text.
- An image or a PDF a person adds with plain Git syncs as an ordinary blob,
  and `check` says nothing of it.
- A recording's audio is on one machine only, and the repository never
  holds it.

## Considered alternatives

- **LFS in v1 (ADR-0544).** An LFS server, a client in every host, and an
  object store, before any app needs more than text.
- **Audio in the repository, ignored by `.gitignore` (ADR-0592).** A file
  in the working tree that one line of `.gitignore` decides whether to
  commit, so editing that line commits every recording.
- **Binary files as ordinary Git blobs.** Each one is downloaded by every
  clone, in every tab and on disk, forever.
