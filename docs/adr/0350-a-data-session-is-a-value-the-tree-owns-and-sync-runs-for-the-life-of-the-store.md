# 0350. A data session is a value the tree owns, and sync runs for the life of the store

- **Status:** Accepted
- **Amended by:** [ADR-0353](0353-a-data-session-keeps-one-account-for-its-entire-lifetime.md) at the session key and transport lifetime: the tree keys on Account identity and passes that Account to `open(account)`. Retirement is permanent for that Account; the session still owns sync and teardown. [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at session coordination and sync: local and account scopes may coexist, and only account sessions run sync.
- **Date:** 2026-09-05
- **Supersedes:** [ADR-0344](0344-an-epicenter-owns-one-data-session-and-opening-it-is-a-verb.md) at its mechanism (the four-state `EpicenterState`, `open()` as a promise, `state`, `onStateChange`, and `eraseReplica` on the handle; its title and its inert constructor stand), and [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md) (a page lifetime is one auth generation, and a permanently denied sync stops for good). Both of its rules are withdrawn, and the second is why the first existed. A credential refusal is decided locally, so the driver never had to stop, and once it does not stop there is nothing a reload was for.
- **Amends:** [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md) at its mechanism only. The `denied` signal ADR-0232 added to the `SyncDial` contract is deleted, `permanence` is deleted, and its open question about parking and resuming is answered by there being nothing to park. "Denies permanently" now means the model refuses from a literal on every dial, reported as `'no-credential-model'` and dialled again. Its rule stands and is what this record leans on: every client offers `openWebSocket`, and whether a client can sync is answered at runtime rather than by a type.
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md) (superseded at its title by ADR-0342's rejection; what this leans on is its one composition shape), [ADR-0222](0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md) (the host says how to make a socket, the library says what to do with one), [ADR-0340](0340-an-opened-store-knows-its-own-address-and-its-own-connection.md) (a store answers `sync.status()` for whatever connection drives it), [ADR-0344](0344-an-epicenter-owns-one-data-session-and-opening-it-is-a-verb.md) (opening is a verb), [ADR-0345](0345-the-root-layout-is-chrome-and-the-callback-decides-what-may-live-above-a-page.md) (which node boots an app)
- **Built.** `epicenter.open()` is synchronous and answers a `DataSession`, all three applications key one session component on the principal, and the reload gate and `fromEpicenter` are deleted. The driver half is across `packages/sync`, `packages/auth`, and `packages/data/src/sync`.

## Context

ADR-0232 answered a real bug. Honeycrisp reported every rejected dial as
`closed()`, so a signed-out tab and the credential-free desktop window each
burned a rejected dial and a background-error report every thirty seconds
forever. It fixed that with a stop: `OpenWebSocketDenial` carried a
`permanence`, a `'permanent'` one reached the driver through a second callback
named `denied()`, and the driver released its socket, its timers, its store
subscription and its client and never dialled again.

A driver that stops needs something to start it again, and that is where the
rest of the shape came from. `reloadOnAuthChange` reloaded the document when
the principal changed and when a credential was acquired, because only a fresh
page dials. The page lifetime became "one auth generation", a third thing
called a generation beside the store's numbered history and the driver's dial
counter. Boot reads had to be deliberately untracked, and said so at every call
site, because a tracked read would repaint into a dying document.

The premise underneath all of it is wrong, and the code says so. In
`oauth-credential-authority.ts`, `authorize()` returns a denial when
`persistedAuth === null || networkAuthPaused`, before it constructs a request:
signed out and reauth-required are both decided from local state with nothing
on the wire. The desktop broker and the same-origin cookie client refuse from a
literal, having asked nobody. So the hot loop ADR-0232 stopped was never a loop
against a server. It was a local boolean read, on a backoff already capped at
thirty seconds. Retrying it costs a function call.

Two more facts finish the case. Hosted sign-in is a document navigation:
`packages/auth/src/oauth-launchers/launchers.ts` sets `window.location.href`, so
the page is replaced whether or not anything asks for a reload. And a `{#key}`
block already gives the exact lifetime the reload was faking. Svelte 5.56's
`ensure()` in `internal/client/dom/blocks/branches.js` creates the branch for
the new key first and pauses and destroys the old one afterwards, so a keyed
child that opens a store at init runs before its predecessor's cleanup closes
one.

`permanence` also carried a collision that only became visible once it was
questioned. The OAuth authority meant `'auth-unavailable'` as "verification was
unreachable, try again", while the desktop broker and the same-origin cookie
client threw the same code with `permanence: 'permanent'` to mean "this client
can never open a socket". One string, two opposite instructions, distinguished
only by a field this record deletes.

## Decision

**Sync runs for as long as the store is open, and a credential refusal is data
on its status.**

`SyncRefusal` in `@epicenter/sync` is the closed union
`'signed-out' | 'reauth-required' | 'auth-unavailable' | 'no-credential-model'`,
and `OpenWebSocketDenial` is `{ name, message, code: SyncRefusal }` with no
`permanence`. `packages/data/src/sync/attach.ts` reports a recognised rejection
as `closed(cause.code)` and anything else as `onTransportError(cause)` followed
by `closed()`. The driver has one close callback, records the code on
`status().refusal`, sets `lastReconnect` to `'refused'`, and dials again on the
same backoff it uses for a dropped socket. `refusal` is cleared by the next
dial that is not refused, whether that one opens or fails on the wire, so it
answers for the last dial rather than for a history: a signed-in person who is
merely offline is never told to sign in.

There is no `denied()`, no `denied` flag, no parked state, no resume, and
nothing to redial after a person signs back in: the next dial simply succeeds.
Refusing costs nothing on the wire, which is the whole reason this is allowed
to be so simple.

| Name | What it is now |
| --- | --- |
| `SyncRefusal` | closed union of four codes, exported from `@epicenter/sync` and re-exported from `@epicenter/data/sync` |
| `OpenWebSocketDenial.code` | a `SyncRefusal`, and the whole of the classification |
| `BearerAuthorization` denied arm | `{ status: 'denied'; code: SyncRefusal }` |
| `SyncAttempt.closed` | `closed(refusal?: SyncRefusal)`, the one report a dial ends with |
| `SyncConnectionStatus.refusal` | `SyncRefusal \| undefined`, set on a refused dial, cleared by the next dial that is not refused |
| `SyncConnectionStatus.failures` | the backoff's count, renamed from `attempts` |
| `ReconnectReason` | gains `'refused'` |

`'no-credential-model'` is what the same-origin cookie client and the desktop
broker throw, which is the collision `permanence` was hiding. A surface maps the
union exhaustively with `satisfies Record<SyncRefusal, string | undefined>`:
`'reauth-required'` renders "Sign in to sync", `'auth-unavailable'` renders
"Offline", and `'signed-out'` and `'no-credential-model'` render nothing,
because neither is a condition a person repairs from a sidebar. A surface
showing a refusal never also shows `failures`, which climbs for the life of a
desktop page that is refused locally every thirty seconds.

**A data session is a value the Svelte tree owns, keyed on the principal.**

`epicenter.open()` becomes synchronous and returns a
`DataSession { opened, close, erase }`. A boot node reads auth reactively,
shows the sign-in screen when the state is `signed-out`, and otherwise wraps one
session component in a `{#key}` on the principal id. The child opens in its
script body
and closes in a cleanup-only `$effect`, and `{#await session.opened}` is the
state machine, in the template, instead of a hand-built one mirrored into a rune.

The handle serializes: `open()` while a session is held closes it first and
chains the new open behind that close. It has to, because the tree cannot. A
keyed child is created before its predecessor is destroyed, so the new `open()`
runs before the old `close()`, and no ordering discipline inside components can
fix an order Svelte owns.

That deletes the reload and everything that existed to serve it:
`reloadOnAuthChange`, the "auth generation" as a concept, and the rule that boot
reads must not track. A sign-out flips an `{#if}`, an account switch remounts a
`{#key}`, and sign-in and Reconnect were already document navigations.

## Consequences

- One vocabulary for a refused dial, in one place. A reader who finds
  `'auth-unavailable'` learns one thing about it rather than two contradictory
  things separated by a boolean.
- A degraded credential no longer costs the page. `signed-in` degrading to
  `reauth-required` changes a status line and nothing else: no principal
  changed, nothing remounts, and editing continues mid-keystroke.
- The cost is a dial every thirty seconds for the life of a page that can never
  sync, forever, on a desktop window. It is a local boolean read and a status
  write. ADR-0232 paid a reload, a third meaning of "generation", and an
  untracked-read rule to avoid it.
- `status().failures` becomes unbounded under a standing refusal. That is
  contained by the rule that a surface showing a refusal does not show the
  count, and it is why `failures` is named for what it counts rather than for
  what it used to be called.
- Three names stop meaning two things: `generation` is the store's history and
  the driver's counter is `attempt`; `attempts` becomes `failures`; and
  `denied` is gone from both the driver and the auth transport.
- What this forecloses: a consumer can no longer ask "is this connection over
  for good", because nothing is. A surface that wants to say something final
  has to decide that itself from the refusal code.

## Considered alternatives

- **Keep `denied()` and add a wake signal from auth into `packages/data`.** The
  shape ADR-0230's final consequence predicted and ADR-0232 refused. It threads
  auth awareness into a driver that owns transport, to avoid a retry that costs
  a local boolean read.
- **Keep `permanence` as data while deleting it as control flow.** A dead field
  is an invitation: the next consumer branches on it and the collision comes
  back. The four codes already say everything `permanence` said.
- **Key the session on a principal plus a credential counter,** so an inline
  launcher's `reauth-required` to `signed-in` remounts. Unnecessary once the
  driver never stops: its next dial succeeds within the backoff cap, and
  remounting would throw away a person's place in the app to achieve it.
- **Own the session in the handle and let components read it.** That is what
  `epicenter.state` did. It forces a machine into a rune and makes the tree's
  create-before-destroy order the handle's problem twice.
