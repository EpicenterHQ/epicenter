# 0181. Every app receives one portable Epicenter capability handle

- **Status:** Accepted
- **Date:** 2026-07-26
- **Amends:** [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md) at the application-facing readiness and recovery boundary.
- **Amended by:** [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md) at the delivery and namespace boundary: how an app obtains the handle is settled as a bundled MIT package, and `recording` joins the initial capability set. The handle's shape, its refusal of optional namespaces, and its transcription rules are unchanged. Also [ADR-0193](0193-durable-authorities-preserve-truth-disposable-materializations-can-always-be-rebuilt.md) at one bounded clause of the namespace-admission rule: withholding `storage` withholds Epicenter's ownership of a private store, not an app's right to keep one. An app-owned disposable materialization is opened by its owner through per-concern injection and reaches no namespace here. The closed capability set, the refusal of implementation-category namespaces, and the refusal of a dynamic service locator are unchanged.
- **Relates:** [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md)

## Context

An installed app needs local-first data and a small set of platform services.
Those services currently arrive through unrelated data, hosted-client, and
Tauri-specific objects. Mirroring that implementation split in app code would
give the same app a different API shape in a browser and inside Epicenter, while
a generic `inference`, `native`, or `system` hierarchy would expose mechanisms
rather than product capabilities.

Transcription makes the problem concrete. An app must know whether the route can
currently run and whether it accepts prompt and language hints, but it must not
enumerate or select the host's models. The same distinction applies more
generally: a stable application surface can compose services without claiming
that they share one internal owner or lifecycle.

## Decision

Every Epicenter app receives one portable `epicenter` handle. The handle has the
same shape in every supported runtime. Environment and configuration differences
appear as typed Wellcrafted `Result` failures, never as missing namespaces,
optional methods, or platform checks in application code.

The initial handle is organized by stable product capability:

```ts
epicenter.data.bind(lens);
epicenter.data.attachSync(session);
epicenter.data.syncStatus;

epicenter.blobs.add(blobId, blob);
epicenter.blobs.get(blobId);

epicenter.transcription.capabilities();
epicenter.transcription.transcribe(audioBlobId, hints);
epicenter.transcription.prewarm();

await epicenter.shell.openHome('transcription');
await epicenter.shell.openApp(appId);
```

The root is a typed composition boundary, not one implementation owner. `data`
owns structured local-first state and synchronization. `blobs` owns large binary
objects referenced by that state. `transcription` owns the host-provided
speech-to-text route. `shell` owns interaction with Epicenter surfaces. Each
service may have a separate authority, transport, and lifecycle behind the
handle.

`transcription.capabilities()` returns
`Result<TranscriptionCapabilities, TranscriptionUnavailable>`. `Ok` contains
the capabilities of the currently usable route. `Err` means the capability
cannot currently be used even when the host successfully answered the query.
Known reasons include an unavailable host, no active model, and an active model
that cannot currently be resolved. Unexpected programming failures are not
converted into ordinary unavailability.

The capabilities read is advisory. `transcribe()` independently resolves the
active model at execution and returns a typed `Result`. A successful transcript
reports the producing model and which advisory hints were applied. Applications
cannot list models, select one, or pass model identity.

`prewarm()` is a synchronous, outcome-free timing hint. The transcription
service owns the asynchronous best-effort work and its diagnostics. The method
promises only that transcription may be imminent; it does not expose readiness,
residency, or warmth, and callers do not branch on its outcome.

Shell navigation remains narrow. `openHome(section)` targets a privileged
built-in surface through a closed set of sections. `openApp(appId)` targets a
catalog member. They do not collapse into a generic string-addressed
`open(surface)` operation because the two destinations have different identity
and authority rules. Both return typed Results because their destination or host
may be unavailable.

New namespaces require a stable app-facing product capability with its own
invariants. Implementation categories such as `inference`, `local`, `native`,
`storage`, and `system` do not qualify. Browser and operating-system APIs do not
become Epicenter namespaces merely because an installed app can reach them.

## Consequences

- An app asks whether a capability is usable instead of detecting Tauri or
  branching on an optional namespace.
- Browser and desktop builds share one application architecture.
- Moving today's data runtime beneath `epicenter.data` is a clean public API
  replacement, not an aliasing exercise. The old root-level data verbs should
  not survive beside the new shape.
- The handle is ergonomic without becoming a dynamic service locator: its
  members are closed, typed product capabilities.
- Separate internal lifecycles remain visible to their owners without leaking
  transport or platform taxonomy to applications.
- Full trust and API design stay distinct. An admitted app may already hold
  broad same-origin and device authority under ADR-0179, but the portable SDK
  promises only the capabilities named here.

## Considered alternatives

- **Keep separate `data`, `client`, and `native` objects.** Rejected: app code
  would encode deployment and transport seams and grow different browser and
  desktop shapes.
- **Keep `bind`, `attachSync`, and `syncStatus` at the root.** Rejected: once
  `epicenter` names the complete application handle, privileging one service's
  verbs makes the root harder to extend and explain.
- **Nest under `inference.local.transcription`.** Rejected: `inference` already
  names connection-level AI infrastructure, and `local` describes deployment
  rather than the capability an app requests.
- **Make unavailable services optional.** Rejected: optional chaining hides the
  reason a capability cannot be used and forces platform detection into every
  caller.
- **Use one generic shell navigation method.** Rejected: built-in Home and
  catalog apps have different identity and authority boundaries.
