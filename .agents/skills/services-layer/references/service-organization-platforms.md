# Service Organization And Platform Variants

This reference covers Whispering's build-time service seam and the shared
service barrel.

## One Stable Import

For a capability with browser and Tauri implementations, keep a shared contract
and two implementation files:

```txt
services/text/
|-- types.ts
|-- index.browser.ts
`-- index.tauri.ts
```

Map one bare specifier in `apps/whispering/package.json`:

```jsonc
"#platform/text": {
  "tauri": "./src/lib/services/text/index.tauri.ts",
  "default": "./src/lib/services/text/index.browser.ts"
}
```

Shared consumers import one name:

```typescript
import { TextServiceLive } from '#platform/text';
```

The web bundle resolves `default`; the Epicenter/Tauri surface activates the
`tauri` condition. Do not add a runtime `window.__TAURI_INTERNALS__` branch or a
second platform registry.

Each implementation exports the same name and checks the shared contract:

```typescript
export const TextServiceLive = {
	readFromClipboard,
	copyToClipboard,
	writeToCursor,
	simulateEnterKeystroke,
	simulateCopyKeystroke,
} satisfies TextService;
```

Current service seams include analytics, blobs, download, HTTP, recorder,
and text. Check `package.json#imports` rather than copying this list when adding
or moving a service.

## Tauri-Only Capability

When no meaningful browser implementation exists, use `#platform/tauri`. It
resolves to the capability namespace on Tauri and `null` on the browser. Narrow
once in shared code:

```typescript
import { tauri } from '#platform/tauri';

if (tauri) {
	await tauri.mainWindow.focus();
}
```

Inside an already gated `.tauri.ts` file, import `tauriOnly` directly from
`$lib/tauri.tauri`.

## Shared Service Barrel

`apps/whispering/src/lib/services/index.ts` aggregates cross-platform
capabilities after their platform imports resolve:

```typescript
import { AnalyticsServiceLive } from '#platform/analytics';
import {
	BlobReplicaLive,
	BlobsLive,
	BlobSourcesLive,
} from '#platform/blobs';
import { DownloadServiceLive } from '#platform/download';
import { TextServiceLive } from '#platform/text';

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

The barrel is not a provider registry. Runtime-selected transcription providers
remain directly imported by the operation that owns provider dispatch.
