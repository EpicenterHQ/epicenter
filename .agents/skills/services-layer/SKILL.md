---
name: services-layer
description: 'Whispering service boundaries: UI-free capabilities, explicit app inputs, Result-typed fallibility, direct Live objects, lifecycle-earned factories, and build-time #platform implementations. Use when creating or refactoring services, service contracts, platform variants, provider dispatch, or the $lib/services barrel.'
metadata:
  author: epicenter
  version: '3.0'
---

# Services Layer

Ground service guidance in `apps/whispering/src/lib/services`, its consumers,
and the `#platform/*` mappings in `apps/whispering/package.json`. Historical
examples and neighboring skills are leads, not current architecture.

## Product Sentence

The service layer owns UI-free capabilities; callers inject app policy through
explicit inputs, fallible operations return Results, and platform selection has
one build-time owner.

## Boundary

Services may perform IO and may own service-local runtime state. They are not
required to be pure functions. They must remain free of UI and app-owned policy:

- no runtime reads of Svelte stores, `settings`, `deviceConfig`, toasts, or
  `report`;
- accept credentials, model names, endpoints, paths, and user choices as inputs;
- return domain data and errors, not presentation copy or UI state;
- expose the same contract from both sides of a `#platform/*` seam.

`$lib/operations` usually reads app settings, chooses providers, and composes
services. `$lib/rpc` adds shared query identity and observable lifecycle only
when the UI needs it.

The transcription directory also holds provider registry data and the
UI-facing `provider-ui.ts` join. Those colocated metadata modules are not
service implementations; do not use them to weaken the service boundary.

## Model Fallibility Honestly

Use `Result<T, E>` for a public operation that can fail in ordinary runtime use.
Adapt throwing platform or library calls with the `error-handling` skill.

Do not fake a Result for an infallible in-memory action or cleanup. Current
examples include local shortcut `register` / `unregister` returning `void` and
listener setup returning a cleanup function.

```typescript
export type DownloadService = {
	downloadBlob(args: {
		name: string;
		blob: Blob;
	}): Promise<Result<void, DownloadError>>;
};
```

Errors belong to the layer that understands the failure. Preserve lower-layer
tagged errors when composing services. Define a service-local variant only for
a failure the service itself owns. Use `define-errors` for variant shape and
message rules; use `error-handling` for adaptation and propagation.

## Direct Object Or Factory

Default to a direct `*ServiceLive` object when construction has no input or
lifecycle. Current download, analytics, text, and transcription provider
implementations use this shape. Download, analytics, and text check their shared
platform contracts with `satisfies <Service>`.

Use a factory when it owns real construction inputs, replaceable dependencies,
or stateful lifecycle. The browser and CPAL recorder factories earn their
boundary because each creates recording sessions with stop, cancel, subscribe,
and teardown behavior.

Do not add `create*` plus `*Live` mechanically for a stateless object.

Read [service implementation patterns](references/service-implementation-pattern.md)
for the current direct-object example and the factory decision.

## Platform And Runtime Selection

Use `#platform/*` imports for a capability with browser and Tauri
implementations. `package.json#imports` chooses the implementation at build
time; shared callers import one stable name and do not inspect
`window.__TAURI_INTERNALS__`.

Use the nullable `#platform/tauri` namespace for Tauri-only capabilities.

User-selected providers are runtime policy, not a platform seam. Keep the
dispatch in the consuming operation. Whispering transcription reads the
selected provider in `$lib/operations/transcribe.ts`; the query layer only
observes that operation.

Read [service organization and platform variants](references/service-organization-platforms.md)
when adding or moving a platform service.

## Service Barrel

`$lib/services/index.ts` collects stable cross-platform capabilities:

```typescript
export const services = {
	analytics: AnalyticsServiceLive,
	text: TextServiceLive,
	blobs: BlobsLive,
	blobReplica: BlobReplicaLive,
	blobSources: BlobSourcesLive,
	download: DownloadServiceLive,
	localShortcutManager: LocalShortcutManagerLive,
	sound: PlaySoundServiceLive,
} as const;
```

Do not force every provider implementation into this barrel. A runtime
operation may import its provider-specific services directly when it owns the
dispatch table.

## Final Check

- The service imports no UI or app-owned settings.
- Every app choice enters as an explicit input or is selected by the caller.
- Fallible public operations return Results; infallible operations stay plain.
- A factory owns construction or lifecycle, not convention alone.
- Platform choice happens through one `#platform/*` mapping.
- Runtime provider choice happens once at the consuming operation.
- Lower-layer errors pass through unless this service owns a new failure.
