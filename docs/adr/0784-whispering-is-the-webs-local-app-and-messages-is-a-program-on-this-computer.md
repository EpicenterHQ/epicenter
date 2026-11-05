# 0784. Whispering is the web's local app, and Messages is a program on this computer

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) at "A web app holds no unsent work. An online write lands or fails in front of the person": a write waits in the page until it lands, behind the leave guard (ADR-0775); [ADR-0781](0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md) at "Whispering's service worker registers only outside a Tauri shell": the shared offline module decides it, and the app holds no platform branch.
- **Relates:** [ADR-0780](0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md) (each surface uses what its platform gives), [ADR-0779](0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md) (a browser recording lands whole), [ADR-0701](0701-apps-run-as-separate-programs.md) (apps run as separate programs).
- **Amended by:** [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) at Whispering being the web's local app, its service worker, and browser storage: Whispering's web build is online, and no web app keeps browser storage or a service worker.
- **Unbuilt:** `@epicenter/vite-config/offline` registering its worker only outside a Tauri shell, with Kit's registration off; deleting Messages' service worker, its manifest, its use of this browser's storage, and its reopen-offline test, and keeping its drafts in a directory its local program owns; browser storage called from the page, without its dedicated worker, if WebKit writes from the page (kept behind the worker otherwise).

## Context

Two web builds cached their page in a service worker so that a page loaded
once reopens offline (decision 85). Whispering's web build is local for
good: it keeps its recordings in this browser's storage and never opens a
repository, so reopening offline lets a person record with no network, and
the worker holds no data. Messages is not a web page in that sense: it is a
program run on the computer where Beeper Desktop runs, whose local server
serves the page at `127.0.0.1:5188` and answers through the CLI. Its worker
only reopened the page while its own server was down, and its drafts lived
in the browser storage of a local origin the browser may evict, while the
program serving the page has the disk. Browser storage sat behind a
dedicated worker because only a worker can hold the synchronous file handle
that appending needed, and ADR-0779 removed appending.

## Decision

**Whispering is the web's one local app.** Its web build keeps its service
worker, which caches the built page and nothing else, so it reopens and
records with no network. The shared offline module registers the worker
only outside a Tauri shell; the app holds no branch on the platform.

**Messages is a program on this computer.** Its drafts live in a directory
its local program owns, reached through that program; it has no service
worker, no manifest, and no browser storage.

**Browser storage is called from the page** when WebKit writes and moves
files from the page, and stays behind its worker where it does not; the
end-to-end suites in WebKit decide it.

**A web write waits in the page until it lands** (ADR-0775), behind the
leave guard; ADR-0746's "a web app holds no unsent work" no longer holds.

## Consequences

- Whispering is the only app that uses this browser's storage.
- Messages' drafts survive the browser clearing a local origin's storage.
- Browser storage loses its worker protocol and the failure of its worker,
  where WebKit allows.
