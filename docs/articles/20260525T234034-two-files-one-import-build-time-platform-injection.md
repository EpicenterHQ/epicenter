# Two files, one import: how Whispering picks a platform at build time

> **Editor's note (superseded).** The `resolve.extensions` plus tsconfig `moduleSuffixes` mechanism narrated below was replaced by Node-standard `#platform/*` subpath imports declared in each app's `package.json` `imports` map, which scoped the platform swap to a single seam instead of making every bare import magic. Those were later replaced too: under [ADR-0781](../adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md), one build serves every surface, and each capability branches on `isTauri()` when it runs. The rest of this article is kept as a record of the earlier approach.

One of the more interesting systems in Epicenter is how Whispering picks which implementation of a service runs. The desktop version uses Rust over Tauri for the clipboard. The web version uses `navigator.clipboard`. The consumer code in `+page.svelte` doesn't know or care. Both builds get a different file behind the same import path, and the wrong one never enters the bundle.

This took us three rewrites to get right.

## The ternary version

The first version did what most Tauri apps do. We picked the implementation at runtime:

```ts
import { isTauri } from '@tauri-apps/api/core';
import { createClipboardServiceDesktop } from './desktop';
import { createClipboardServiceWeb } from './web';

export const ClipboardServiceLive = isTauri()
  ? createClipboardServiceDesktop()
  : createClipboardServiceWeb();
```

It works. It's the pattern every Tauri tutorial shows you. But it has three problems we kept stepping on.

First, both implementations ship in the web bundle. The desktop file imports `@tauri-apps/plugin-clipboard-manager`, which pulls in a few hundred KB of code that web users will never run. We're shipping dead code on purpose.

Second, the type system can't help. Nothing stops a web-only file from accidentally importing `@tauri-apps/api/core` somewhere. The build accepts it. You only find out at runtime, usually when a user reports a blank screen.

Third, every reader of the service has to re-derive what the ternary is doing. The `isTauri()` check is fine once. By the tenth service that does the same dance, you stop reading the conditional and start treating it as noise.

## What Tauri actually recommends

Tauri's docs suggest two patterns for this. Both involve some flavor of stub file.

The dynamic import version:

```ts
let filesystemService;
if (import.meta.env.VITE_TAURI_BUILD) {
  filesystemService = await import('./filesystem.tauri.js');
} else {
  filesystemService = await import('./filesystem.web.js');
}
export default filesystemService;
```

This works, but it makes every call site async. You can't statically import `ClipboardServiceLive`; you have to wait for it. The dance scatters across every consumer.

The alias version:

```ts
// vite.config.ts
resolve: {
  alias: !isTauri ? { './filesystem.tauri.js': './filesystem.web.js' } : {},
}
```

Cleaner, but you need to add an alias entry to `vite.config.ts` for every dual-impl service in the app. And Tauri's docs explicitly tell you to provide a `filesystem.web.js` even if it's "an empty module or web-compatible alternative." That's a stub file, just in a different shape.

Both patterns get you part of the way. Neither is what we ended up with.

## The pattern that stuck

We use Vite's `resolve.extensions` with a filename suffix convention. The same idea that React Native uses for `.ios.ts` and `.android.ts`, and that VS Code uses for `.browser.ts` and `.electron-sandbox.ts`. Vite supports it out of the box. No plugin, no aliases.

```ts
// vite.config.ts
const isTauri = process.env.TAURI_PLATFORM !== undefined;

export default defineConfig({
  resolve: {
    extensions: isTauri
      ? ['.tauri.ts', '.ts', '.json', '.svelte']
      : ['.browser.ts', '.ts', '.json', '.svelte'],
  },
});
```

That's the whole config. When Vite resolves an import for `$lib/services/clipboard`, it tries `.tauri.ts` first on Tauri builds and `.browser.ts` first on web builds. Whichever isn't picked is never parsed, never bundled, never type-checked against the wrong assumptions.

A clipboard service then looks like this:

```
services/clipboard/
  index.tauri.ts     ← real Tauri implementation
  index.browser.ts   ← real web implementation
  types.ts           ← shared interface both must satisfy
```

The call site doesn't change between builds:

```ts
import { ClipboardServiceLive } from '$lib/services/clipboard';

await ClipboardServiceLive.writeText('hello');
```

Synchronous. No ternary. No `isTauri()` check at the call site. The reader doesn't need to know which file got picked, because for their purposes both files do the same thing.

Inside each file, the implementation uses `satisfies` to enforce shape:

```ts
// index.browser.ts
import type { ClipboardService } from './types';

export const ClipboardServiceLive = {
  writeText: async (text) =>
    tryAsync({
      try: () => navigator.clipboard.writeText(text),
      catch: (error) => ClipboardError.WriteFailed({ cause: error }),
    }),
} satisfies ClipboardService;
```

