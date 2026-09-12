# App scopes, the device store, and the Whispering transcription collapse

**Date**: 2026-09-12
**Status**: Draft
**Owner**: Braden
**Branch**: braden-w/app-schema-derive-export-import (design only; execution branch to be chosen)
**Supersedes**: `apps/whispering/specs/20260527T002843-cloud-transcription-collapse.md`, `apps/whispering/specs/20260527T003910-transcription-providers-from-first-principles.md`, `apps/whispering/specs/20260530T183000-transcription-provider-registry.md`

## One Sentence

One open returns an App with a `device` scope and an optional `account` scope sharing one `kv`, `tables`, and `blobs` implementation, `device` becomes the machine's declared store, and Whispering's transcription shrinks to a twenty-line operation over `connection.transcribe`.

How to read this spec:

```txt
Read first:
  One Sentence, Current State, Target Shape, Implementation Plan, Verification
Read if changing the architecture:
  Design Decisions, Edge Cases, Open Questions
Durable decisions (all Proposed):
  docs/adr/0392  an App has a device scope and an account scope, and each store
                 sits under its owner
  docs/adr/0399  moving data into an account is a row copy (supersedes 0143)
  docs/adr/0400  device sqlite and secrets key by application id
  docs/adr/0401  a record names its destination at creation
  docs/adr/0396  a connection transcribes and owns the four rules
  docs/adr/0397  native inference selects an installed model explicitly (amends 0180)
  docs/adr/0398  every transcription destination speaks the OpenAI wire
```

## Overview

Three changes that depend on each other in order: the App splits into a `device` scope that is always present and an `account` scope that appears when a person is signed in; device state and inference selections move into `app.device.kv`; the platform gains a `Connection` type with `transcribe` and the `connectionFor` lookup, and Whispering deletes every transcription file it owns except the operation that connects its selection, its blob, and its history.

## Motivation

### Current State

An App is one library, chosen before open (`apps/whispering/src/lib/bootstrap.ts`):

```ts
export type Library = 'local' | 'personal' | 'shared';
export const library: Library = (() => {
	const saved = localStorage.getItem('whispering.library');
	...
})();
...
if (library === 'local') return application.openLocal();
if (library === 'personal') return application.openPersonal(account);
return canOpenShared ? application.openShared(account) : null;
```

Device state has no home on the App, so Whispering persists it three ways beside the App:

| State | Mechanism | Scope |
| --- | --- | --- |
| inference selections | `localStorage` via `createInferenceSelections` (`packages/app-shell/src/inference-selections.ts`) | per app |
| microphone, endpoints, global shortcuts | `localStorage` via `createPersistedMap` (`apps/whispering/src/lib/state/device-config.svelte.ts`) | per app |
| API keys | `app.secrets` | per app and library identity |
| preferred transcription model | synced `kv` key `transcriptionModel`, compared against the local selection before each run | synced |

Transcription dispatch (`apps/whispering/src/lib/operations/transcribe.ts`) branches over a nine-member `transcriptionService` select of which four values dispatch: `connection`, `Deepgram`, `ElevenLabs`, `Mistral`. The other five (`epicenter`, `OpenAI`, `Groq`, `local`, `speaches`) return `SelectionRequired` and survive only in `services/transcription/providers.ts`, `provider-ui.ts`, `provider-ids.ts`, and `operations/transcription-target.ts`. The transcribe test does not load: `cloud/mistral.ts` imports through the `$lib` alias, which `bun test` does not resolve.

This creates problems:

1. **Device preferences are scoped wrong or not at all.** A per-library device scope would forget the microphone on sign-out; the per-app `localStorage` scope outlives the App and is undeclared and untyped.
2. **Adoption exists only because Local is a store to move.** ADR-0143's Add, Delete, Keep flow and its per-field concerns disappear if the device store is always open.
3. **Four platform rules are re-implemented per app.** Exact destination matching with no fallback, capture before I/O, account 402 as out-of-credits, and post-closure output suppression are typed out in `transcribe.ts` and again in `operations/completion.ts`.
4. **Whispering owns a transcription catalog it does not need.** Every OpenAI-wire destination (account, native runtime, custom endpoint, Mistral) is one SDK call; the catalog and dead ids exist for two non-OpenAI providers with no known users.

