# Whispering design review, 2026-09-18

> Historical checkpoint: the findings below describe the named review baseline.
> Integration on 2026-09-18 committed the retained evidence and removed the
> unmounted initial-generation experiment. The App API has since moved to
> `open(account)`; claims about dirty files and missing openers below are historical.


Keep recording independent of transcription setup. Two independent, read-only GPT-6 reviewers examined capture semantics and startup ownership. They found no reason to reverse the product direction. This was an affected-system review, not an audit of every package.

## Review baseline

Reviewed commits `1aa9587400` and `da0e1e0562`, against `8d629d7354`, with HEAD at `2bca7c13eb`. The latter also contains a separate AppBoot readiness change. Existing dirty startup, platform, documentation, and planning edits were preserved.

## Evidence read

Both reviewers traced implementations and callers, rather than relying on ADR claims. File groups below include excerpts.

```text
apps/whispering/
|-- AGENTS.md, README.md
|-- scripts/saved-recording.browser.mjs
`-- src/
    |-- lib/
    |   |-- application.ts, application.test.ts, bootstrap.ts, auth.svelte.ts, data.ts
    |   |-- platform/auth.epicenter-host.ts
    |   |-- components/
    |   |   |-- LibrarySelection.svelte, TranscriptionModelPicker.svelte
    |   |   `-- settings/{TranscriptionRuntimeConfig.svelte,selectors/TranscriptionSelector.svelte}
    |   |-- operations/
    |   |   |-- import.ts, pipeline.ts, pipeline.test.ts
    |   |   |-- recording.svelte.ts, recording.svelte.test.ts, recording-close.test.ts
    |   |   |-- save-audio-recording.ts, settings.ts
    |   |   `-- transcribe.ts, transcribe.test.ts, transcription-history.ts
    |   |-- queries/transcription.ts
    |   |-- settings/transcription-validation.ts
    |   |-- state/{inference-connections.svelte.ts,recording-active.svelte.ts,settings.svelte.ts,vad-recorder.svelte.ts}
    |   `-- whispering/{app.ts,ui-session.ts}
    `-- routes/(app)/
        |-- +layout.svelte, +page.svelte, (config)/recordings/+page.svelte
        `-- _components/{RecordingResult.svelte,VerticalNav.svelte,WhisperingShell.svelte}
apps/epicenter/{AGENTS.md,src/server.ts}
apps/skills/src/{lib/application.ts,routes/+layout.svelte}
packages/
|-- app/{README.md,src/index.ts,src/open.ts}
|-- app-shell/
|   |-- smoke/app-boot.browser.mjs
|   `-- src/
|       |-- boot-screens/{app-boot.svelte,departure.ts,departure.test.ts,desktop-close.ts}
|       |-- inference-selections.ts
|       `-- inference-picker/{connections.svelte.ts,inference-picker.svelte}
|-- data/{README.md,src/store/browser.ts}
|-- server/{README.md,src/store-sync/mount.ts}
`-- svelte/src/from-subscription.svelte.ts
specs/
|-- 20260909T004225-library-ownership-execution.md
`-- 20260912T112824-app-hub-and-whispering-transcription-collapse.md
docs/reports/20260917-startup-and-unfinished-work.md
```

## Accepted findings and repairs

1. **An admitted save may finish after capture admission closes.** Manual stop previously checked `recordingEnabled` after native finalization and could skip creating the recording row even though its bytes were saved and the App remained alive. This condition existed at `8d629d7354`. Removed that post-stop admission check, retaining disposal and aborted-App checks. Moved the existing close regression test to close admission before native finalization completes. It failed before the repair and passed afterward.
2. **Processing consumes the choice captured by its producer.** Manual recording, VAD, and import already pass the captured transcription operation or null. Made that input required and deleted the pipeline fallback that recaptured current settings. Updated test callers to supply their intended operation. The pipeline mock tests do not independently prove execution of the captured operation.
3. **The no-model caption observes the same selection changes as capture.** The homepage used a nonreactive selection getter. It now uses the existing `fromSubscription` adapter over selection notifications. This keeps an unavailable selected model distinct from no selection, without adding another shared public accessor.
4. **Acceptance uses the actual library menu.** Replaced obsolete Library navigation/button selectors with the labelled dropdown trigger and radio menu item. Preserved the assertion that the old library closes before navigation.

The repairs leave file organization and lifecycle ownership unchanged. No new manager, alternate startup endpoint, or persisted state was introduced.

## Stronger invariants worth pursuing next

- AppBoot alone decides whether product UI is mounted. Whispering's separate `showing` flag is a deletion candidate; retain the UI drain callback and `await tick()` ordering. Defer this while the separate App refactor is active.
- One resolved transcription configuration should distinguish absent, unavailable, and runnable choices. That could remove repeated interpretations in readiness, capture, and page copy. Do not silently treat an unavailable configured destination as audio-only.
- Remove the unused `removeLocalData` prop chain through WhisperingShell and VerticalNav and its stale blob ownership commentary. No mounted caller supplies it. This is a small cleanup, not a reason to redesign storage.
- Keep current-library acquisition as the sole startup contract. Unmounted historical generation helpers are deletion candidates, not endpoints to restore. Skills remains a separate product decision.

Keep AppBoot, Departure, and App resource cleanup as distinct owners: mounting, ordered shutdown, and physical resource release have different responsibilities.

## Product judgment

Audio-only currently applies when no transcription selection exists. After configuration, recordings transcribe automatically; the picker has no way to return to audio-only. Recommend an explicit “Save audio only” choice while preserving automatic transcription for people who select a model. This is a proposal, not implemented by the review repairs.

The separate multi-library App proposal must preserve local recording when account startup fails, retain a recording's destination across navigation, and explicitly decide whether always claiming Local should prevent a second app window. Do not infer those answers from a code cleanup.

## Verification and limits

Independent review runs: transcription 13 passed, recording 20 passed, pipeline 13 passed; departure plus application 20 passed.

After repairs: recording-close 10 passed; pipeline 13 passed. The revised close test first produced 9 passed and 1 failed before the production fix. `git diff --check` passed for the repaired Whispering files.

During verification, another active change replaced `Application.openLocal/openPersonal/openShared` with `open` and changed the App handle in `packages/app/src/index.ts` and `open.ts`. Whispering still calls the former API. The full typecheck reported 36 errors in 12 files, including missing openers and App members. Those shared files were clean at the review's initial inventory and changed during the review. They were not altered or reverted here. End-to-end acceptance must be rerun after that integration settles; this review does not claim a green current checkout.

A fresh browser smoke attempt remained at “Opening your recordings…” with `Cannot convert undefined or null to object` and timed out after 90 seconds. It did not reach the caption or recording assertions. Its precise runtime failure has not been isolated from the concurrent refactor. Log: `/tmp/whispering-review-browser.log`.

The heavyweight saved-recording harness was not run: its required speech WAV at `/tmp/app-ai-baseline/native-speech.wav` was absent. Physical microphone, audible native playback, and native quit/relaunch persistence remain manual acceptance work. Earlier browser passes are historical evidence, not verification of the concurrently changing App API.

Review repairs remain uncommitted and separate from the two already committed UI/capture changes. Nothing was pushed.
