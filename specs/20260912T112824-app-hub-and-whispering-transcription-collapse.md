# App scopes, the device store, and the Whispering transcription collapse

**Date**: 2026-09-12
**Status**: Draft
**Owner**: Braden
**Branch**: braden-w/app-schema-derive-export-import (design only; execution branch to be chosen)
**Supersedes**: `apps/whispering/specs/20260527T002843-cloud-transcription-collapse.md`, `apps/whispering/specs/20260527T003910-transcription-providers-from-first-principles.md`, `apps/whispering/specs/20260530T183000-transcription-provider-registry.md`

## One Sentence

One App owns Local and available account libraries, applications choose where
to read and write, and Whispering transcribes a row's locally available attachment
through its selected connection.

## Current execution contract, 2026-09-14

This is planned work, not the current API. The code still has three openers,
blob IDs, and application-owned upload policy. ADR-0392 owns the two scopes;
ADR-0393 owns attachments; ADR-0399 leaves copying to applications; ADR-0401
requires explicit write ownership, not a picker or a Personal default.

Local persists for this app and storage profile across signed-out, Alice, and
Bob sessions. Their account libraries remain separate. Reopening replaces the
App handle, not Local data. An account file cached locally is not a Local record.

The attachment/recovery spec owns local completion, transfer, and restore
implementation. Build its local attachment owner and read contract first,
then integrate this plan's row-first recorder. Their joint capture/recovery
evidence completes the local checkpoint; the recorder does not wait for a
checkpoint that already requires it. Transcription switches after that proof.
Do not build a temporary recorder destination-store/blob-ID API between them.
Platform selectors can proceed independently; copying is not a dependency.

Completion requires scope-isolation tests, captured attachment ownership,
honest unavailable-audio behavior, and the app migrations below. Each app's
library presentation is product policy; record that policy before switching
its create paths rather than silently inventing a framework default.

How to read this spec:

```txt
Read first:
  One Sentence, Current State, Target Shape, Implementation Plan, Verification
Read if changing the architecture:
  Design Decisions, Edge Cases, Open Questions
Durable decisions (all Proposed):
  docs/adr/0392  an App has a device scope and an account scope, and each store
                 sits under its owner
  docs/adr/0399  cross-library copying is optional application work
  docs/adr/0400  device sqlite and secrets key by application id
  docs/adr/0401  a record names its destination at creation
  docs/adr/0396  a connection transcribes and owns the four rules
  docs/adr/0397  native inference selects an installed model explicitly (amends 0180)
  docs/adr/0398  every transcription destination speaks the OpenAI wire
```

## Overview

The App groups the device and account scopes under one lifetime. Device state
and inference selections move into `app.device.kv`. Whispering captures a
connection selection, reads the selected row's local attachment, and records
the inference outcome through that row's owning library.

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

Whispering's `operations/transcribe.ts` after the change, schematic only.
`Attachment.readLocal` is a placeholder for the local read contract, not an
existing export; the attachment implementation settles its exact signature:

```ts
export async function transcribeAudio(attachment: Attachment) {
	const app = getApp();
	const selection = app.device.kv.get('transcription');
	const connection = connectionFor(app, selection);
	if (!connection) return TranscribeOperationError.SelectionRequired();
	const language =
		app.account?.personal.kv.get('transcriptionLanguage') ??
		app.device.kv.get('transcriptionLanguage');
	...
	const { data: audio, error } = await attachment.readLocal();
	if (error) return Err(error);
	return connection.transcribe(selection.model, { audio, language, prompt });
}
```

The caller obtains the attachment from the selected recording's owning table.
It retains that library and row for result publication. A missing local file
returns unavailable without a network wait or inference request; the library's
existing synchronizer supplies downloads. Capture the connection, model, hints,
and output destination before awaiting the read. Closure, retirement, or row
deletion must prevent a late result from recreating the row or changing libraries.

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
| Copying is optional application work | 2 coherence | No built-in Add, Delete, Keep or copy workflow | ADR-0399. Local remains beside account libraries. |
| Writes name their destination | 2 coherence | Application chooses a table before creating; picker, default, and remembered choice are optional | ADR-0401. |
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

