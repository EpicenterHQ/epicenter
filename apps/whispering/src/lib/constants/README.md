# Constants Directory

## Purpose

This directory holds immutable values shared across the app, including the language list, sound names, recording settings, and import formats. Inference connection presets belong to `@epicenter/client`; Whispering has no provider registry.

## What belongs here (and what does not)

A constant lives with the code that owns its meaning. Only put something here when it is **pure data** and **shared across modules** with no natural home. Everything else lives next to its owner:

- **Logic and functions** (formatters, guards, validators, normalizers) live in `$lib/utils` or `$lib/services`, never here. Example: shortcut parsing, labeling, and matching live in `$lib/utils/key-binding.ts`.
- **Types owned by one module** live in that module. Example: `DeviceAcquisitionOutcome` lives in the `@epicenter/recorder` package, which owns browser microphone device vocabulary.
- **Registries with behavior** live next to their service.
- **Build-target values** (platform identity) live behind the `#platform/*` seam (see below).

Rule of thumb: no computed behavior, no functions, no runtime schema objects. If you reach for `arktype` or write a function, it does not belong here.

## Directory Structure

```
constants/
├── audio/                  # Recording settings: bitrate, triggers, button icons (folder + barrel)
├── icons/                  # Provider brand SVG assets
├── import-formats.ts       # Supported recording import formats
├── languages.ts            # Supported transcription languages
└── sounds.ts               # Sound effect names
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
import { RECORDING_TRIGGER_OPTIONS } from '$lib/constants/audio';

// Flat domains are imported directly
import { SUPPORTED_LANGUAGES_OPTIONS } from '$lib/constants/languages';
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
