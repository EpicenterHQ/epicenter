# 0323. Background work runs in the host, and a window is for looking at

- **Status:** Accepted
- **Date:** 2026-09-01
- **Unbuilt:** all of it. Local Mail reconciles from its own window today, and the host runs no application code beyond admitting a data definition.
- **Supersedes:** [ADR-0322](0322-a-person-keeps-applications-current-and-a-hidden-window-is-the-same-window.md) entirely. That record decided a person keeps applications current by having the host start their windows hidden, and it named the one thing it could not settle: whether a hidden WebView keeps running. It does not. Its human half is not carried forward either, because what it rationed turned out to be free.
- **Relates:** [ADR-0327](0327-undelivered-work-is-an-outbox-and-that-is-where-a-failure-appears.md), which decides where a pass outcome lands. It amended this record while it expected a host-side half to write those outcomes; Local Mail then chose to reconcile in the foreground only, so the amendment was withdrawn and this record stands unchanged. Nothing has built a background half, so the detection sentence below is still literally true.
- **Amended by:** [ADR-0328](0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md), which withdraws the per-application "Pause syncing" below. Stopping the work is a machine want, so it is one Pause in the menu bar rather than a feature in each application.
- **Amends:** [ADR-0273](0273-an-epicenter-app-is-an-spa-with-a-namespace-and-background-work-is-a-hidden-window.md) at one decision and one refusal, stated below.
- **Amends:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at the sentence describing what a host does. It serves bundles, brokers credentials, and now runs a declared slice of first-party application code. Its actual refusal, a second convergent plane, is untouched: nothing here opens a store or serves an authority.
- **Relates:** [ADR-0313](0313-a-data-definition-ships-as-typescript-and-a-host-that-needs-one-imports-it.md) (the host already executes first-party application code; this extends a moment into a session), [ADR-0043](0043-an-agent-answers-where-its-capability-lives.md) (work answers where its capability lives), [ADR-0317](0317-local-mail-is-an-epicenter-application-without-a-standalone-cli.md) and [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (both carried this as their remaining unbuilt line), and [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md) (the storage the host already owns)

## Context

An application like Local Mail has work that should continue when nobody is
looking at it: delivering triage a person recorded, and pulling new mail so it
is there when they arrive. ADR-0273 decided that work is a window nobody is
looking at, because then an application's code does not change between the two.

It was measured on macOS, against the real host, and it does not work. A window
was hidden and beat every ten seconds into its own database:

```txt
  00:08:19   first beat
  00:09      window closed, which hides it rather than destroying it
  ...        45 beats, every 11.0s, perfectly even
  00:16:28   last beat            about seven minutes after hiding
             931 seconds of nothing
  00:32:00   window reopened      beats resume instantly
```

The page's clock never restarted across the gap, so it was suspended and
resumed rather than destroyed and reloaded. The host stayed alive throughout, so
this is the system suspending an unwatched WebView rather than the application
being asleep. Starting a window hidden would therefore deliver about seven
minutes of work per launch and then silence, which is worse than not offering
it: a promise that quietly stops.

Two smaller findings came with it. `document.visibilityState` reported `hidden`
on every beat, including after the window was visibly back on screen, so it
cannot be trusted in a window here. And the platform switch that would prevent
the suspension exists but reaches only recent macOS, so building on it would
mean a feature that silently does nothing on Windows and Linux.

## Decision

**An application's background work runs in the Bun host. A window is for looking
at.**

The host is already the right place, and this is less new than it sounds. It
runs from launch to quit and is not a WebView, so nothing suspends it. It
already owns every application's SQLite connection, so a window's `openSqlite`
is a round trip into the very registry the host would use. It already holds
every credential. It already imports first-party application TypeScript
(ADR-0313), which was recorded as a real boundary move when it was made; what
changes here is duration, not the boundary.

**The application's code does not change, because the seam already carries the
difference.** Runtime-specific constructors have browser and desktop leaves.
The host composes the shared core directly, where `openSqlite` is the host's own storage owner and
`secrets` is the native keychain. The same Local Mail package runs in a browser
tab, in a window, or inside the host, and only the binding differs. ADR-0273
wanted the code to stay the same between being watched and not; that survives,
transposed from windows to bindings.

**There is one writer, so there is nothing to arbitrate.** The rule is that a
window writes what a person meant and the host writes what the provider said.
Local Mail's triage comes from a hand in a window; its cache and its cursor come
from Gmail through the reconciler. Wherever a host exists it is the only
provider-facing writer, and in the browser build, where there is none, the
window keeps that role and the `#platform` seam carries the difference.

Local Mail's reconcile claim exists because the writers were a window and a
worker. With one provider-facing writer per runtime, the window stops
reconciling on a timer and starts reading. Its Reconcile control still runs a
pass, because that is a person asking for one and needs no new machinery.

**There is no background permission, because there is nothing to ration.**
ADR-0322 built a manifest field, a settings toggle, a stored answer, and a
login-item coupling, and every part of that existed to price a hundred megabytes
of WebView per application. A timer in a process that is already running costs
nothing, and a permission with no cost behind it is a question asked for no
reason.

**Turning it off is not a permission and not a per-application feature.** This
record first placed it in each application, and ADR-0328 withdrew that: nobody
opens their mail application to stop their laptop from doing work. It is one
Pause for the machine, in the menu bar, and an account a person is finished with
is removed instead (ADR-0320).

**Whether Epicenter itself opens at login is unchanged and separate.** It is one
existing host setting a person controls. This record decides where an
application's work runs while Epicenter is running, and decides nothing about
when Epicenter runs.

**The host runs only what this release imports, and an application cannot ask.**
The table is shaped like `TRUSTED_DEFINITIONS`: an application id and one entry
function, first-party, compiled in. There is no registration call and no runtime
request, and no platform surface answers "am I running in the background", so
nothing can nag and nothing can be granted. An application does of course see
its own background half's work, because that half writes into the application's
own storage and the window reads it (ADR-0327); what it cannot do is ask the
platform about itself.

**A host-side half has no Epicenter Data.** The store is client-owned in every
runtime (ADR-0226, ADR-0227) and the host does not open one, so the host leaf's
`openData` fails rather than pretending. Background work gets SQLite, secrets,
and the network. An application whose background half needs the store is asking
for something this record does not provide, and that is a decision for whoever
needs it.

## Consequences

- The hidden window is never built, on any platform, and no part of this
  depends on undocumented WebView behavior or on a switch that exists only on
  recent macOS.
- Memory stops being the reason a person is asked anything. Three applications
  with background work are three timers, not three WebViews at login.
- One application's background bug now lives in the process that serves every
  application. That is the real price, and it is paid rather than avoided: each
  entry runs supervised, every pass is behind a caught `Result`, and the host
  owns a backoff. The bar is that one application's bad day cannot end the host,
  not that faults are perfectly isolated, because a person running Epicenter has
  the source and can fix what breaks.
- A window and the host can both act on one account during a pass. The work is
  idempotent, so this is safe, but it can duplicate a pull. Removing the
  window's own loop is what makes it rare rather than routine.
- The browser build has no host, so it has no background half, and it says so
  already. That asymmetry is what the `#platform` seam exists to carry.
- Third-party background work is not decided here. The host will not import a
  stranger's module (ADR-0313, ADR-0305), so an application plane that wants
  this needs its own record.
- `document.visibilityState` is not usable in an Epicenter window. Nothing
  should be built on it until that is understood.

## Considered alternatives

- **Disable the platform's background throttling.** Tauri exposes the switch and
  this repository is on a version that has it, but it reaches recent macOS only.
  A background feature that silently does nothing on Windows and Linux is the
  same broken promise this record exists to avoid, sorted by platform instead of
  by time.
- **Keep the window on screen at one pixel, or off screen.** Reliable, and a
  permanent lie to the window server that somebody has to maintain forever.
- **Have the host wake the suspended window on a timer.** The host owns the
  schedule either way, so this pays the cost of host-side work while keeping the
  WebView's fragility and its memory.
- **Drop background work and accept the cost.** The cursor a mail application
  keeps only dies after a week with no synchronization at all, so this would
  harm only a person who has not opened the application in a fortnight, and it
  would cost them one full re-pull. Rejected because the promise was to keep
  delivering a person's triage, not to keep a cursor warm, and because it would
  leave the platform question for the next application that has to poll, wait,
  or watch, with the window option now known to be dead.
- **Let an application register background work at runtime.** Rejected. It makes
  background work something an application declares about itself, and every
  application would, the way every application asks for notifications.
