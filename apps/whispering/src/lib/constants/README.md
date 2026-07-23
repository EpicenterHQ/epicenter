# Constants Directory

## Purpose

This directory holds immutable, cross-cutting values that more than one part of the app needs and that have no single obvious owner: the language list, sound names, provider registries, and the setting-value enums the data Lens validates against.

## What belongs here (and what does not)

A constant lives with the code that owns its meaning. Only put something here when it is **pure data** and **shared across modules** with no natural home. Everything else lives next to its owner:

- **Logic and functions** (formatters, guards, validators, normalizers) live in `$lib/utils` or `$lib/services`, never here. Example: shortcut parsing, labeling, and matching live in `$lib/utils/key-binding.ts`.
- **Types owned by one module** live in that module. Example: `DeviceAcquisitionOutcome` lives in the `@epicenter/recorder` package, which owns browser microphone device vocabulary.
- **Registries with behavior** live next to their service. The transcription and inference registries stay here only because their service-ID enums are shared vocabulary the data Lens validates against.
- **Build-target values** (platform identity) live behind the `#platform/*` seam (see below).

Rule of thumb: no computed behavior, no functions, no runtime schema objects. If you reach for `arktype` or write a function, it does not belong here.

## Directory Structure

```
constants/
├── audio/                  # Recording settings: bitrate, sample-rate, triggers, button icons (folder + barrel)
├── icons/                  # Provider brand SVG assets
├── inference.ts            # Text-completion provider/model registry
├── languages.ts            # Supported transcription languages
├── local-model-unload-policy.ts  # Memory unload-policy setting (mirrored in Rust)
├── sounds.ts               # Sound effect names
├── transcription.ts        # Transcription service registry
└── urls.ts                 # App route pathnames
```

Domains with several files keep a folder and a barrel `index.ts` (`audio/`). A single-file domain is just a flat file: a one-line barrel re-exporting one file earns nothing.

## Platform Identity Lives Elsewhere

OS identity (`os.isApple`, `os.isLinux`) is not a constant in this folder. It is a process-constant fact that differs by build target, so it lives behind the `#platform/os` build seam:

```typescript
import { os } from '#platform/os';
```

The seam resolves to a Tauri impl (`@tauri-apps/plugin-os`) or a browser impl (user-agent sniff) at build time via `package.json`'s `imports` field and the `tauri` Vite condition. Each impl detects the OS once at module load and exports a typed `os` object (`isApple` covers macOS plus iOS/iPadOS on the web; `isLinux` is desktop Linux).

## Import Patterns

Import from a domain's folder barrel, or directly from a flat file:

```typescript
// Folder domains expose a barrel
import { SAMPLE_RATE_OPTIONS } from '$lib/constants/audio';

// Flat domains are imported directly
import { SUPPORTED_LANGUAGES_OPTIONS } from '$lib/constants/languages';
import { TRANSCRIPTION } from '$lib/constants/transcription';
```

Barrels use **explicit** exports (not `export *`) so bundlers can analyze them:

```typescript
// Good
export { RECORDING_TRIGGERS, type RecordingTrigger } from './recording-triggers';

// Avoid
export * from './recording-triggers';
```

## Adding a Constant

1. **Is it pure data shared across modules?** If not, put it next to its owner (utils, services, the type's module).
2. **Pick the domain.** Reuse an existing file or domain before creating a new one.
3. **Folder or flat file?** A folder with a barrel only once the domain has multiple files. Otherwise a flat `<domain>.ts`.
4. **Use `as const`** and explicit types. Document non-obvious values with JSDoc.
