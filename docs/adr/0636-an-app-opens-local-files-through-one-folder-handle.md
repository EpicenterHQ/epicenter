# 0636. An app opens local files through one folder handle

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) only at the public `Folder` handle: it names a rooted set of file paths, while a directory remains a physical filesystem location; [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at the planned `@epicenter/data` `open` and `Repository` app surface; and [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at how each runtime selects local data without deriving its identity from a remote.
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (browser origin and OAuth identity), [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (reader-owned schemas), and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) (later desktop runner).
- **Unbuilt:** the public `openFolder` contract over the new engine, a stable browser default and migration from current app storage, standalone native directory opening, and migration of app callers. The later runner remains deferred.

## Context

ADR-0633 lets an app save before sign-in, but local data still needs a stable
selection that sign-in or a remote change cannot redirect. ADR-0626 calls the
planned handle a `Repository` from `@epicenter/data`. A real directory can
contain files before Git is initialized. The new browser engine already opens
an IndexedDB store by a local key but exports no app-facing opening API.

The current `@epicenter/folder` has `openFolder`, `files`, and `tables`, along
with app-named folders and declaration publication being retired. Browser
IndexedDB is not an operating-system directory. It can still present one
rooted set of relative file paths to an app.

## Decision

**`@epicenter/folder` provides the one public folder handle for apps.** A
`Folder` is an opened, rooted set of local file paths and contents. The handle
exposes `files`, table views made from caller-supplied schemas, changes,
synchronization status, and `close`. A table interprets Markdown files; its
schema neither identifies the local data nor controls writes. Opening does
not authenticate, select a remote, create Git history, or write a schema file.
The new engine sits behind this contract rather than becoming a second public
app package.

**The runtime determines the local selection before or during opening.**
These call shapes describe the intended API; they are not implemented exports:

| Runtime | Opening | Selection |
| --- | --- | --- |
| Browser website | `openFolder({ tables })` | This origin's default local data, reopened through a fixed internal key independent of app name, account, and remote. |
| Standalone native app | `openFolder({ directory, tables })` | A directory the person chose anywhere the app can access. The app may remember that choice in machine-local settings. |
| Later desktop runner | `openFolder({ tables })` | The directory the runner selected and granted to this window. |

The default browser call needs no public `local: 'default'` option. It does
not forbid multiple local selections later; an app offering them must make
its selection explicit. A browser folder has path behavior, but it has no
disk directory for Finder or an ordinary agent to open. Features that require
a physical directory must distinguish the runtime's actual location.

On native targets, the selected directory is the local opening address. It
needs no Epicenter root, app name, universal dataset ID, or metadata file.
Moving it may require selecting it again. A hosted repository ID, displayed
name, web origin, or account never substitutes for that selection.

**A later runner selects at its own boundary.** Its native adapter must open
only the directory granted to that window and report a missing or refused
grant; it must not fall back to browser storage. The runner's picker,
remembered-selection policy, and web-origin isolation belong to its later
design. A shared web origin does not itself grant access to a disk directory.

## Consequences

- Apps read and save before Git or sign-in through one file and table API.
- A browser's default local data can survive sign-in, sign-out, and a changed
  remote without gaining a public UUID or a required marker file.
- Two apps may deliberately open one disk directory through different schemas.
  Different browser origins keep separate local copies even if they later
  connect to the same hosted repository.
- The word `Folder` describes the handle's rooted paths, not a promise that
  browser data is reachable through operating-system file tools. If this
  proposal is accepted, the shared vocabulary must state that distinction.

## Considered alternatives

- **Expose `@epicenter/data` `Repository` as the app handle.** Makes local
  editing sound dependent on Git and leaves two public opening nouns.
- **Give every local dataset a universal ID and registry.** Adds copy, move,
  collision, and recovery rules without helping a browser reopen its default
  store or a native app reopen a selected directory.
- **Use an app ID or remote ID to select local data.** Couples local work to
  software identity or a destination chosen after work already exists.
- **Treat browser storage as a disk directory.** Suggests an agent or another
  origin can inspect files that the browser actually keeps private.
