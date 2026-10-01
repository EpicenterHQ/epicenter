# Transcription provider registry: the from-scratch answer

**Superseded by**: `specs/20260912T112824-app-hub-and-whispering-transcription-collapse.md`

## Status

Accepted, implementing. Answers the brief in `20260527T003910-transcription-providers-from-first-principles.md`. Supersedes the narrow adapter collapse in `20260527T002843-cloud-transcription-collapse.md`.

## Decision in one paragraph

Collapse the two parallel descriptions of each provider (`TRANSCRIPTION` in `constants/transcription.ts` and `TRANSCRIPTION_SERVICES` in `services/transcription/registry.ts`) into **one `PROVIDERS` record** keyed by service ID. It owns every fact: label, location, models, capabilities, and the deviceConfig/settings key *names* (not values). Behavior is **not** in the record. The `id -> transcribe` wiring is a static table in the dispatcher, where the SDKs already load today. The 8-case dispatch switch collapses to 3 location branches. The two hardcoded key maps in `transcription-validation.ts` and the per-provider switches in the selectors read their keys from `PROVIDERS` instead of redeclaring them.

## Why no lazy imports

An earlier draft put a lazy `load: () => import('./cloud/openai')` on each entry so the merged record could be imported by the workspace schema (for `PROVIDER_IDS`) without bundling the SDKs. That solved a problem the merge itself created. The thing that was duplicated is the **metadata**, never the behavior. So we keep behavior out of `PROVIDERS` entirely: the schema imports `PROVIDERS` (pure data, no impl imports, no SVGs), and the dispatcher holds a static `id -> transcribe` table that imports the impls. SDKs load on first transcription via the dispatcher, exactly as today. No lazy hop, no new latency, same code-splitting behavior. Simpler and honest.

## What this is NOT

Not a `createProvider`/`BaseService` factory. `PROVIDERS` is a plain data table; the transcribe impls stay hand-written and mutually different (Mistral's `.complete()`, ElevenLabs's SDK, Speaches's friendly self-hosted errors all survive untouched). The table standardizes how impls are looked up and called, not how they work.

## The seven frames

- **F1 (are these services?)**: HTTP adapters, not services, but renaming the files is high-churn and orthogonal. Keep `services/transcription/cloud/*.ts` where they are; stop exporting `*ServiceLive` objects (F5).
- **F2 (registry earning its keep?)**: No. Merge into one `PROVIDERS` record; `name`(=label) and `location` stop being two sources.
- **F3 (switch or table?)**: The id->impl lookup becomes a static table; options-building stays a 3-way location branch in the dispatcher (option shapes genuinely differ by location, and Audit C says settings-access lives in the dispatcher). Zero per-provider cases inside `cloud`.
- **F4 (cloud + self-hosted)**: One list, `location` discriminant. One `PROVIDERS`; the UI joins it with icons.
- **F5 (smallest surface?)**: The per-provider `*ServiceLive` exports are vestigial; make the impls internal `transcribe` fns and delete the `services/transcription/index.ts` aggregator.
- **F6 (error types)**: Orthogonal and contested. Leave per-provider `XxxError` blocks intact; a `TranscriptionProviderError` collapse is its own later spec.
- **F7 (retry)**: Out of scope. If added, in the dispatcher.

## File layout

```
PROPOSED
services/transcription/providers.ts        PROVIDERS record + TRANSCRIPTION_SERVICE_IDS + CloudProviderId. Pure data, schema-safe.
services/transcription/provider-ui.ts      PROVIDER_ICONS + TRANSCRIPTION_PROVIDERS (the UI-facing id+fields+icon join). The one SVG-importing file.
operations/transcribe.ts                   static CLOUD_TRANSCRIBERS table + 3 location branches.
services/transcription/cloud/*.ts          same impls, exported as plain transcribe fns.
DELETED: constants/transcription.ts, services/transcription/registry.ts, services/transcription/index.ts
```

### Why icons are a separate file

The schema imports `PROVIDERS` for `TRANSCRIPTION_SERVICE_IDS`. SVG `?raw` imports are the one field heavy enough to ride into the schema's bundle, so they live in `provider-ui.ts` keyed by the same ID. Every other fact stays single-sourced in `PROVIDERS`. This is the one split that pays for itself.

## Migration plan (3 waves, each `bun run typecheck` green)

1. **Add** `providers.ts` + `provider-ui.ts` (and the derived `TRANSCRIPTION_PROVIDERS` array). No consumer changes. Additive, green.
2. **Repoint data consumers**: workspace schema (`TRANSCRIPTION_SERVICE_IDS`, `defaultModel`), settings `+page.svelte` model lists, `transcription-validation.ts`, the two selectors -> `PROVIDERS` / `TRANSCRIPTION_PROVIDERS` / `PROVIDER_ICONS`. Delete `constants/transcription.ts`.
3. **Rewrite dispatch**: static `CLOUD_TRANSCRIBERS` table + 3 location branches; export `cloud/*.ts` as plain `transcribe` fns; delete `registry.ts` and `index.ts`.

Inference is a deferred follow-up (separate spec), not in this PR.

## Honesty: what gets worse

- **The workspace schema imports from `services/transcription/`** (for `TRANSCRIPTION_SERVICE_IDS`), a data-model -> service arrow. Not a cycle (services/transcription does not import workspace). The alternative (a third pure-data ID module) reintroduces the split we are removing.
- **One record is denser** than the two files it replaces (~190 vs 211 + 166 lines), though it is fewer total lines and one fewer concept.
- **`provider-ui.ts` is a deliberate second file** for the UI join and icons, justified only because SVGs are the one schema-polluting import.

## Non-goals

No new providers. No Rust changes. No error-type collapse (F6 deferred). No retry. No recording/storage-path changes. No inference migration in this PR.