Both files share the `ClipboardService` interface from `types.ts`. If one drifts, TypeScript complains in that file, not at the call site.

## The Tauri-only case

Dual-impl services are the easy half. Some capabilities have no web counterpart: the file system, the system tray, global shortcut registration. There's nothing reasonable to stub with `navigator` APIs.

Stuffing those into the same per-service folder pattern made them lie. The "browser implementation" was a throwing stub whose only job was to satisfy Vite's resolver on web. After several iterations, we collapsed all of them into one namespace file:

```ts
// $lib/tauri.tauri.ts
export const tauriOnly = {
  fs: { pathsToFiles },
  permissions: { accessibility, microphone },
  window: { setAlwaysOnTop },
  tray: { setIcon },
  globalShortcuts: { registerCommand, unregisterCommand, unregisterAll },
  autostart: { isEnabled, enable, disable },
};

export type Tauri = typeof tauriOnly;
export const tauri: Tauri | null = tauriOnly;
```

The companion is one line:

```ts
// $lib/tauri.browser.ts
export const tauri = null;
```

Consumers do:

```ts
import { tauri } from '$lib/tauri';

if (tauri) await tauri.fs.pathsToFiles(paths);
// or
await tauri?.fs.pathsToFiles(paths);
```

The variable doubles as both the namespace and the platform boolean. `if (tauri)` answers "are we on Tauri?" and gives you the namespace in the same line. No separate `window.__TAURI_INTERNALS__` check, no separate import, no separate stub per capability.

## The dual-impl pattern stays for genuine duals

Services that have a real implementation on both platforms (clipboard, text, http, notifications, etc.) keep the per-folder `.tauri.ts` + `.browser.ts` shape. Each side uses `satisfies` against a shared interface:

```ts
// services/clipboard/index.browser.ts
import type { ClipboardService } from './types';

export const ClipboardServiceLive = {
  writeText: async (text) => navigator.clipboard.writeText(text),
  // ...
} satisfies ClipboardService;
```

The `satisfies` keyword preserves the inferred literal type but type-checks against the interface. If the two impls drift, the build catches it in whichever side broke. We tried `as unknown as ClipboardService` first and learned the hard way: the double cast hides drift. After switching to `satisfies` across the codebase, we caught five existing stubs that had stale method names or missing exports.

## What the call sites look like in practice

Dual-impl services read the same on both platforms:

```ts
import { ClipboardServiceLive } from '$lib/services/clipboard';
import { TextServiceLive } from '$lib/services/text';
import { NotificationServiceLive } from '$lib/services/notifications';

await ClipboardServiceLive.writeText('hello');
await TextServiceLive.copyToClipboard(text);
await NotificationServiceLive.notify({ title: 'Done' });
```

No ternary, no dynamic import, no platform check. The reader sees a function call.

Tauri-only capabilities go through one optional chain:

```ts
import { tauri } from '$lib/tauri';

await tauri?.fs.pathsToFiles(paths);
if (tauri) await tauri.tray.setIcon({ icon: 'IDLE' });
```

The two builds produce different bundles. The web bundle has no Tauri code in it; we verified this by grepping the production build for `@tauri-apps` and getting zero hits. The Tauri bundle has no `navigator.clipboard` fallbacks. Each build ships only what it needs.

## When this isn't the answer

Build-time DI doesn't fit every "which implementation" decision. Some choices the user makes at runtime, and you can't push those to the build.

Transcription provider is the obvious one. The user picks OpenAI or Groq in settings. Both implementations have to be in the bundle, because the user can switch mid-session. That's runtime DI, and it stays runtime. We have a separate article on that: `20260526T030000-bind-platform-once-bind-settings-every-time.md`.

The clean test: can the answer change between now and the next call? If yes, runtime. If the answer is fixed once you know "Tauri or web," build-time.

## If you want to copy this

The whole pattern is about 60 lines of Vite config plus filename discipline. The hardest part isn't the mechanism; it's deciding which services to split and which to leave alone. Our rule of thumb: split if both platforms have a real implementation. Use the `$lib/tauri` namespace when a capability is Tauri-only and reachable from shared code.

If you want to see the actual code, the relevant files are:

- `apps/whispering/vite.config.ts` for the `resolve.extensions` switch.
- `apps/whispering/src/lib/tauri.tauri.ts` and `tauri.browser.ts` for the Tauri-only namespace.
- Any service folder under `apps/whispering/src/lib/services/` for a dual-impl example.

Fork it, break it, ship your own version. The setup is small enough that you can read the whole thing in five minutes.