### Desired State

```ts
const app = await open(account);                 // Account | null

app.device.kv.get('transcription')               // { connectionId, model } | null, this machine
app.account?.personal.tables.recordings          // synced
app.device.sqlite.open('search-index')           // borrowed or derived, any library
app.device.secrets                               // credentials

const connection = connectionFor(app, app.device.kv.get('transcription'));
const { data: text, error } = await connection.transcribe(model, { audio, language, prompt });
```

Whispering's `operations/transcribe.ts` after the change:

```ts
export async function transcribeAudio(store: BlobStore, audioBlobId: BlobId) {
	const app = getApp();
	const selection = app.device.kv.get('transcription');
	const connection = connectionFor(app, selection);
	if (!connection) return TranscribeOperationError.SelectionRequired();
	const language =
		app.account?.personal.kv.get('transcriptionLanguage') ??
		app.device.kv.get('transcriptionLanguage');
	...
	const { data: audio, error: blobError } = await store.blobs.get(audioBlobId);
	if (blobError) return Err(blobError);
	return connection.transcribe(selection.model, { audio, language, prompt });
}
```

## Research Findings

### What the App already owns

`packages/app/src/open.ts` composes the App as `Object.assign(document.store, document.view, { appId, dataId, account, ready, signal, retirement, close, blobs, sqlite, secrets, recording, ai })`. `sqlite` and `secrets` are already device-local and keyed by app id plus replica identity through `DeviceSqliteOwner.acquire(appId, replica)` (`packages/device/src/owner.ts`). A Local library is already a store instance with no authority.

**Key finding**: `app.device` is the existing store with sync off, plus a re-keyed `sqlite` owner. No second kv or tables implementation is needed.

### What the platform already provides for transcription

- `matchInferenceTarget` (`packages/app-shell/src/inference-selections.ts`) matches `{ connectionId, model }` to an exact client over today's `app.ai.account`, `app.ai.runtime`, and `app.ai.connections`, with no fallback. It is deleted by ADR-0396.
- The native runtime (`packages/app/src/native-ai.ts`) speaks `POST /v1/audio/transcriptions` and requires an explicit model id; it invokes the `transcribe_audio_bytes` command, which calls `ModelCache::transcribe_explicit`. `transcribe_recording` (the active-model command from ADR-0180) has no caller, but it is re-exported in `apps/whispering/src/lib/tauri.tauri.ts` and typed in both `bindings.gen.ts` files, `commands.test-d.ts`, and `local-model-boundary.test.ts`, so its deletion touches five places plus the Rust command and its permission files.
- `matchInferenceTarget` returns only a client. A `Connection` with `id`, `label`, `client`, `models`, and `transcribe` is new construction, not a move.
- Mistral's `POST /v1/audio/transcriptions` is multipart with `file`, `model`, `language`, returning top-level `text`: the OpenAI wire. Verified against docs.mistral.ai on 2026-09-12; verify with a real key that an extra `prompt` field is tolerated before deleting the adapter.
- Deepgram (`/v1/listen`) and ElevenLabs (`/v1/speech-to-text`) are not OpenAI-wire.
- `openai` `TranscriptionCreateParams` types `language?: string` and `prompt?: string`, so optional request fields need no `?? undefined`.
- Abort: OpenAI SDK `signal`, ElevenLabs `abortSignal`, Mistral `fetchOptions.signal`. `HttpService.post` forwards none.

**Key finding**: only two providers justify any dispatch beyond one SDK call, and nothing in `apps/whispering/src` branches on their error names.

### Error consumers

`report.error({ cause })` renders `humanize(name)` plus `message`. `operations/credit-action.ts:10` and `routes/(app)/(config)/recordings/+page.svelte:445` branch on `InsufficientCredits`. Nothing branches on `Unauthorized`, `RateLimit`, `MissingApiKey`, or `FileTooLarge`.

