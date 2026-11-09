# 0814. One window shows one folder

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at "An app shows one folder at a time, with a folder picker": a window shows one folder, and another folder opens in another window; [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) at an app later opening several folders together: no app does, and views across folders are the library's.
- **Relates:** [ADR-0813](0813-epicenter-is-your-folders-and-apps-are-lenses.md) (apps are lenses), [ADR-0812](0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md) (an app's view), [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) (the library queries every folder), [ADR-0780](0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md) (each surface uses what its platform gives).
- **Unbuilt:** all of it: opening a folder into a window on the desktop, a tab named by the folder's id on the web, and a folder from an app's home on a phone; an app's capabilities made for one folder for the window's life; removing the folder picker.

## Context

Apps and folders are many to many: a folder may be seen by several apps, and an
app may use several folders, such as a person's diary and one shared with a
partner. ADR-0811 gave each app a folder picker, so every app rendered it, held
the current folder as state, and closed one folder to open another. Desktop
systems have long answered the same question for documents: each document opens
in its own window.

## Decision

**A window shows one folder, for its whole life.** An app's code holds exactly
one folder; which folder a window shows is the platform's. Another folder opens
in another window on the desktop, from the app's File menu or from the library;
in another tab on the web, its id in the address; and from the app's home on a
phone, which lists the app's folders.

**No app shows several folders together.** Views across folders, such as every
todo in every folder or a search over everything, are the library's, which
already queries every folder.

**An app developer writes a view and a window over one folder.** Finding
folders, checking fit, making one, opening it, syncing, history, sharing, and
conflicts are the platform's.

## Consequences

- No app has a folder picker or switches folders.
- Two folders are two windows side by side.
- An app cannot mix the data of two folders.
