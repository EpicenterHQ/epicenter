# Service Organization And Platform Variants

This reference covers Whispering's build-time service seam and the shared
service barrel.

## One Stable Import

For a capability with browser and Epicenter-host implementations, keep one
implementation file per build:

```txt
services/blobs/
|-- index.browser.ts
`-- index.epicenter-host.ts
```

Map one bare specifier in `apps/whispering/package.json`:

```jsonc
"#platform/blobs": {
  "epicenter-host": "./src/lib/services/blobs/index.epicenter-host.ts",
  "default": "./src/lib/services/blobs/index.browser.ts"
}
```

Shared consumers import one name:

```typescript
import { BlobsLive } from '#platform/blobs';
```

The web bundle resolves `default`; the Epicenter host build activates the
`epicenter-host` condition. Do not add a runtime `window.__TAURI_INTERNALS__`
branch or a second platform registry.

Each implementation exports the same names with the same declared shape, so a
consumer sees one contract whichever leaf the build selects. A seam whose only
implementation is native, such as `#platform/text`, maps the bare specifier
straight to its `.tauri.ts` file.

Check `package.json#imports` for the current seam list rather than copying it
when adding or moving a service.

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
	BlobsLive,
	BlobSourcesLive,
} from '#platform/blobs';
import { DownloadServiceLive } from '#platform/download';
import { TextServiceLive } from '#platform/text';

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

The barrel is not a provider registry. Runtime-selected transcription providers
remain directly imported by the operation that owns provider dispatch.