### Shared is singular

ADR-0375: Shared is one library per application per self-hosted deployment. `app.account.shared` is honestly a single optional value.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Two scopes per page, up to three libraries | 2 coherence | One open returns `{ device, account? }` where `account` carries `personal` and optional `shared` | ADR-0392, superseding ADR-0389's opener union. A page still owns one auth generation; only the "one library" half of ADR-0369 changes. |
| `device` is per app per machine, not per library identity | 1 evidence | Device preferences survive sign-out; `sqlite` and `secrets` key by app id | ADR-0400. A microphone or native-runtime selection does not depend on the account. |
| Adoption is a row copy | 2 coherence | Delete ADR-0143's Add, Delete, Keep | ADR-0399. With `device` always open there is no store to move. |
| Every record names its destination | 2 coherence | A destination control beside each create action, remembered in `device.kv` | ADR-0401. |
| Separate `kv` declarations for `device` and the synced libraries | 2 coherence | `defineData({ kv, tables, device: { kv } })` | ADR-0392 Decision. A device key must not exist on `personal.kv`. |
| `sqlite` and `secrets` only on `device` | 3 taste | No symmetry for borrowed data | Borrowed data and credentials are machine-bound; a visibly different surface is the signal. Revisit if a synced table ever needs raw SQL. |
| Keep `kv` as the name | Deferred | Deferred | Rename to `settings` only after checking Honeycrisp and Vocab `kv` contents. |
| `Connection.transcribe` and `connectionFor` live in `packages/app` | 2 coherence | Platform rules once | ADR-0396. The four rules in Motivation §3 are platform invariants, and the account scope already knows which connection is metered. |
| Transcription is connection-only first | 3 taste | Delete Deepgram, ElevenLabs, Mistral adapters | ADR-0398. Mistral becomes a preset; the other two have no named users. A non-OpenAI wire returns as a `TranscriptionTarget` union plus one `switch` inside `transcribe` when someone asks. |
| Drop synced `transcriptionModel` | 2 coherence | The `device.kv` selection is the one store | ADR-0363 as revised. A model is meaningful only relative to a connection, and connections are device-scoped. |
| Native runtime carries an explicit model | 1 evidence | Keep `transcribe_audio_bytes`; delete `transcribe_recording` | ADR-0397, amending ADR-0180 and ADR-0012. The code, ADR-0363, and ADR-0365 already treat native inference as a connection with models. |
| Request fields are optional strings | 1 evidence | `language?: string; prompt?: string` | Matches the SDK; the operation maps `'auto'` and `''` to absent once. |

## Architecture

```txt
open(account)
  -> app { device, account? }               one auth generation, app.signal
       device:  store(definition, authority: none) + sqlite + secrets
                + connections + recording
       account: identity
                + personal: store(definition, authority: account replica)
                + shared?:  store(definition, authority: deployment replica)
                + connection: the server's gateway

connectionFor(app, { connectionId, model })
  -> exact Connection or null; no fallback   (replaces app-shell matchInferenceTarget)

connection.transcribe(model, { audio, language?, prompt? })
  -> tryAsync(client.audio.transcriptions.create({ file, model, language, prompt }, { signal }))
  -> Unavailable | Rejected(status, detail) | Unreachable(cause) | Malformed
  -> account connection + 402 => InsufficientCredits
  -> app.signal.aborted after the call => Closed
```

### The Connection surface

From ADR-0396:

```ts
type InferenceSelection = { connectionId: string; model: string };

type Connection = {
	id: string;
	label: string;                      // the custom name, the server host, or "This device"
	client: OpenAI;                     // chat and everything else go through the SDK directly
	models: readonly string[];
	transcribe(
		model: string,
		request: { audio: Blob; language?: string; prompt?: string },
	): Promise<Result<string, TranscriptionError>>;
};

app.device.connections.get(id): Connection | null       // native runtime and custom endpoints
app.device.connections.getAll(): Connection[]
app.account?.connection: Connection                     // the server's gateway

connectionFor(app, selection: InferenceSelection): Connection | null

const TranscriptionError = defineErrors({
	Unavailable:         ({ provider }) => ...,                   // retired before the call sent
	Rejected:            ({ provider, status, detail }) => ...,   // server answered with an error
	Unreachable:         ({ provider, cause }) => ...,            // transport failed
	Malformed:           ({ provider }) => ...,                   // no text in the response
	InsufficientCredits: () => ...,                               // account gateway, 402
	Closed:              () => ...,                               // App retired during the call
});
```

