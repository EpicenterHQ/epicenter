# Direct runtime transcription clean break

The production native HTTP adapter and its package export are removed. Applications
use `openRuntimeTranscriber()` for native model listing and transcription; hosted
and custom destinations keep their network SDK clients. ADR-0424 is accepted.

## Model selection and ownership

The host owns the catalog and installed model files. `listModels()` returns opaque
IDs; `transcribe({ audio, model })` names an exact ID. TypeScript keeps that value
as a string instead of duplicating the host catalog as a literal union. Unknown
or uninstalled models fail. Explicit requests do not change the host's active
model setting and never substitute it for the requested model.

Local and its recorder normally live for the browser/WebView lifetime. The
recorder borrows Local blobs; closing it leaves Local usable. Closing Local
retires its recorders and drains accepted Stop publication. Departure stops
capture even if navigation stalls. These ownership rules were retained.

## Changes

- Removed `native-ai.ts`, its public subpath, and seven obsolete SDK adapter tests.
- Kept the seven existing direct-transcriber tests and added four covering host
  model metadata, unapplied hints, request cancellation without owner retirement,
  and cancellation while preparing audio.
- Moved the native fixture and smoke to `runtime-transcriber-fixture.ts` and
  `runtime-transcriber-smoke.ts`. Real Wry evidence now uses the public opener.
- Updated two existing network acceptance endpoints to invoke the direct
  transcriber. Their HTTP routes remain test-only because they exercise network
  clients, not native application access.
- Corrected the README and architecture map's API and page-lifetime descriptions.

The retired tests' bytes, model, hints, empty-result, validation, and cancellation
guarantees remain covered by direct tests and native probes. Multipart parsing,
unsupported HTTP routes, and SDK abort exception shapes belonged to the deleted API.

## Verification

Evidence and task-start copies are in `/tmp/epicenter-runtime-clean-break/`.

| Check | Result |
| --- | --- |
| Task-start direct and old adapter tests | 14 pass, 27 assertions |
| Direct, network inference, recorder, desktop recorder, store/blob tests | 62 pass, 196 assertions |
| Full app package suite | 821 pass, 3 fail; product-startup fixtures cannot resolve Wellcrafted imports |
| App package typecheck | Initially failed on `independent-blobs.test.ts` during concurrent blob changes; later workspace run reports app package exit 0 |
| Workspace typecheck | Fails in Local Mail, Honeycrisp, and Whispering; no whole-workspace green claim |
| Direct native smoke | Real cached Whisper Tiny through Tauri MockRuntime passes exact bytes/model/hints, unknown model, invalid/empty audio, cancellation drainage, and unchanged settings |
| Real Wry WebView | Public opener and production capability pass transcript, empty input, refused administration, retired access, and CSP checks |
| Existing native page ownership probe | Passes reload, stale first registration refusal, and successor surviving old close |
| Physical microphone probe | Fails before capture: CoreAudio cannot read device name, OSStatus 560947818 |
| Modified network acceptance scripts | Parse successfully; full product scenarios were not rerun |

The speech WAV was synthesized locally for file inference. No model download,
real settings change, or production request was required. File inference does
not establish physical microphone acceptance. The page ownership probe used the
existing compiled `capture_document_evidence` example; this change did not modify
its implementation. Actual page replacement during in-flight transcription was
not separately exercised; unit/native smoke checks cover cancellation drainage.

The failed broad checks are outside the changed transcription files. Their
task-start attribution was not independently reproduced. The later package
typecheck result is in `workspace-types.txt`; the earlier failure remains in
`types.txt` so the two runs are not conflated.

## Review

Files reviewed for this change, including task-start copies and partial reads:

```text
packages/app/
|-- {README.md,ARCHITECTURE.md,package.json,tsconfig.json}
|-- src/
|   |-- {ai,runtime-transcriber,native-ai}.ts
|   `-- {runtime-transcriber,native-ai,import-boundaries}.test.ts
`-- scripts/
    |-- {native-ai-fixture,native-ai-smoke}.ts [removed]
    |-- {runtime-transcriber-fixture,runtime-transcriber-smoke}.ts
    |-- native-webview-smoke.ts
    `-- shared-ai-catalog.native.mjs
apps/
|-- whispering/scripts/saved-recording.browser.mjs
`-- epicenter/
    |-- AGENTS.md
    `-- src-tauri/
        |-- tests/ai_runtime.rs
        |-- examples/capture_document_evidence.rs
        `-- src/transcription/{mod,model_cache,catalog}.rs
docs/
|-- adr/{README.md,0424-runtime-transcription-calls-the-host-directly.md}
`-- reports/20260922-runtime-transcriber-clean-break.md
specs/
|-- 20260909T171130-ai-runtime-integration.handoff.md
`-- 20260922T170434-page-owned-resources-and-direct-native-transcription.md
```

The prior review also traced the recorder/store and application composition;
this implementation review checked the changed native boundary and its callers.


Two independent read-only reviewers compared the changed surface to saved
task-start files. Neither found a blocking correctness or structural issue.
The direct IPC validation and admitted-work tracking earn their boundaries.
The test stdin bridge exercises actual Rust commands; the two small network
fixture routes do not justify another shared production adapter.

The package-wide blob and product changes already present in this checkout are
outside this clean break. No staging, commit, deployment, or data migration was
performed for this task.