**Semantic shift to flag**: library selection no longer chooses an App opener.
An app may retain library navigation or offer a destination control as product
policy. `departure` takes `auth` whenever `app.account` exists.

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

Deletion bullets name the final removal, not permission to delete first: build
the replacement, switch consumers, verify behavior, then remove the unused path.
Preserve historical ADRs; retire implementation scaffolding only after its
replacement is proven. Cross-library copying is not a completion criterion.

### Wave 1: the two scopes (packages/data, packages/app, packages/device)

- [ ] **1.1** `packages/app`: one `open(account)` that returns `{ device, account?, signal, ready, close }`. `device` carries `kv`, `tables`, `sqlite`, `secrets`, `connections`, and `recording`; `account` carries `identity`, `personal`, optional `shared`, and `connection`. All stores expose row-owned attachments under ADR-0393, not app-facing blob remotes. Reuse the store implementation; `device` is always constructed.
- [ ] **1.2** `packages/device`: `DeviceSqliteOwner.acquire(appId)` keyed by app id only; `secrets` likewise. Delete replica-identity scoping and its tests' identity permutations.
- [ ] **1.3** `device.kv` and `device.tables` are the existing store with no authority. Confirm that no code path assumes the Local library is exclusive of an account session.
- [ ] **1.4** After the local attachment owner/read contract exists, update `packages/app/src/recorder.ts` and its tests: `start` receives an existing row's attachment and retains its library and lifetime. Stop completes it without minting a blob ID. Joint capture/recovery tests complete the attachment spec's local checkpoint. Do not add a transient destination-store API.
- [ ] **1.5** Tests in `packages/app`: Local records and preferences remain across signed-out -> Alice -> signed-out -> Bob within one app/profile; account data remains isolated; old handles close; account attachment caches do not appear in Local; opening never copies records. Retain sqlite ownership evidence under ADR-0400.
- [ ] **1.6** Switch callers in wave 2, verify, then remove `openLocal`, `openPersonal`, and `openShared`. Update current implementation notes only when their code changes.

### Wave 2: apps onto the two scopes (one commit per app)

- [ ] **2.1** Whispering: move `bootstrap.ts` and `application.ts` onto `open`. Record the app's library-view and write policy before switching callers. A picker and remembered choice are optional, not a framework default. Create the row in the chosen library before capture and retain that attachment through stop/recovery. Remove unused one-library opener wiring after verification; do not delete useful app navigation merely because its old name mentions Library.
- [ ] **2.2** Honeycrisp: same in `apps/honeycrisp/src/lib/application.ts`.
- [ ] **2.3** Vocab and local-mail: same.
- [ ] **2.4** Whispering: move `deviceConfig` entries into `device.kv` declarations; delete `createPersistedMap` usage and `state/device-config.svelte.ts`. Move the selections into `device.kv`; delete the storage half of `createInferenceSelections`, keep `matchInferenceTarget` until wave 3 replaces it. Delete `data.local-model-is-not-synced.test.ts` and the `secrets` facade.
- [ ] **2.5** Verify that sign-in neither adopts nor erases Local data. Remove unused capture/admit adoption consumers after the two-scope replacement passes. Keep ADR-0143 as history with its existing supersession pointer; a copy feature is not required.

### Wave 3: platform transcription (packages/app)

