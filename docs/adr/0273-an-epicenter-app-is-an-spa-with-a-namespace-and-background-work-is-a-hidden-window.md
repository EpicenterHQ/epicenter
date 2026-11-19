# 0273. An Epicenter app is an SPA with a namespace, and background work is a hidden window

- **Status:** Accepted
- **Date:** 2026-08-27
- **Amended by:** ADR-0323 at one decision and one refusal. Withdrawn: that background work is a window nobody is looking at, because a hidden window is suspended after about seven minutes and the measurement is in that record. Withdrawn: "no worker runtime", which a supervised first-party entry in the host plainly is. What stands: no second language, no per-application process, no new sandbox, no per-application route registration, and the reason the window was chosen in the first place, that an application's code does not change, which ADR-0323 keeps by moving the difference into the binding.
- **Superseded in part by:** the above. ADR-0322, which previously amended this record at who chooses, was superseded before it was built and decided nothing that survives.
- **Amends:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) at two points. The one runtime stands; a window may run without being shown, and the client-owned store is what an app MAY use rather than what makes it an app.
- **Amends:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at what the host brokers: an application's own third-party secrets, several per application, and one callback route the host owns so no application registers one.
- **Relates:** [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (a hidden window crosses no process boundary, so it introduces no new surface), ADR-0043 ("Epicenter runs no per-user answering worker", which this keeps true), [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) (the folder namespace), [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (the data namespace).
- **Unbuilt:** starting a window hidden at launch, the OAuth callback route, and the per-application secret store. Hiding on close and building a window hidden already exist.

## Context

Two questions had no written answer, and every design conversation kept running into them.

**What makes something an Epicenter app?** The implicit answer was "it uses the store," and the repository already contradicts it: Local Mail and Local Books ship here, are launched here, and use their own SQLite rather than `@epicenter/data`. Honeycrisp and Whispering are the only store consumers. Treating the store as the membership test would either exile two shipped applications or force a hundred thousand emails through a CRDT to keep them.

**What happens when nobody is looking?** Mail is the case that forces it: signing in with Google is a credential problem the host can already solve, and checking for new mail every few minutes is not. That gap is what actually separates an application you sit in front of from one that has to keep working. The always-on worker line of records circled this repeatedly (ADR-0024, superseded by 0043, superseded by 0047) and each answer was a new runtime with its own lifecycle, sandbox, and crash story.

The desktop host turns out to have already answered it. `WebviewWindowBuilder` takes `.visible(reveal)`, so a window can be built hidden; and closing an application window calls `api.prevent_close()` and `hide()`, so an application that is "closed" is still running. Background execution is a property this host has today, unnamed and therefore unusable on purpose.

## Decision

**An Epicenter app is an SPA that gets a window, an identity, and a namespace. Everything else is optional.**

```txt
  a window        visible, or hidden and still running
  an identity     Epicenter's account, plus a place to keep its own secrets
  a namespace     ~/Epicenter/<workspace>/<app>/ and its data directory
  optionally      the store, sync, restore, and the mirror
```

**The store is not the membership test.** An application may bring its own storage and remain a first-class Epicenter application. What it gives up is what the store provides: synchronization, restore, and the mirror. It may still write its own files under its own namespace and be indexed beside everything else (ADR-0271), because the folder's contract is about files and not about the store.

**Background work is a window nobody is looking at.** No worker runtime, no second language, no per-application process, no new sandbox. The application's own SPA runs, hidden, with the same origin and the same capabilities it has when visible, and its code does not change between the two. What this record adds is the ability to START a window hidden; hiding on close already happens.

**The host holds an application's third-party secrets, several per application.** Signing into three Gmail accounts is three secrets under three labels in the native secure store, not three of anything else. This is a different capability from the Epicenter connection, which remains one at a time (ADR-0262).

**One host-owned OAuth callback, and no application registers a route.** A single `/_epicenter/oauth/callback` correlates the `state` parameter back to whichever application began the flow. The number of accounts is a fact about what an application saved, never about routing.

## Consequences

- Mail becomes possible without inventing a runtime. So does anything else that has to poll, watch, or wait.
- ADR-0043's "Epicenter runs no per-user answering worker" stays true, and the worker line it belongs to may not need a worker at all. A hidden window is the application, not a thing that runs beside it.
- ADR-0021 is unaffected rather than stretched: a hidden window crosses no process boundary, so actions remain the only surface that does.
- Memory is the real price. A WebView costs tens to a hundred megabytes, so three background applications is real resident memory, and an application that wants to run in the background should have to say so rather than defaulting to it.
- Background timers are throttled by the operating system. Fine for a poll measured in minutes; not a scheduler, and nothing here should be sold as one.
- "Which applications run in the background" becomes a person's setting, because it is their memory being spent.
- The extension seams a third-party application eventually receives are exactly these four, and no more, because they are the ones the first-party applications turned out to need. ADR-0227 refused the third-party plane for now; this is the shape it returns to.

## Considered alternatives

- **A worker runtime, one process per application.** Refused. It is a second execution model with its own lifecycle, IPC, sandbox, crash story, and security review, to do something a window already does. The four records that reached for it were each superseded by the next.
- **Nothing: applications run only when open.** Refused, though it remains correct for most of them. An application you sit in front of is the common case and should stay the default; the refusal is only of "and nothing else is possible."
- **Applications register their own loopback routes.** Refused. It makes the host an extension point with a security surface: who may claim which path, what happens when two applications claim one, and whether a claimed route sees the session cookie. One brokered callback delivers the same product outcome with none of it.
- **Requiring the store for membership.** Refused. Two shipped applications already do not use it, and the folder contract they can still satisfy is about files rather than about how an application stores things.
