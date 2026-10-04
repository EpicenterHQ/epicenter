<p align="center">
  <a href="https://whispering.epicenter.so">
    <img width="180" src="./src/lib/assets/studio-microphone.png" alt="Whispering">
  </a>
  <h1 align="center">Whispering</h1>
  <p align="center">Press shortcut → speak → get text.</p>
</p>

Whispering is a free and open source speech-to-text app. It records speech, transcribes it with a provider you choose, optionally polishes the transcript, and delivers the text. The same browser-hostable Svelte SPA serves two hosts:

- [whispering.epicenter.so](https://whispering.epicenter.so) runs the browser build.
- [Epicenter](../epicenter) runs the Tauri build under `/apps/whispering`.

Whispering does not own a native shell. Epicenter owns the only Tauri runtime at `apps/epicenter/src-tauri`.

## Host boundary

```text
apps/whispering/src
|-- browser condition --> apps/whispering/build --> Cloudflare static assets
`-- tauri condition ----> apps/epicenter/dist/whispering
                                      |
                                      `--> apps/epicenter/src-tauri
                                           native commands and windows
```

The browser is a real product target, not a desktop fallback. It owns browser recording, IndexedDB blobs, browser auth redirects, and web-safe shortcuts. The Epicenter build selects native implementations for system shortcuts, OS permissions, local model transcription, native windows, and app-data files.

Selection happens at build time through the `#platform/*` imports in `package.json`:

- The default condition resolves `*.browser.ts` implementations.
- The `tauri` condition resolves `*.tauri.ts` implementations.
- Shared code can use the nullable `tauri` capability namespace as a guard, but it does not choose implementations at runtime.

Epicenter's asset build sets `EPICENTER_SURFACE=1`, which activates the `tauri` module condition and the `/apps/whispering` asset base. No other build signal selects Whispering's native implementations.

## Run locally

Start apps from the repository root.

```bash
# Hosted browser app plus its local API
bun dev:whispering

# Browser UI only
bun dev:whispering:ui

# Epicenter desktop with Whispering mounted as a native surface
bun dev:epicenter
```

The browser app runs on `http://localhost:1420`. Epicenter also serves Whispering at `epicenter://surface/whispering`.

## Build and verify

```bash
# Browser artifact: apps/whispering/build
bun run --cwd apps/whispering build

# Epicenter assets, including apps/epicenter/dist/whispering
bun run --cwd apps/epicenter build

# Browser and Tauri type resolution
bun run --cwd apps/whispering typecheck

# App tests
bun test apps/whispering/tests
```

Run the two asset builds sequentially in one checkout. SvelteKit owns a shared `.svelte-kit` directory, so concurrent browser and Epicenter builds can race over generated configuration.

For the complete desktop artifact:

```bash
bun run --cwd apps/epicenter desktop:build
```

## Capability differences

| Capability | Browser | Epicenter desktop |
| --- | --- | --- |
| Microphone recording | Browser media APIs | Native recorder |
| Cloud and self-hosted transcription | Yes | Yes |
| On-device GGUF transcription | No | Yes |
| In-app shortcuts | Yes | Yes |
| System-global shortcuts | No | Yes |
| Paste at the active cursor | Clipboard fallback | Native delivery when permitted |
| Recording storage | IndexedDB | Epicenter app-data files |
| Floating recording overlay | In-page | Native auxiliary window |

## Data boundary

Whispering stores settings and recording metadata locally first. Audio leaves the device only when the selected transcription provider requires an upload. The browser and Epicenter builds can both use direct provider connections, the hosted Epicenter gateway, or a self-hosted endpoint. On-device transcription is available only through Epicenter because it depends on the native model runtime.

See the repository [trust model](../../docs/trust-model.md) for hosted sync and account boundaries.

## Deploy the browser app

`wrangler.jsonc` publishes the static SPA and routes unknown paths back to `index.html`.

```bash
bun run --cwd apps/whispering deploy
```

Cloudflare runs the browser build from the same configuration before deployment. It never packages or executes the Epicenter native runtime.
