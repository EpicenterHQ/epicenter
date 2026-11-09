# 0185. Trusted app HTTP uses Tauri's standard transport without observation

- **Status:** Accepted
- **Date:** 2026-07-28
- **Amends:** [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md) by withdrawing its target for observed ordinary HTTP egress; and [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) by restoring its unrestricted Tauri HTTP grant
- **Amended by:** [ADR-0187](0187-a-bound-handle-reports-staleness-tables-can-name-rows-values-cannot.md), which adds a host-owned WebSocket for Epicenter's own data invalidations and names it a capability carrier rather than an ordinary HTTP observer
- **Note:** installed apps are parked (2026-10-15), so the unrestricted HTTP this record grants reaches only the compiled `whispering` window today.

## Context

An installed app is admitted as fully trusted code and may contact any HTTP or
HTTPS destination through Tauri's HTTP plugin. Tauri exposes no supported hook
that can attribute those requests to the invoking webview, while a gateway or
JavaScript wrapper would duplicate or miss parts of the plugin's fetch,
streaming, cancellation, cookie, and resource behavior. Maintaining a plugin
fork solely for a Home activity surface would turn optional visibility into a
permanent transport obligation.

## Decision

Epicenter keeps Tauri's standard HTTP plugin and the unrestricted HTTP grant for
trusted app windows unchanged. Epicenter does not observe, record, persist, or
display an installed app's ordinary HTTP activity.

Admission remains the protection: installing an app means trusting it to contact
any destination. Host-owned `epicenter.*` capabilities still derive application
identity at their owned boundary as required by ADR-0183, but ordinary HTTP is
explicitly outside that attribution promise.

### What a host-owned capability carrier is, and is not

A host-owned capability may carry its own traffic on the Epicenter origin, and
that traffic is not "ordinary app HTTP" in the sense this record refuses to
observe. ADR-0187's data invalidation WebSocket is the first of these: it is
authenticated, origin-checked, bounded to one route Epicenter owns, and it
reports only which addresses in Epicenter's own replica changed.

The distinction is what the traffic is about, not who opened the socket.
Epicenter observing its own replica on behalf of the surfaces it serves reveals
nothing about where an app went or what it sent. The refusal in this record is
about attributing an app's outbound requests to that app, and it stands
unchanged: no capability carrier may become a general-purpose observer of app
egress, and adding one would need its own ADR.

## Consequences

- Installed apps retain the plugin's upstream fetch semantics, including
  streaming and cancellation, without an Epicenter transport fork.
- Home cannot answer which destinations an installed app contacted.
- The HTTP gateway, transparent fetch shim, network audit entry, and
  process-lifetime activity ring are refused rather than deferred.
- Whispering does not need a separate HTTP capability merely to support network
  observation.
- ADR-0183's refusal to claim a complete effect audit remains in force and now
  includes ordinary installed-app HTTP.
- A host-owned capability carrier on the Epicenter origin is admissible and does
  not reopen this record, provided it carries the capability's own subject
  matter rather than a report of app egress.
- This decision should be revisited only if Tauri adds an official attributed
  observer, admission expands beyond meaningfully reviewed apps, or repeated
  support evidence makes network debugging a product requirement.

## Considered alternatives

- **Patch Tauri's HTTP plugin with an observer.** Rejected: the small hook can
  report request start and response headers, while useful completion,
  cancellation, and byte accounting enter the plugin's streaming resource
  lifecycle. Either version creates a permanent fork for visibility that
  changes no trust decision.
- **Add a host gateway and transparent fetch wrapper.** Rejected: the gateway
  would recreate fetch behavior, and app code can invoke the Tauri plugin
  directly without passing through the wrapper.
- **Record only unattributed plugin tracing.** Rejected: knowing that some
  webview made a request does not answer which app made it.