`language` is an ISO code and absent means the model detects it; `prompt` carries the prompt plus the dictionary and absent means no hint. `provider` is `connection.label`.

The wire call is a bare function `transcribeOverOpenAiWire(label, client, request)` with `tryAsync` around only the SDK call and a block-body `catch` of flat guards. No closures, no nested `Result`.

## Call sites: before and after

### Whispering bootstrap

**Before** (`apps/whispering/src/lib/bootstrap.ts:17-50`): reads `whispering.library`, computes `account`, picks one of three openers, creates `selections` beside the App.

**After**:

```ts
export const app = shouldOpen ? open(signedInAccount) : null;
```

**Semantic shift to flag**: `library` and `LibrarySelection.svelte` are gone. Recording gains a destination control. `departure` takes `auth` whenever `app.account` exists.

### Readiness

**Before** (`apps/whispering/src/lib/settings/transcription-validation.ts:33-42`): a hardcoded id list plus `app.inferenceConnections.canServe('transcription', app.settings.get('transcriptionModel'))`.

**After**:

```ts
const ready = connectionFor(app, app.device.kv.get('transcription')) !== null;
```

### Picker write

**Before** (`apps/whispering/src/lib/components/TranscriptionModelPicker.svelte:19-21`): writes `transcriptionModel` and `transcriptionService` and the selection.

**After**:

```ts
onSelectModel={(connectionId, model) => app.device.kv.set('transcription', { connectionId, model })}
```

## Implementation Plan

Each wave is one reviewable commit or a short series, green on `bun run typecheck` in every touched package and the tests named in Verification. Build, prove, remove.

### Wave 1: the two scopes (packages/data, packages/app, packages/device)

- [ ] **1.1** `packages/app`: one `open(account)` that returns `{ device, account?, signal, ready, close }`. `device` carries `kv`, `tables`, `blobs`, `sqlite`, `secrets`, `connections`, and `recording`; `account` carries `identity`, `personal`, optional `shared`, and `connection`. Internally the three existing store constructions; `device` always constructed.
- [ ] **1.2** `packages/device`: `DeviceSqliteOwner.acquire(appId)` keyed by app id only; `secrets` likewise. Delete replica-identity scoping and its tests' identity permutations.
- [ ] **1.3** `device.kv` and `device.tables` are the existing store with no authority. Confirm that no code path assumes the Local library is exclusive of an account session.
- [ ] **1.4** `RecordingFactory` drops its `replica` argument and becomes `(appId, options) => RecordingOwner`; `start(params)` takes the destination store, and `Recording.replica` records where the capture went (ADR-0392, ADR-0401). Update `packages/app/src/recorder.ts` and `recording.test.ts`.
- [ ] **1.5** Tests in `packages/app`: `device` present with a null account; `account.personal` present with an account; a device value written while signed in is read after reopening with a null account; `sqlite.open` is shared across account states.
- [ ] **1.6** Delete `openLocal`, `openPersonal`, `openShared`. Update ADR-0375's implementation note through ADR-0392, do not edit ADR-0375's decision.

### Wave 2: apps onto the two scopes (one commit per app)

- [ ] **2.1** Whispering: `bootstrap.ts` and `application.ts` onto `open`; delete `Library`, `whispering.library`, `LibrarySelection.svelte`; recording gains a destination control that defaults to `account.personal` when present.
- [ ] **2.2** Honeycrisp: same in `apps/honeycrisp/src/lib/application.ts`.
- [ ] **2.3** Vocab and local-mail: same.
- [ ] **2.4** Whispering: move `deviceConfig` entries into `device.kv` declarations; delete `createPersistedMap` usage and `state/device-config.svelte.ts`. Move the selections into `device.kv`; delete the storage half of `createInferenceSelections`, keep `matchInferenceTarget` until wave 3 replaces it. Delete `data.local-model-is-not-synced.test.ts` and the `secrets` facade.
- [ ] **2.5** Delete ADR-0143 and its references; flip ADR-0392 only when told.

