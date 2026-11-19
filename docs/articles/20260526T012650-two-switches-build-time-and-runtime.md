# Two Switches: When the Build Picks, When the User Does

> **Editor's note (superseded for the build-time switch).** The build-time switch in this article is shown with Vite `resolve.extensions` filename-suffix selection (`index.tauri.ts` before `index.ts`). That mechanism was replaced by Node-standard `#platform/*` subpath imports declared in each app's `package.json` `imports` map, which scoped the swap to one import path instead of making every bare import magic. Those were later replaced too: under [ADR-0781](../adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md), one build serves every surface, and each capability branches on `isTauri()` when it runs. The runtime-switch half of this article is unaffected; the rest is kept as a record of the earlier build-time approach.

A cross-platform app has two completely different "which one do I use" questions. They look the same at the call site:

```ts
if (isTauri) {
  // do the Tauri thing
} else {
  // do the web thing
}
```

```ts
if (settings.provider === 'OpenAI') {
  // call OpenAI
} else if (settings.provider === 'Groq') {
  // call Groq
}
```

Both are picking an implementation. But one of them, the build already knows. The other one, only the running app knows.

If you treat them the same, you ship Tauri code to web users for no reason, lose type safety, and add a runtime branch every time the decision is "the same answer it's always been since install." If you treat them differently, the bundler handles the first one for you, and the second one stays simple where it lives.

Here's how Epicenter draws the line.

## Switch one: the build picks (platform)

Clipboard works one way in a browser and another way in Tauri. There is no scenario where a Tauri build needs to fall back to the web clipboard. The decision is fixed the moment you run `vite build` or `tauri build`.

For switches like this, we use a filename suffix and let Vite resolve it:

```
src/lib/services/clipboard/
  index.ts          ← web implementation (the default)
  index.tauri.ts    ← Tauri implementation
  types.ts          ← shared interface both files satisfy
```

The Vite config is small:

```ts
// vite.config.ts
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
  resolve: {
    extensions: isTauri
      ? ['.tauri.ts', '.tauri.js', '.ts', '.js', '.json']
      : ['.ts', '.js', '.json'],
  },
});
```

`TAURI_ENV_PLATFORM` is an environment variable Tauri's CLI sets automatically when you run `tauri dev` or `tauri build`. We don't set it ourselves.

The effect is invisible at the call site. Consumers write:

```ts
import { ClipboardService } from '$lib/services/clipboard';
```

No `if` statement. No platform check. On a Tauri build, Vite tries `index.tauri.ts` first, finds it, uses it. On a web build, `.tauri.ts` isn't in the extensions list at all, so the resolver falls through to `index.ts`. The wrong implementation isn't bundled. It isn't parsed. It doesn't exist for that build.

A nice side effect: services that are Tauri-only (the system tray, the filesystem service, the global shortcut manager) have only an `index.tauri.ts` and no `index.ts`. If a web-bundled module accidentally imports one, `vite build` fails. The boundary between "things web can do" and "things only Tauri can do" stops being a runtime nullable check and becomes a build error.

That's the whole pattern. One config line and a naming convention.

## Switch two: the user picks (settings)

Transcription provider is the opposite story. The user picks OpenAI today, Groq tomorrow, Deepgram next week, all from the same installed bundle. We can't ask Vite to bake that in. We have to ask the question every time we call the service.

The shape that falls out:

```ts
async function transcribe(blob: Blob) {
  const provider = settings.get('transcription.selectedTranscriptionService');

  switch (provider) {
    case 'OpenAI':
      return services.openai.transcribe(blob, {
        apiKey: settings.get('apiKeys.openai'),
        model: settings.get('transcription.openai.model'),
      });
    case 'Groq':
      return services.groq.transcribe(blob, {
        apiKey: settings.get('apiKeys.groq'),
        model: settings.get('transcription.groq.model'),
      });
    // ...
  }
}
```

Notice what's not happening here. We're not picking the provider once at startup and caching it. We're calling `settings.get(...)` inside the function. Every call. Every time.

This is the part that catches people. The natural instinct is "let me grab a reference to the service at module load":

```ts
// don't do this
const provider = settings.get('transcription.selectedTranscriptionService');
const transcriptionService = pickProvider(provider);
```

Three minutes later the user changes the provider in settings and the app is now wrong forever. The cached reference points at the old service. There's no event to react to, because at module-load time we already made the choice and moved on.

So for the user-picks switch, every service consumption has to be lazy. The function reads settings at call time. The config reads happen inside the operation, not at the top of the file. The "what implementation am I using" question gets re-answered every time, because the answer can have changed since the last call.

Functions, not constants. Getters, not bindings. Read at the moment of use, not at the moment of import.

## The test, and a clean way to remember it

Ask: **can the answer change between now and the next time this code runs?**

- If no (because it's tied to "what was this app built for"), the build can pick. Put it behind a filename suffix.
- If yes (because the user can flip a setting, change a profile, log into a different account), the function has to re-ask each time.

Platform is a build-time fact. Settings are a runtime fact. Conflating them either ships dead code or caches stale references.

## Where this gets blurry

Recording method is the interesting edge case in Whispering. On a Tauri build, the user can pick CPAL (a Rust audio backend) or the navigator MediaRecorder. The CPAL implementation only exists in Tauri builds, but *within* Tauri builds the user gets to switch between the two.

So it's both:

- The CPAL file lives at `services/recorder/cpal.tauri.ts`. A web build can't import it at all (build-time switch).
- A Tauri build has both files in scope, and a getter inside the recorder state reads `settings.get('recording.method')` to pick at call time (runtime switch).

```ts
function resolveServiceForStart() {
  if (!isTauri()) return services.navigatorRecorder;
  return settings.get('recording.method') === 'cpal'
    ? services.cpalRecorder
    : services.navigatorRecorder;
}
```

Two switches stacked. Vite eliminates `services.cpalRecorder` from the web bundle entirely. Within the Tauri bundle, the runtime switch reads settings every time the recorder starts.

The two mechanisms compose without fighting. Build-time DI shapes what's reachable. Runtime DI picks from what's reachable.

## What this buys you

The web bundle stops shipping Tauri code. The type system stops letting you accidentally call a Tauri API from a web-only module. Every `if (isTauri)` ternary in the service layer can go away. And the runtime switches, the ones that genuinely need to re-check on every call, get to stay small and obvious because they're not also pretending to handle build-time concerns.

One question per switch: does the build know, or doesn't it? The answer picks the mechanism, and the mechanism picks itself.
