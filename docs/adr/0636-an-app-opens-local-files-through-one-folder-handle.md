# 0636. An app opens local files through one folder handle

- **Status:** Accepted
- **Amended by:** [ADR-0660](0660-native-apps-default-authored-work-to-the-epicenter-root.md) at the standalone native default: authored work defaults to a child of the Epicenter root, while AppData holds app-managed local state.
- **Date:** 2026-10-19
- **Amended by:** [ADR-0643](0643-the-folder-package-owns-its-local-engine.md) at implementation ownership: the shared engine belongs inside `@epicenter/folder`, with one public `Folder` type and no enduring `@epicenter/data` package.
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) only at requiring authored data beneath the Epicenter root: a standalone app may default to a durable directory inside its own app data; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) only at the public `Folder` handle: it names rooted file paths, while a directory remains a physical filesystem location; [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at the planned `@epicenter/data` `open` and `Repository` app surface; and [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at how each runtime selects local data independently of its remote.
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (browser origin and OAuth identity), [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (reader-owned schemas), and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) (later desktop runner).
- **Unbuilt:** migration of older browser data, first-use tracking across native launches, and relocation/reselection workflows. The unified Folder API, native opening, standalone Todos default, and app caller migration are implemented. Current fixed-default launch behavior is recorded in ADR-0647; a missing already-bound directory is refused.

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

**Each handle has one root; a caller may open several handles.** Capture can
work with one folder for its session. An agent or review app can open Capture
and Vault separately. The library imposes no one-folder-per-app or
one-folder-per-window restriction. Opening the same directory through different
schemas changes interpretation, not the saved files or their location.

**The runtime determines the local selection before or during opening.**
These call shapes describe the intended API; they are not implemented exports:

| Runtime | Opening | Selection |
| --- | --- | --- |
| Browser website | `openFolder({ tables })` | This origin's default local data, reopened through a fixed internal key independent of app name, account, and remote. |
| Standalone native app | `openFolder({ directory, tables })` | A directory supplied by that app: its automatic default or a location the person chose. |
| Later desktop runner | `openFolder({ tables })` | The directory the runner selected and granted to this window. |

The default browser call needs no public `local: 'default'` option. It does
not forbid multiple local selections later; an app offering them must make
its selection explicit. The default assumes one ordinary app per web origin;
separately isolated apps need separate origins. A browser folder has path
behavior, but it has no disk directory for Finder or an ordinary agent to open.
Features that require a physical directory must distinguish the runtime's actual
location.

**A native app can open its default without a folder picker.** Its ordinary
launch supplies a durable `work/` directory inside its own operating-system
app-data directory. An app may choose another default or offer chosen locations;
neither a picker nor a recent-folders list is a library requirement. Credentials,
machine preferences, and caches stay outside `work/`. The app shows the document
location and offers **Reveal folder**. Authored work is never disposable cache.

The native identifier may determine this initial default path. It does not own
the data or limit which other directories the app can open. The supplied
directory needs no Epicenter root, universal dataset ID, metadata file, or
registration. A remote, account, or displayed name never substitutes for it.

**A missing established location does not silently become new work.** An app
may create its initial default automatically. Once it has established a location,
it reports that path if the directory disappears; it does not recreate an empty
replacement, open the default instead of a missing chosen directory, or fall
back to browser storage. The app owns the distinction between first use and an
established location. It also owns reselection and any explicit choice to start
new work. This requires no universal data ID or mandatory picker.

Moving a directory does not automatically reconfigure the originating app or
other readers. An app must define its relocation behavior before promising move
support. Reveal exposes the files; it supplies no relocation mechanism.

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
- App-data defaults avoid a first-run picker and a shared-root convention.
  Their files are less visible in the filesystem. Deleting the app-data directory
  also deletes the authored work inside it; Reveal and backup guidance must name
  the actual document directory.
- Browser work reaches an ordinary disk agent through synchronization or export,
  not by handing that agent an IndexedDB key. The browser media/export interface
  remains separate work.
- The word `Folder` describes the handle's rooted paths, not a promise that
  browser data is reachable through operating-system file tools. The shared
  vocabulary preserves that distinction.

## Considered alternatives

- **Expose `@epicenter/data` `Repository` as the app handle.** Makes local
  editing sound dependent on Git and leaves two public opening nouns.
- **Give every local dataset a universal ID and registry.** Adds copy, move,
  collision, and recovery rules without helping a browser reopen its default
  store or a native app reopen a selected directory.
- **Require an app ID or remote ID as the local opening address.** Couples local
  work to software identity or a destination chosen after work already exists.
  Computing an initial native default from an app's platform identity does not
  introduce that addressing rule.
- **Require a picker or folder-management interface in every app.** Repeats UI
  that an app with one automatic default does not need.
- **Restrict every app to one folder forever.** Prevents deliberate use of
  existing data and review across folders without simplifying each handle.
- **Treat browser storage as a disk directory.** Suggests an agent or another
  origin can inspect files that the browser actually keeps private.