- [ ] **3.1** Add the `Connection` type in `packages/app` with `id`, `label`, `client`, `models`, and `transcribe`. Build `transcribeOverOpenAiWire` and the error set above; add `signal` to whatever HTTP helper is used if not the SDK.
- [ ] **3.2** Put `app.device.connections` (native runtime plus custom endpoints, returning `Connection`) and `app.account.connection` (the server's gateway) on the App. The account gateway is the only one that maps 402 to `InsufficientCredits`; a self-hosted 503 stays `Rejected` with the server's detail.
- [ ] **3.3** Export `connectionFor(app, selection)` from `@epicenter/app` beside the selection type. Delete `matchInferenceTarget` and the storage half of `packages/app-shell/src/inference-selections.ts`; the picker keeps its presentation and assembles its list from `device.connections.getAll()` and `account?.connection`.
- [ ] **3.4** Tests in `packages/app`, moved nearly verbatim from `apps/whispering/src/lib/operations/transcribe.test.ts`: multipart bytes and hints reach the exact client; a selection edit during a delayed blob read cannot retarget; a removed connection fails as `Unavailable`; account 402 is `InsufficientCredits` and custom 402 is `Rejected`; malformed bodies are `Malformed`; a late completion after closure is `Closed` and publishes nothing.

### Wave 4: Whispering transcription collapse

- [ ] **4.1** After the local attachment checkpoint, move `operations/transcribe.ts` onto the owning row's attachment, `connectionFor`, and `connection.transcribe`. Remove the separate `audioBlobId` argument from `transcribeAndPersist`; retain the captured output library/row. Missing local audio returns unavailable, not a hidden download or queued inference job. `operations/completion.ts` moves to `connectionFor` too.
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

1. The app creates a Personal recording row and admits capture into its attachment.
2. Before deliberate account change, finish/save wanted capture or explicitly
   cancel it, then close the App. Abrupt termination uses staged recovery;
   merely releasing capture hardware is not an instruction to purge saved work.
3. Ordinary closure preserves saved and recoverable work under its original library and
   row identity. It does not finish into Local or the next account. Resume only
   under that original owner with valid admission. Confirmed restore retirement
   follows ADR-0393/0395's destructive rule instead; do not resurrect retired work.

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

Settled decisions live in the records:

- Apps compose capture and inference; no shared dictation capability is planned
  (ADR-0365). Native admission work continues in
  `specs/20260912T122859-concurrent-native-capture.md`.
- Account menu copy distinguishes removing account data from this device from
  the separate Local library (ADR-0399 and ADR-0351).
- Device and synchronized settings have separate declarations (ADR-0392).
  Applications own destination defaults and any picker (ADR-0401).
- `Connection.client` exposes the SDK type, so replacing it later changes that
  public type (ADR-0396).

## Adjacent Work

- `queries/transcription.test.ts` fails on `$app/paths` in `vad-recorder.svelte.ts`; unrelated to this spec, fix when touched.
- The hosted STT model id is spelled in four places (`STT_MODEL` in `packages/server/src/routes/transcription.ts`, `HOSTED_STT_MODEL` in `apps/api/worker/billing/policies.ts`, the Whispering picker's `accountModels`, and `VOCAB_STT_MODEL` in `apps/vocab/src/lib/data.ts`). One export from `@epicenter/constants` per ADR-0398, when the picker is touched in wave 4.
- ADR-0391 already removes `runtime` and `ai` from `defineApplication`; wave 1.1 should land on its target, not the current signature.

## Success Criteria

- [ ] `open(null)` returns an App whose `device` works with no account; `open(account)` adds `account.personal`, `account.connection`, and, on a self-hosted deployment, `account.shared`.
- [ ] Local records and preferences survive account changes in the same profile; Personal data stays account-isolated and no automatic copying occurs.
- [ ] Every create path uses its app-chosen table; capture and late inference results cannot retarget after a view/account change. No mandatory destination picker or copy workflow was added.
- [ ] Unavailable local audio makes no inference request or hidden download. Available audio works with the exact captured connection; retirement or row deletion prevents late publication.
- [ ] Whispering has no `localStorage` writes except the auth client's.
- [ ] `apps/whispering/src/lib/services/transcription/` does not exist; `operations/transcribe.ts` is under forty lines including `transcribeAndPersist`.
- [ ] `matchInferenceTarget` exists nowhere; `connectionFor` is the one matching function.
- [ ] The six transcribe tests pass in `packages/app`; readiness and the Polish sentence have one test each in Whispering.
- [ ] `bun run typecheck` green in `packages/app`, `packages/device`, `packages/app-shell`, and all four apps on every leaf.
- [ ] ADR-0392 accurate to the code; obsolete adoption implementation removed, historical ADR-0143 preserved; ADR-0180 amended.

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
