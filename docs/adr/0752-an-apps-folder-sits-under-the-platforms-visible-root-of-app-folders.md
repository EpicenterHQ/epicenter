# 0752. An app's folder sits under the platform's visible root of app folders

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Relates:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) (an app's folder is derived, never stored), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names derive from the site's host), [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (when a phone app is built), [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) (your files are in a folder you can see), [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (what an app's AppData holds).
- **Amended by:** [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at what sits under `~/Epicenter`: another team's apps sit in that team's folder, and every folder is found by its `AGENTS.md`.
- **Unbuilt:** every phone app, and with it a folder in an app's own container; the choice on Android between the app's own storage and a folder granted through the Storage Access Framework.

## Context

On a computer, an app's folder is a path derived from its site under a fixed
library root
([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md),
[ADR-0721](0721-an-apps-folder-is-derived-never-stored.md),
[ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)):
Whispering's is `~/Epicenter/whispering`. Each app also has a place for this
device only, its AppData (`<AppData>/so.epicenter.whispering`), which holds
overrides, caches, requests, and credentials.

[ADR-0751](0751-every-native-app-carries-one-sync-core.md) puts the sync core
in phone apps as well, so a phone app needs a folder for its items. A phone
has no home directory that apps share. iOS gives each app a container the
system does not evict, and the Files app shows the app's documents in it
under "On My iPhone", in a folder named for the app. Apps from one developer
team can share an App Group container; another team's app cannot join it.
Android gives each app its own storage, or a folder the person grants once
through the Storage Access Framework.

## Decision

**An app's folder sits under the root of app folders that the platform
shows a person.** A platform that has such a root supplies it; a computer
has none, so Epicenter names one.

| Platform | Root | Whispering's folder | Supplied by |
| --- | --- | --- | --- |
| macOS, Windows, Linux | `~/Epicenter` | `~/Epicenter/whispering` | Epicenter |
| iOS | the app's container, shown in Files as "On My iPhone" | "On My iPhone > Whispering" | the operating system |
| Android | the app's own storage, or a folder the person grants once | the app's folder there | the operating system |

**AppData never holds items.** It is hidden from the person. It is the
place a reset deletes: deleting an app's AppData signs the app out and
forgets its keys
([ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md)).
A program that found other apps' items in AppData would need a registry of
them or a permission prompt for each. AppData keeps what belongs to this
device: overrides, caches, requests, and credentials.

**A phone keeps one folder per app.** Each app keeps its folder in its own
container and syncs it with its own sign-in
([ADR-0731](0731-every-app-signs-in-as-its-site.md)). No phone has a local
list of folders; across devices, the account's list of repositories is the
index. A shared App Group root for Epicenter's apps waits for the first
phone use that needs another app's data offline.

## Consequences

- On a computer nothing changes: `~/Epicenter` stays the root, and every
  path still derives from the site.
- A person finds a phone app's items in the Files app, next to every other
  app's documents.
- On a phone, no app reads another app's items offline. A library view there
  reads other apps' repositories through the account, online.
- Deleting a phone app deletes its container and the folder in it. Items it
  had synced return from the account; items it had not synced are lost.
- AppData holds nothing a person would look for, so resetting an app never
  deletes what they keep.

## Considered alternatives

- **Items in AppData on every platform.** Hidden from the person, deleted by
  a reset, and reachable by other programs only through a registry or
  permission prompts.
- **An App Group root shared by Epicenter's apps on iOS now.** Lets
  Epicenter's apps read each other's folders offline, which no phone use
  needs yet, and another team's app still cannot join it.
- **A folder the person picks on a computer.** Stores a location, which
  [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) refuses; a
  folder elsewhere is a link inside the root
  ([ADR-0736](0736-a-folder-outside-the-library-is-enrolled-through-a-link-the-person-names.md)).
