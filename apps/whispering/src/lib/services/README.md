# Services Layer

Whispering services expose UI-free capabilities. They may perform platform IO
or own service-local runtime state, but service implementations do not read
Svelte state, app settings, device configuration, or reporting APIs at runtime.

The transcription directory also contains provider registry data and the
UI-facing `provider-ui.ts` join. Those colocated metadata modules are not
service implementations.

## Ownership

```txt
component / route   presentation and observed lifecycle
query               shared query identity and TanStack lifecycle
operation           app settings, provider choice, multi-step workflow
service             one UI-free capability and its domain failures
platform mapping    browser versus Tauri implementation
```

The consuming operation usually reads settings and passes explicit values such
as credentials, endpoints, models, paths, and user choices into services.

Fallible public operations return `Result<T, E>`. Infallible in-memory actions
and cleanup stay plain: `LocalShortcutManagerLive.register` and `unregister`
return `void`, while `listen` returns its cleanup function.

## Current Shape

```txt
services/
|-- analytics/
|   |-- types.ts
|   |-- index.browser.ts
|   `-- index.tauri.ts
|-- blobs/
|-- download/
|-- http/
|-- recorder/
|-- text/
|-- transcription/
|-- local-shortcut-manager.ts
|-- sound/
`-- index.ts
```

Check the directory and `apps/whispering/package.json#imports` for the current
set. This tree explains the ownership shape, not a permanent inventory.

## Direct Objects And Factories

Most stateless implementations export a direct object checked against a shared
contract. `services/download/index.browser.ts` is the smallest complete current
example: `DownloadServiceLive` adapts the browser download exception boundary
and `satisfies DownloadService` without a construction-only factory.

Use a factory only when construction inputs, isolated mutable state, resource
lifetime, or teardown earn one. Browser and CPAL recorder factories qualify
because they create recording sessions that own stop, cancel, subscription, and
teardown state.

## Build-Time Platform Injection

Capabilities with both browser and Tauri implementations use Node subpath
imports:

```jsonc
"#platform/text": {
  "tauri": "./src/lib/services/text/index.tauri.ts",
  "default": "./src/lib/services/text/index.browser.ts"
}
```

Shared code imports one stable name:

```typescript
import { TextServiceLive } from '#platform/text';
```

The web build resolves `default`. The Epicenter/Tauri build activates the
`tauri` condition. The off-target file is not part of that module graph. Do not
add runtime `window.__TAURI_INTERNALS__` checks or parallel service registries.

Each branch exports the same public name and conforms to the same contract.

## Tauri-Only Capabilities

Capabilities with no browser implementation use `#platform/tauri`. It resolves
to the Tauri namespace on desktop and `null` on web:

```typescript
import { tauri } from '#platform/tauri';

if (tauri) {
	await tauri.mainWindow.focus();
}
```

Code already isolated in a `.tauri.ts` file imports `tauriOnly` directly from
`$lib/tauri.tauri`.

## Runtime Provider Selection

User-selected providers are runtime policy, not a platform implementation.
`$lib/operations/transcribe.ts` reads `settings`, selects on-device versus
upload behavior, and dispatches through the provider table. Provider services
receive explicit credentials, model names, endpoints, language, and prompt
inputs.

The query layer observes that operation through
`queries.transcription.transcribeRecording`; it does not choose the provider
again.

## Service Barrel

`services/index.ts` collects stable cross-platform capabilities after their
platform imports resolve:

```typescript
export const services = {
	analytics: AnalyticsServiceLive,
	text: TextServiceLive,
	blobs: BlobsLive,
	blobSources: BlobSourcesLive,
	download: DownloadServiceLive,
	localShortcutManager: LocalShortcutManagerLive,
	sound: PlaySoundServiceLive,
} as const;
```

Runtime-selected provider services do not need to live in this barrel. The
operation that owns dispatch may import them directly.

## Error Flow

- Adapt throwing platform and library calls at the service boundary.
- Define a service error only for a failure the service understands.
- Pass lower-layer tagged errors through when composing services.
- Keep user presentation in operations, routes, or components through
  `$lib/report`.
- Do not manufacture a Result for an infallible method.

See the `services-layer`, `error-handling`, `define-errors`, and `query-layer`
skills for agent-facing maintenance guidance.
