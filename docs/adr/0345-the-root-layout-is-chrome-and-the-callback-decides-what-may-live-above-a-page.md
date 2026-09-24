# 0345. The root layout is chrome, and the callback decides what may live above a page

- **Status:** Proposed
- **Date:** 2026-09-03
- **Page lifetime:** The fixed-library direction is recorded in [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md). A boot node captures one primary library and deliberate changes close before navigation. The earlier reactive `{#if}`/`{#key}` replacement guidance is withdrawn. The narrowest node outside the callback still owns application opening; the page-lifetime transition is unbuilt.
- **Amended by:** [ADR-0342](0342-sign-in-is-the-door-to-keeping-not-to-using.md)'s rejection, at its citation of ADR-0088: sign-in IS a door, and every application renders a sign-in screen while signed out.
- **Unbuilt:** nothing.
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md) (a page lifetime is one auth generation, which is the part of 0088 this depends on), [ADR-0342](0342-sign-in-is-the-door-to-keeping-not-to-using.md) (why every app gates today), [ADR-0344](0344-an-epicenter-owns-one-data-session-and-opening-it-is-a-verb.md) (opening is a verb, so someone has to own the call)

## Context

Every Epicenter SPA has at least two surfaces under one root layout: the
application, and `/auth/callback`. They want opposite things from a boot.

The application wants an account-bound store: a Web Lock, an IndexedDB
database, a generation fetch, a WebSocket. The callback wants none of it. It
runs for one round trip while the PKCE code is exchanged, and it runs while
signed out, which is the one state in which there is no store to open at all
(ADR-0336 left no unowned document to fall back to).

So the question is never "should this app have a route group". It is "what is
the narrowest node that is not shared with the callback", because that is the
only place a store may be opened or an auth gate may be rendered.

Two source comments hold this today, in two apps, in two different words.
Whispering's root layout says it owns chrome only "so the other surfaces never
open SQLite". Honeycrisp's page says the open is "this route rather than the
layout because the layout also wraps `/auth/callback`". Nothing states the
shared rule, and nothing says when a route group is the answer and when it is
churn, so the next app rediscovers it or gets it wrong.

Getting it wrong is not cosmetic. A gate in a node the callback renders under
shows a signed-out person a sign-in screen on top of the callback that is
signing them in. A store opened there claims a Web Lock the real page then
finds taken.

## Decision

**The root layout is chrome.** Global CSS, providers, toasts, theme, view
transitions, and `reloadOnAuthChange`. No store opening and no auth gate,
because the callback renders under it.

**`reloadOnAuthChange` belongs in the root layout, and the callback is the
reason.** It is a subscription, not a gate, and the callback is a route it has
to cover. A completed exchange changes identity while the callback is mounted;
the subscription sees it, matches `callbackPath`, and does
`window.location.replace('/')`. That is a document replacement, so the next
generation boots from scratch, which is what ADR-0088 requires. The page's own
`goto('/')` is the fallback that runs if the subscription did not fire, and it
is a client-side navigation: it would land on `/` inside the document that
already changed identity. Moving `reloadOnAuthChange` down into a protected
layout would leave the callback uncovered and quietly demote the guarantee to
that fallback.

**The protected branch needs a node of its own, and an app uses whichever it
already has.** In order of preference:

1. **A URL segment**, when the protected surface is not at `/`. `apps/api/ui`
   gates in `dashboard/+layout.svelte`. It needs no group because `/dashboard`
   is already the boundary.
2. **A route group**, when the protected surface is at `/` and has more than
   one route. Whispering uses `(app)` because it has a shell, nested routes,
   and two siblings that must escape it: `auth/callback` and
   `recording-overlay`.
3. **The page**, when the protected surface is one route at `/`. Honeycrisp and
   Vocab open in `+page.svelte`. The callback is already a sibling page, so the
   boundary exists without any directory.

**Introduce a group only when the protected branch has more than one route and
no URL segment of its own.** A group around a single page is a layout with one
child. A group around a route that inherits only the root layout changes
nothing at all: `(auth)/auth/callback/` and `auth/callback/` resolve to the same
URL under the same layouts, so the parentheses are a directory that means
nothing.

**What stays page-owned regardless.** The `epicenter.open()` call and the
one-shot `auth.state` boot read. Opening is a verb (ADR-0344) and the read is
once per generation (ADR-0088). Neither becomes a layout's job because a layout
exists.

## Consequences

Vocab does not change. Its protected surface is one page at `/`, so it is case
3, and it is already shaped that way.

Vocab adopts `(app)` when it gains a second protected route. At that point the
gate moves into `(app)/+layout.svelte` and `epicenter.open()` stays in the page
unless every protected route needs the store, in which case the open moves up
with the gate and the callback is still outside it.

The rule is checkable by reading one tree. For any app: find the node the
callback renders under, and confirm nothing at or above it opens a store or
gates.

An app whose protected surface is at `/` with one route carries a shape that
looks inconsistent with Whispering's. It is not. Both put the boot at the
narrowest node that excludes the callback; they differ only in how many routes
sit inside that node.

## Considered alternatives

**`(app)` and `(auth)` groups in every SPA, for symmetry.** Rejected because
`(auth)` is provably inert. It would wrap one route, add no layout, and leave
inheritance identical, so it buys a directory and a rename of nothing. SvelteKit's
own advanced-routing documentation says not to feel compelled to use groups.
Symmetry across apps is worth less than each app's tree saying what it actually
owns.

**Move the gate into a layout in every app, so pages never mention auth.**
Rejected for Vocab and Honeycrisp specifically. Their signed-out screen and
their store-failure screen are the same markup with a different sentence and a
different button, chosen by one `signedOut` boolean. Splitting them across a
layout and a page duplicates the block or requires a context to pass the failure
down, and a context that exists to move a value one level is the indirection
ADR-0344 spent a session removing.

**A `+layout.svelte` that reads auth and renders a gate, with the callback
escaping via `+page@.svelte`.** Rejected. The reset syntax works and would keep
the URL, but it makes the callback's correctness depend on an `@` in a filename
rather than on where the file sits. A group or a page boundary states the same
thing in the tree, where someone moving a file will see it.

**Hoist `reloadOnAuthChange` into the protected layout as "app auth policy".**
Rejected. It is not policy, it is the mechanism that makes a page lifetime one
auth generation, and the callback is the route that most needs it. See the
decision above.
