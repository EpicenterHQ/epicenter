# 0203. Epicenter owns only what is already contended, and never adopts a resource whose contention its own mechanism would create

- **Status:** Accepted
- **Date:** 2026-08-03
- **Relates:** ADR-0180, [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md), [ADR-0184](0184-one-host-recorder-progressively-stages-each-claimable-recording-until-its-owner-stops-or-cancels-it.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md), [ADR-0185](0185-trusted-app-http-uses-tauris-standard-transport-without-observation.md). Not in this tree, on open branches: ADR-0193 (durable authorities and disposable materializations), ADR-0201 (one app-data root), ADR-0202 (a provider account belongs to the app whose durable state it names).

## Context

Epicenter has refused a host-owned subsystem four separate times, each time
correctly and each time locally. ADR-0180 refused a per-call model name and kept
one active local transcription model. ADR-0181 refused `storage` as a capability
category. ADR-0193 refused bytes that are not Epicenter's to offer. ADR-0202
refused a connected-provider registry, a shared refresh-token vault, a host
account lifecycle, and a cross-app operational store.

Four refusals, and no statement of the rule they share. Someone proposing the
fifth host capability has four precedents to read and no principle to apply, and
the argument that arrives with every proposal is the same one: it would be
convenient if the host owned this, because then every app gets it for free.

Convenience is not a boundary. It has no stopping condition, and every subsystem
the corpus already refused could have been argued in on it.

The absence has a second cost that is harder to see. A host that adopts a
resource usually has to coordinate it, and coordination is what makes the
adoption look justified afterwards. A mechanism can manufacture the very problem
it is then credited with solving, and nothing in the corpus named that pattern,
so each instance had to be caught by hand.

## Decision

**Epicenter owns a capability exactly when the resource behind it is already
contended. It never adopts a resource whose contention its own mechanism would
create.**

Contended means there are genuine claimants: two parties that must be given one
answer, where no outside authority supplies it.

### The rule runs at two altitudes

**Across apps on one machine.** The host owns the app-id namespace, because two
apps must not claim one name. It owns the recorder, because there is one
microphone (ADR-0184). It owns the active local transcription model, because
there is one model cache, one accelerator, and one RAM budget (ADR-0180). It
owns the one application-data root and the one replica. Apps own everything
else.

**Across one person's devices.** The replica owns what that person authored,
because two devices can hold different answers and nothing outside settles it. A
materialization of a foreign authority is not contended, because each device
rebuilds it independently from the authority that already holds the truth, and
that authority is the arbiter. So the replica holds what is yours, and a cache
holds a copy of what is someone else's.

### Contention earns a lifecycle; its absence earns a pure function

This is the rule's test, and it reads off the code rather than off intent.

Everything the host owns has claims, activation, or generations: the recorder
stages and is claimed, the model activates and prewarms, the catalog has
immutable generations and a `current` pointer. Everything an app owns has a
`join`: `appDataDir` and `partitionDir` are pure functions with no handle, no
registry, no acquisition protocol, and no reclamation.

A lifecycle wrapped around something uncontended is a platform forming. A pure
function wrapped around something contended is a defect waiting. Both are
visible without arguing about anybody's motives.

### What the rule decides that was open

- **An external service is never contended.** A network call with a key
  arbitrates nothing, so cloud transcription route selection stays app-owned and
  ADR-0180's local-route scope is unchanged rather than widened. A host that owned
  the open set of vendors would grow a provider catalog, a per-provider
  capabilities matrix, a per-provider error taxonomy, and a settings surface that
  must know every provider to render, which ADR-0202 already forecloses.
- **Filesystem reach is refused, not deferred.** Per-app runtimes are not
  contended today; a host that spawned them would manufacture port allocation,
  supervision, and shutdown ordering, and would then cite them as the reason it
  had to own them. An app that needs a runtime ships as a runtime.
- **A blob is a cell of a row, not a resource.** Nobody arbitrates between two
  claimants for a blob, so it earns no store, no identity system, and no
  lifecycle. It earns an address.

### What the rule refuses to decide

It is a rule about ownership, not about correctness, scope, or product value. It
says who arbitrates when there are claimants. It never says a capability is worth
building, and it is not an argument for adopting something merely because it
turns out to be contended.

It is also not a security boundary. Every app here runs as the person who owns
the machine (ADR-0179), so this governs API and ownership between first-party
code, enforced by one owner per resource and by code review.

## Consequences

- The fifth host-capability proposal has one question to answer instead of four
  precedents to interpret: name the claimants and the absent arbiter, or the
  answer is no.
- Four existing refusals become one rule with four applications, and none of them
  changes. This record adds no capability, removes none, and alters no shipped
  behavior on the day it lands.
- The pattern that a mechanism can create its own justification is now nameable
  in review, which is the only place it was ever going to be caught.
- **What this forecloses:** a host capability over anything uncontended, a
  storage or database namespace, a generic filesystem or query surface, a
  connected-provider registry, a host-owned provider catalog, and any argument
  for host ownership that rests on convenience, sharing, or the absence of a
  reason not to.

## Considered alternatives

- **Own what is convenient to centralize.** Rejected: it has no stopping
  condition. Every subsystem this corpus already refused would have been admitted
  under it, and the four refusals would read as arbitrary.
- **Own what is shared between apps.** Rejected: sharing is a fact about how many
  callers want a thing, not about whether anyone has to arbitrate. Two apps
  wanting the same Groq key is sharing with nothing to settle, and ADR-0202
  already resolved that case by making the key a value rather than a service.
- **Keep deciding per capability, as the corpus does today.** Rejected on the
  same reasoning ADR-0202 used against per-app provider rules: it is four records
  for one rule, none of which the next proposal can consult, and the shape left
  undecided is the one that gets built by accident.
- **State the rule inside ADR-0201 rather than as its own record.** Considered
  seriously and rejected narrowly. The rule governs transcription, capabilities,
  bytes, and accounts, and ADR-0201 is about directories; a reader arriving at
  the capability question would have no reason to open a record about the
  filesystem.
