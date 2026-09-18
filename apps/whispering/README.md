<p align="center">
  <img width="180" src="./src/lib/assets/studio-microphone.png" alt="Whispering">
  <h1 align="center">Whispering</h1>
  <p align="center">Press shortcut → speak → get text.</p>
</p>

Whispering is a free and open source speech-to-text app. It records speech, transcribes it with a provider you choose, optionally polishes the transcript, and delivers the text.

There is one shipped build. Epicenter serves it under `/apps/whispering`, and every native capability comes from that host. Whispering does not own a native shell: Epicenter owns the only Tauri runtime, at `apps/epicenter/src-tauri`.

## Host boundary

```text
apps/whispering/src
  |
  |-- bun dev:whispering ------> vite dev on http://localhost:1420
  |                              browser leaves for auth, binding, blobs
  |
  `-- bun run build:epicenter -> apps/epicenter/dist/whispering
                                 |
                                 `--> apps/epicenter/src-tauri
                                      native commands and windows
```

`bun dev:whispering` runs the SPA in a browser tab. That is a development surface, not a product target: the tab has no native recorder, no system-global shortcuts, and no host app-data files, so the parts that need them do not work there. Use it for UI work, and run `bun dev:epicenter` for anything that touches a native capability.

Selection happens at build time through the `#platform/*` imports in `package.json`:

- Most seams are a plain path alias at a single leaf, because the shipped build is the only one that resolves them.
- Three seams have two leaves, conditional on `epicenter-host`: `auth`, `binding`, and `blobs`. The `default` leaf of each is what the dev browser tab gets. Base path is not a seam: `svelte.config.js` sets `paths.base` for the Epicenter build and routes call `resolve` from `$app/paths` (ADR-0347).
- Shared code can use the nullable `tauri` capability namespace as a guard, but it does not choose implementations at runtime.

Epicenter's asset build sets `EPICENTER_HOST=1`, which activates the `epicenter-host` module condition and the `/apps/whispering` asset base. No other build signal selects Whispering's host leaves.

## Run locally

Start apps from the repository root.

```bash
# SPA in a browser tab plus its local API
bun dev:whispering

# The SPA alone
bun dev:whispering:ui

# Epicenter desktop with Whispering as a native app window
bun dev:epicenter
```

The dev tab runs on `http://localhost:1420`. Epicenter opens Whispering at `epicenter://app/whispering`.

## Build and verify

```bash
# Unhosted artifact: apps/whispering/build
bun run --cwd apps/whispering build

# Epicenter assets, including apps/epicenter/dist/whispering
bun run --cwd apps/epicenter build

# Default and host type resolution
bun run --cwd apps/whispering typecheck

# App tests
bun test apps/whispering/tests
```

Run the two asset builds sequentially in one checkout. SvelteKit owns a shared `.svelte-kit` directory, so concurrent default and Epicenter builds can race over generated configuration.

For the complete desktop artifact:

```bash
bun run --cwd apps/epicenter desktop:build
```

## What the Epicenter host provides

| Capability | How it works under Epicenter |
| --- | --- |
| Microphone recording | Native recorder |
| Cloud and self-hosted transcription | Direct provider, hosted gateway, or self-hosted endpoint |
| On-device GGUF transcription | Native model runtime |
| In-app and system-global shortcuts | Both, registered by the host |
| Paste at the active cursor | Native delivery when permitted, clipboard otherwise |
| Recording storage | Epicenter app-data files |
| Floating recording overlay | Native auxiliary window |

Nothing in that list works in the `bun dev:whispering` tab. The seams behind them resolve to `.tauri.ts` leaves in every build, so the tab is for UI work only.

## Data boundary

Whispering transcribes through an explicitly selected connection and model. Deepgram, ElevenLabs, and Mistral’s separate provider adapters are not supported. Existing provider keys remain stored but are not read or imported; configure a supported connection in the intended account.

Whispering stores settings and recording metadata locally first. Audio leaves the device only when the selected transcription provider requires an upload. Transcription can go to a direct provider connection, the hosted Epicenter gateway, or a self-hosted endpoint.

See the repository [trust model](../../docs/trust-model.md) for hosted sync and account boundaries.

## There is no hosted browser deploy

`wrangler.jsonc` published the static SPA to `whispering.epicenter.so`. ADR-0227 refused that runtime: a browser tab is not a target, so the config and its deploy step are gone. Whatever Cloudflare last published keeps serving until somebody deletes the Worker, because removing the config stops republishing rather than taking anything down.

ADR-0227 says what would reopen this, which is trying-before-installing turning out to matter more than the capability seams cost.
