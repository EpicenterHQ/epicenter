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
  |                              browser leaves for auth, capture, and delivery
  |
  `-- bun run build:epicenter -> apps/epicenter/dist/whispering
                                 |
                                 `--> apps/epicenter/src-tauri
                                      native commands and windows
```

`bun dev:whispering` runs the SPA in a browser tab. Browser capture uses
MediaRecorder and browser storage. Native recording, on-device inference, system
global shortcuts, and cursor delivery require Epicenter. Use `bun dev:epicenter`
to exercise those host capabilities.

Selection happens at build time through `#platform/*` conditions in
`package.json`. Browser leaves implement supported behavior or explicit absence;
`epicenter-host` leaves use host capabilities. `svelte.config.js` supplies the host
base path, and routes use `resolve` from `$app/paths`.

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
bun test --isolate apps/whispering/src/lib/operations apps/whispering/src/lib/whispering apps/whispering/src/lib/queries

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

## Data boundary

Whispering transcribes through an explicitly selected connection and model. Deepgram, ElevenLabs, and Mistral’s separate provider adapters are not supported. Existing provider keys remain stored but are not read or imported; configure a supported connection in the intended account.

Capture and import always save bytes and a recording in Local. The reactive
`local` module is initialized once by admitted boot. Personal opens independently
for the captured Account; its provider supplies a non-null context only when ready.
Personal settings do not change where capture saves. Whispering currently keeps
recordings and audio Local; the retired Personal recording view and copy action
are unavailable. Row deletion keeps audio bytes; it is not an erasure operation.

Success requires local durable row persistence. Partial saves and transcript
writes retain page-lifetime Finish saving actions across route changes without
another row creation or inference request.
Reload ends those recovery actions. Signing out fences old attempts before navigation.

Audio leaves the device when the selected transcription provider requires an
upload. Transcription can go to a direct provider connection, the hosted Epicenter gateway, or a self-hosted endpoint.

See the repository [trust model](../../docs/trust-model.md) for hosted sync and account boundaries.

## There is no hosted browser deploy

`wrangler.jsonc` published the static SPA to `whispering.epicenter.so`. ADR-0227 refused that runtime: a browser tab is not a target, so the config and its deploy step are gone. Whatever Cloudflare last published keeps serving until somebody deletes the Worker, because removing the config stops republishing rather than taking anything down.

ADR-0227 says what would reopen this, which is trying-before-installing turning out to matter more than the capability seams cost.

## Recording verification

[Store-relative recording evidence](docs/store-relative-recordings-verification.md)
records the earlier product flow, review findings, and limits. Its Personal audio
copy verification is historical; that path has been retired.
