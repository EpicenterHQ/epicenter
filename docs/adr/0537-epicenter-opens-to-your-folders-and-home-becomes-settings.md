# 0537. Epicenter opens to your folders, and Home becomes Settings

- **Status:** Proposed
- **Date:** 2026-10-15
- **Amends:** [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md): its raw view, deleted when the host stopped owning application data ([ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md)), returns as the Folders window, and Epicenter opens to it instead of to Home's Apps pane.
- **Unbuilt:** opening to the Folders window; the "Open in" buttons; renaming Home to Settings and removing its Apps pane.

## Context

ADR-0209 decided that Epicenter shows the data raw, applications are the
crafted views, and the operating system is the launcher. Its raw view read a
replica the host owned, and ADR-0226 deleted it when the host stopped owning
application data. What remained was Home (`apps/epicenter/src/ui/App.svelte`):
three tabs, Apps (a launcher fed by `/api/apps`), Chat, and Settings.

Data now lives in folders on disk ([ADR-0534](0534-data-folders-are-the-only-data-model.md)),
and the Folders window (`apps/epicenter/src/folders/`, label `folders`) lists
every folder under the Epicenter root that holds an `epicenter.json`, opens one
with its own declaration ([ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md)),
and edits its rows. That is the raw view, with something to show again.

## Decision

**Opening Epicenter shows the Folders window.** Launching Epicenter, reopening
it from the Dock, and `epicenter://` without a path open the window labelled
`folders`. It lists each data folder by its title, and each row offers the apps
that can open that folder ([ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md))
as "Open in Todos" and, when more than one matches, "Open with…". Clicking the
folder's name opens it in the grid in place.

**Home becomes Settings.** The window labelled `home` keeps Chat and Settings
and loses its Apps pane. It is opened from the Folders window and the tray, and
keeps model administration ([ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md)),
which the Folders window does not hold. The two windows keep separate
capabilities: `folders` holds folder access, `home` holds model administration
and launching.

**An app without a folder is listed under "Apps" in the Folders window.**

## Consequences

- The first thing a person sees is their data, which is what ADR-0209 said
  Epicenter is.
- Launching moves next to the thing launched: an app is reached through the
  folder it opens.
- `/api/apps`, `Applications.svelte`, and Home's Apps tab are deleted once the
  Folders window lists apps.
- One more window than today: Settings is no longer the window Epicenter opens
  to.

## Considered alternatives

- **The Folders window becomes Home, one window.** One window would hold every
  folder and model administration together, the union of authority ADR-0209 and
  ADR-0180 avoided.
- **Keep Home as the front, with Folders as one app.** Contradicts ADR-0209: the
  data is one click away from the window meant to show it.