### Wave 3: platform transcription (packages/app)

- [ ] **3.1** Add the `Connection` type in `packages/app` with `id`, `label`, `client`, `models`, and `transcribe`. Build `transcribeOverOpenAiWire` and the error set above; add `signal` to whatever HTTP helper is used if not the SDK.
- [ ] **3.2** Put `app.device.connections` (native runtime plus custom endpoints, returning `Connection`) and `app.account.connection` (the server's gateway) on the App. The account gateway is the only one that maps 402 to `InsufficientCredits`; a self-hosted 503 stays `Rejected` with the server's detail.
- [ ] **3.3** Export `connectionFor(app, selection)` from `@epicenter/app` beside the selection type. Delete `matchInferenceTarget` and the storage half of `packages/app-shell/src/inference-selections.ts`; the picker keeps its presentation and assembles its list from `device.connections.getAll()` and `account?.connection`.
- [ ] **3.4** Tests in `packages/app`, moved nearly verbatim from `apps/whispering/src/lib/operations/transcribe.test.ts`: multipart bytes and hints reach the exact client; a selection edit during a delayed blob read cannot retarget; a removed connection fails as `Unavailable`; account 402 is `InsufficientCredits` and custom 402 is `Rejected`; malformed bodies are `Malformed`; a late completion after closure is `Closed` and publishes nothing.

### Wave 4: Whispering transcription collapse

- [ ] **4.1** Stop importing the old path: `operations/transcribe.ts` onto `connectionFor` and `connection.transcribe`; `transcribeAndPersist` unchanged in shape. `operations/completion.ts` moves to `connectionFor` too.
- [ ] **4.2** Readiness and the Polish destination sentence derive from `connectionFor`; delete `settings/transcription-validation.ts` and `operations/transcription-target.ts` with its four dead-id tests.
- [ ] **4.3** Narrow `data.ts`: delete `transcriptionService`, `transcriptionModel`, and the five per-provider model keys; keep `transcriptionLanguage`, `transcriptionPrompt`, `dictionary`.
- [ ] **4.4** Verify: typecheck both leaves, `bun test` for the operations and queries suites, manual smoke against the account gateway, the native runtime, and a Mistral preset with a real key.
- [ ] **4.5** Delete `services/transcription/` entirely, the three provider secret keys, the transcription rows of `ProviderConfigFields.svelte`, the "Other transcription providers" group, and the three superseded specs. Rewrite `services/transcription/README.md` out of existence and the transcription paragraphs of `apps/whispering/ARCHITECTURE.md`.
- [ ] **4.6** ADR-0397 already amends ADR-0180 for explicit native model selection. Delete the Rust `transcribe_recording` command and `tauriOnly.transcribeRecording` in a separate commit with the `tauri` skill loaded.

## Edge Cases

### Signed out with a personal selection saved

1. `device.kv.transcription` points at `account:[...]`.
2. `app.account` is null, so `connectionFor` returns null.
3. Readiness says choose a connection; the saved value is retained so the UI can explain it (ADR-0363 behavior, unchanged).

### Recording while the account changes

1. A recording is admitted against `app.account.personal.blobs`.
2. The auth generation ends; the page closes per ADR-0369's surviving half.
3. Recovery on the next page finishes the capture into `device` if `account` is gone. Confirm against the existing recovery path before wave 2.1.

### Two tabs writing `device.kv`

1. Both tabs are the same app on the same machine.
2. `device` is a store instance with no authority; concurrent writes need the same in-process serialization the browser sqlite worker already provides.
3. Verify with the worker lock tests in `packages/device` before wave 1.3 lands.

## Open Questions

1. **`kv` or `settings`?**
   - Deferred until Honeycrisp and Vocab `kv` contents are audited.

2. **Boot cost of reading `device.kv` from the sqlite worker before first paint.**
   - Options: (a) read whole at open inside `ready`; (b) keep a `localStorage` mirror for first paint.
   - **Recommendation**: (a). Measure before adding a mirror.

Decided since the first draft and moved into records: there is no shared dictation capability, each app composes `app.device.recording` with `connection.transcribe`, and a helper is promoted only when a second app needs more than the two calls (ADR-0365 as revised 2026-09-12; the `specs/20260908-ai-client-and-portable-dictation.md` plan is deleted and its native capture half continues in `specs/20260912T122859-concurrent-native-capture.md`); the account menu strings "Sign out" and "Sign out and remove account data from this device", with "this device" for machine scope and "Local" only for the library (ADR-0399 amending ADR-0351); separate `kv` declarations for `device` and the synced libraries (ADR-0392); the default recording destination is `account.personal` when present, remembered in `device.kv` (ADR-0401); `Connection.client` puts the `OpenAI` SDK type on the App's surface, accepted by ADR-0396 as a named consequence, so replacing the SDK later is a breaking change to that type.

## Adjacent Work

- `queries/transcription.test.ts` fails on `$app/paths` in `vad-recorder.svelte.ts`; unrelated to this spec, fix when touched.
- The hosted STT model id is spelled in four places (`STT_MODEL` in `packages/server/src/routes/transcription.ts`, `HOSTED_STT_MODEL` in `apps/api/worker/billing/policies.ts`, the Whispering picker's `accountModels`, and `VOCAB_STT_MODEL` in `apps/vocab/src/lib/data.ts`). One export from `@epicenter/constants` per ADR-0398, when the picker is touched in wave 4.
- ADR-0391 already removes `runtime` and `ai` from `defineApplication`; wave 1.1 should land on its target, not the current signature.

## Success Criteria

- [ ] `open(null)` returns an App whose `device` works with no account; `open(account)` adds `account.personal`, `account.connection`, and, on a self-hosted deployment, `account.shared`.
- [ ] A device preference written while signed in is read after sign-out.
- [ ] Whispering has no `localStorage` writes except the auth client's.
- [ ] `apps/whispering/src/lib/services/transcription/` does not exist; `operations/transcribe.ts` is under forty lines including `transcribeAndPersist`.
- [ ] `matchInferenceTarget` exists nowhere; `connectionFor` is the one matching function.
- [ ] The six transcribe tests pass in `packages/app`; readiness and the Polish sentence have one test each in Whispering.
- [ ] `bun run typecheck` green in `packages/app`, `packages/device`, `packages/app-shell`, and all four apps on every leaf.
- [ ] ADR-0392 accurate to the code; ADR-0143 deleted; ADR-0180 amended.

## References

- `docs/adr/0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md` - the decision this spec executes
- `docs/adr/0396-a-connection-transcribes-and-owns-the-four-rules.md` - the `Connection` type, `connectionFor`, and the error set
- `packages/app/src/open.ts` - current App composition
- `packages/app/src/index.ts` - `defineApplication` and the three openers to delete
- `packages/app/src/recorder.ts` - `RecordingFactory` and `start`, whose `replica` argument moves
- `packages/device/src/owner.ts` - `DeviceSqliteOwner` keying to change
- `packages/app-shell/src/inference-selections.ts` - `matchInferenceTarget` and the storage half, both deleted
- `packages/app/src/native-ai.ts` - native runtime transport, explicit model
- `apps/whispering/src/lib/operations/transcribe.ts` - current dispatch and the tests that move
- `apps/whispering/src/lib/operations/completion.ts` - `resolveCompletionState`, the second consumer of `connectionFor`
- `apps/whispering/src/lib/bootstrap.ts`, `apps/honeycrisp/src/lib/application.ts` - library choice to delete
- `docs/adr/0363`, `0365`, `0369`, `0375`, `0180`, `0143` - decisions amended or superseded
