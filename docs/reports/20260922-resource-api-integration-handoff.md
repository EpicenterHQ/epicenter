Finish the application integration of Epicenter's independent resource API in:

```text
/Users/braden/conductor/workspaces/epicenter/yamoussoukro
```

Implement and verify the remaining work. Do not restart the resource redesign or stop after another plan.

The resource API is already implemented in this dirty checkout:

```ts
const localBlobs = await openLocalBlobs({ id: 'so.epicenter.capture' });
const recorder = createRecorder({ localBlobs });
const remoteBlobs = await openRemoteBlobs({
  id: 'so.epicenter.library',
  account,
});
const uploaded = await remoteBlobs.upload(localBlobs, blobId, { signal });
```

The remote constructor owns the destination account and app namespace. Each upload supplies a real local source handle and the ID of committed bytes. Source and destination namespaces may differ. Upload creates an independent remote object and returns its URL; it never deletes local bytes. Remote reads need no local handle. Public direct-byte uploads and `addFrom` were removed without aliases. Recording always commits locally; successful Stop returns `{ blobId, durationMs, byteLength }` and creates no application row.

The user approved a clean break. Existing Whispering usage may be wrong and may break during implementation. Let explicit resource inputs and coherent application operations determine the UI integration. Do not restore an aggregate App API, compatibility methods, or implicit upload sources to accommodate old callers. Keyboard shortcuts, including replacement of the native shortcut API, are a separate future assignment.

The remaining work is application outcome ownership. Expected failures should stay in `Result` through composable application operations, until the final caller chooses recovery or presentation. One user action has one error-presentation owner. A browser event handler may ultimately return void, and a no-payload operation may return `Result<void, E>`; neither justifies swallowing failures inside a reusable workflow. Do not turn intentional no-ops or cancellation into misleading failures merely to eliminate null. Give meaningful outcomes names where callers must distinguish them.

Start by tracing these current files and their callers:

- `packages/app/README.md`, `ARCHITECTURE.md`, `src/blobs.ts`, `src/recorder.ts`.
- `apps/whispering/src/lib/operations/recording.svelte.ts`, `push-to-talk.ts`, `save-audio-recording.ts`, `upload-recording.ts`, `pipeline.ts`, and `transcription-history.ts`.
- `apps/whispering/src/lib/whispering/recordings.ts` and `resources.ts`.
- `apps/whispering/src/lib/report/index.ts` and `packages/ui/src/sonner/toast-on-error.ts`.
- The actual manual recording controller, upload action, command dispatch, and layout consumers discovered from those entrypoints.

Concrete remaining findings:

1. The recording controller's outer start/stop/cancel functions still call `report.error` internally and return strings, booleans, null, or void. Separate operation outcomes from their presentation. Preserve capture identity so a delayed push-to-talk release cannot stop a different recording. Keep lifecycle owners responsible for pending state, admitted work, and cleanup.
2. `stopCapture` can receive successful local publication and then return `NoActiveRecording` after departure, losing the saved blob ID in its returned outcome. Preserve completed work without publishing rows through a retired session. `RecordingCreationError.RowCreateFailed` already retains `audioBlobId` for ordinary row creation failures.
3. `uploadRecording` now returns `ReferenceNotSaved` with the remote URL when upload succeeds but row publication fails or is cancelled. Preserve and consume this distinction. Recovery must not blindly upload again. Do not claim a recovery UI exists merely because the error retains the URL.
4. Existing transcription history outcomes can retain usable text alongside a failed history write. Preserve this kind of partial success. A warning should not erase usable output.

Use the existing `toastOnError(result, title)` for a simple final toast; it returns the original result. Whispering's `report` also supports logging, OS notifications, persistent notices, and recovery actions. Keep or deliberately reshape those product behaviors at the presentation boundary. Add only a small Result-consuming reporter if actual callers need it. Do not create a giant action runner that owns retries, state, cancellation, navigation, and success callbacks.

Openers and `close()` retain their rejecting Promise contracts. Invalid or closed-handle use can throw. Startup must unwind partial acquisition and present a persistent failure state. Expected operational errors should be typed Results; unexpected bugs still need an explicit framework/crash boundary. Do not catch every unknown exception and relabel it as a retryable failure. Deliberate departure normally produces no toast.

Before editing, capture `git status --short --branch`, `git diff --name-status`, untracked paths, and `git diff --binary`. There is substantial unrelated work, including store implementations that are untracked. Preserve it. Earlier blob-change baseline artifacts are in `/tmp/epicenter-blob-api-baseline/` if still available, but capture your own starting state. Do not infer ownership from dirty status. Do not stage, commit, reset, deploy, or migrate data unless separately requested. Use Bun and the repository's skills.

Keep the public names unless concrete behavior exposes a naming problem: `open*` acquires a resource, `createRecorder` constructs an inert controller, `start/stop/cancel` describe capture, `add` creates a local blob, `upload` copies saved bytes remotely, `get` reads bytes, and `open` acquires a disposable display URL. Avoid a cosmetic rename wave. Update current documentation and examples when contracts change; historical references to rejected APIs can remain clearly historical. ADRs 0366, 0372, and 0423 record the resource direction; their formal statuses were not changed.

Use `adversarial-review` after reconstructing the operation/caller map, before committing to a broad UI migration. Review the cumulative result again before completion if lifecycle or outcome ownership changed materially. Resolve findings, update the remaining plan, and continue. Use `post-implementation-review` locally after repairs.

Previous verification, to re-establish as appropriate after your changes:

- App: 768 tests passed; package typecheck passed.
- Focused Client/Blobs/App checks: 33 tests passed.
- Host account-transport tests: 17 passed, including exact native source bytes and cancellation.
- Whispering upload tests: 4 passed, including preservation of the remote URL after row failure.
- Client, Blobs, and Whispering typechecks passed.
- Browser recording smoke passed capture, offline playback, cancellation, and reopened bytes.
- `git diff --check` passed.
- Full workspace typecheck reported an unused `asPrincipalId` import in `apps/local-mail/evidence/native-storage.ts:17`. This pass did not fix or establish baseline attribution for it. Verify current state before reporting it. Physical microphone and installed desktop acceptance were not established by the synthetic browser and loopback host checks.

Likely commands include `bun run --cwd packages/app test`, `bun run --cwd packages/app typecheck`, `bun run --cwd apps/whispering typecheck`, `bun run --cwd packages/app smoke:recording`, focused operation tests from Whispering's working directory, host transport tests, and `git diff --check`. Select tests that prove outcome propagation, partial success, cancellation, delayed release, and one presentation owner; avoid tests that merely mirror forwarding methods.

Done means the recording and upload workflows expose usable outcomes through their real callers, presentation happens at explicit final boundaries, saved bytes/remote URLs survive partial failures, current examples teach that model, and relevant browser/native evidence and checks pass or have precise remaining blockers. Return the final API and application callsites, deleted machinery, verification, and any actual product decisions still needed. Do not call the whole integration complete solely because the library tests pass.
