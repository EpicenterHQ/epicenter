# 0232. A page lifetime is one auth generation, and a permanently denied sync stops for good

- **Status:** Superseded
- **Date:** 2026-08-10
- **Superseded by:** [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md): a credential refusal is decided locally with nothing on the wire, so the driver reports it as data and keeps dialling instead of stopping, and once it never stops there is nothing for a reload on auth change to restart.
- **Supersedes:** [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md) (the connection is the boot decision: one connect call): its mechanism (`model.connect(toConnection(auth, nodeId))`) died with the workspace stack in ADR-0227, and `toConnection` survived as an orphan. Its principle, that the boot-time auth snapshot is the one connection decision, is carried forward here in store terms.
- **Amends:** [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md): its final consequence said parking and resuming properly needs a signal in the `SyncDial` contract. Half of that stands: the contract gains a signal (`denied`). The other half is refused: there is no parked state and no resume, because resuming is a reload.
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md) (sign-in is an enhancement, never a door), [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md) (desktop identity is immutable per process generation; account changes relaunch), [ADR-0222](0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md) (the host says how to make a socket, the library says what to do with one)

## Context

ADR-0230 collapsed the auth client contract to one shape: every client offers
`openWebSocket`, and a model that cannot sync rejects with an
`OpenWebSocketDenial` whose `permanence` says whether a retry could ever help.
It left one thing broken and named it: Honeycrisp's dial reported every
rejection as `closed()`, so the sync driver retried a permanent refusal on
backoff forever. A signed-out browser tab and the credential-free desktop
window (which boots signed-in but holds no credential by design, ADR-0155)
each burned a rejected dial and a background-error report every thirty
seconds, for the lifetime of the page, with no path to ever succeeding.

The repair everyone assumed was a parked state: teach the shared driver to
stop on permanent denial and resume when `auth.onStateChange` says a
credential arrived. That shape asks the driver to own two unlike questions,
"is the network temporarily unavailable?" and "is this session allowed to
sync?", and it needs a wake-signal seam threaded from auth into
`packages/data`, which is exactly the `onReconnectSignal` plumbing the deleted
workspace stack carried.

Meanwhile the codebase already held the other answer, unwired.
`reloadOnPrincipalChange` and `toConnection` sat in `@epicenter/svelte/auth`
with zero production callers (their consumers died in the ADR-0227 clean
break; Honeycrisp never mounted them). And the desktop host already treats
identity as immutable per process generation: sign-in, sign-out and instance
selection relaunch the application (ADR-0155). Nothing anywhere resumes sync
in place.

## Decision

A running app belongs to one principal and one credential posture: one auth
generation, whose lifetime is the page's. Three rules make that whole:

1. **The first dial answers whether this generation syncs.** Sync attaches
   whenever the build has an auth client, without inspecting auth state up
   front. An `openWebSocket` rejection with `permanence: 'permanent'` is
   reported to the driver as `denied`, a new `SyncAttempt` callback beside
   `closed`: the driver releases everything it holds (socket, timers, store
   subscription, client) and never dials again, and its status reports
   `denied: true`, which surfaces render exactly like sync not existing.
   `permanence: 'transient'` and ordinary socket loss stay `closed`: back off
   and retry, forever.

2. **The driver owns transport failure only.** There is no parked state, no
   auth awareness, and no wake signal in `packages/data`. `denied` is
   transport vocabulary ("no socket this host can make will ever succeed"),
   and the host's one judgment (ADR-0222 unchanged) is translating the
   denial's `permanence` into `denied` versus `closed`.

3. **A new credential means a new generation, by reload.**
   `reloadOnAuthChange` (the rewritten, now actually mounted
   `reloadOnPrincipalChange`) reloads the page when the principal identity
   changes (sign in, sign out, switch) and when a credential is acquired
   without an identity change (`reauth-required` to `signed-in`, always a
   user action). It deliberately does not reload when `signed-in` degrades to
   `reauth-required`: that is the one transition that can fire spontaneously
   mid-keystroke, and the degraded generation keeps working locally while its
   sync stops itself at the next denied dial. The next boot re-reads
   `auth.state` and constructs the correct replica and connection from
   scratch.

Transient UI state does not survive an auth change. That is a product
decision, not a limitation: an account change replaces the app's whole
universe, and rebuilding it from the boot snapshot is simpler than proving
every piece of live state swaps correctly.

## Consequences

- The system is explainable in one sentence: a page either syncs or it does
  not, decided by its first dial, and any auth change that could change the
  answer starts a new page.
- The scenario table, spelled out: startup signed out dials once, is denied,
  and goes quiet; the credential-free desktop window does the same (its
  account actions relaunch the process, so `reloadOnAuthChange` is a mounted
  no-op there); browser sign-in and sign-out reload into the right
  composition; server-side revocation degrades state, the next dial stops
  sync, and the popover's Reconnect reloads into a syncing generation;
  offline boot with a good grant keeps retrying as transient and connects
  when the network returns.
- `toConnection` is deleted with its `ConnectionConfig` and `onReconnectSignal`
  shape: the last residue of the superseded workspace boot API, and the seam a
  parked driver would have needed.
- The driver hardens one real defect the new tests exposed: a `closed` or
  `denied` reported synchronously from inside `dial()` used to resurrect the
  abandoned attempt when the teardown was assigned, wedging the driver.
- The permanent denial is not reported as a background error. It is the
  ordinary signed-out lifecycle, and the thirty-second warn-spam is gone.
- The trade-off, stated plainly: a generation that is permanently denied never
  probes again, so a repair that changes no auth state (impossible today; every
  repair path lands in `auth.state`) would go unnoticed until the next reload.
  We accept that because every credential the system can acquire announces
  itself through `onStateChange`, which is the reload trigger.

## Considered alternatives

- **Park in the driver, resume on `auth.onStateChange`.** The assumed fix.
  Rejected: it makes the shared driver own session admission as well as
  transport, requires a wake-signal seam from auth into `packages/data`, and
  rebuilds `onReconnectSignal` from the deleted stack, all to preserve
  transient UI state across a transition the product does not need it to
  survive.
- **Keep backoff-forever and exclude non-syncing builds statically.** A
  `#platform` flag could stop the desktop window from attaching sync, and a
  boot check on `auth.state` could cover signed-out. Rejected: two mechanisms
  where the first dial already answers both, a new platform seam for a fact
  the runtime denial states, and mid-session revocation still retries a
  refusal forever.
- **Reload on every auth transition, including degradation.** Symmetric and
  slightly simpler to state, but it reloads the page under the user's hands
  for a background token expiry, buying nothing: the degraded generation is
  fully functional locally. The asymmetry is honest: losing a credential
  degrades in place; gaining one rebuilds.
