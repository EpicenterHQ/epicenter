# 0780. A surface uses what its platform gives, and parity is not a goal

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Relates:** [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (offline needs an installed app, which this generalizes), [ADR-0758](0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md) (Epicenter owns only what nothing else can), [ADR-0779](0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md) (a browser recording lands whole).
- **Unbuilt:** the browser recorder of ADR-0779; a check of the browser builds for other machinery that imitates a process outliving the page.

## Context

An app has a desktop build, where a shell process outlives its page, and a
web build, where the page is all there is. Holding the two to the same
guarantees built machinery in the browser to imitate the shell: the
recorder wrote each second of a take into this browser's storage, locked
it, and repaired a half-written file on the next open, because on the
desktop the shell keeps a take through a reload. ADR-0746 had already
answered the same question for offline work: the web is online, and
offline needs an installed app.

## Decision

**Each surface uses what its platform gives natively, and the two builds
need not promise the same things.** A guarantee that needs a process
outliving the page is the installed app's: keeping a recording through a
crash or a closed window, recording in the background, a global shortcut,
and syncing a folder offline. The browser gets what a page has: what it
holds in memory, this browser's storage, the network, and the leave guard
asking before a page with unsaved work closes.

A design that adds machinery to a browser build so that it matches the
desktop names the guarantee it imitates, and is refused unless that
guarantee is the reason the web build exists.

## Consequences

- The browser builds stay small, and their limits are stated rather than
  imitated.
- A person who needs a guarantee the page cannot give uses the desktop app.
- Each app's README says what its web build does not promise.
