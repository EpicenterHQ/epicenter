/**
 * Type-level smoke tests for the boundary adapter.
 *
 * These assertions never run at value-level; they exist so a regression in
 * the `Wrap<F>` mapper or in `tauri-specta`'s output surfaces as a
 * `svelte-check` / `tsc` failure at the type level.
 */

import type { RecordingEndedReason } from '@epicenter/app/recorder';
import type { Result } from 'wellcrafted/result';
import type {
	commands,
	DeviceAcquisition,
	DictationCapability,
	EndedReason,
	HostRecording,
	IpcRecorderError,
	LocalTranscriptionReadiness,
	StoppedRecording,
	TranscriptionError,
	TranscriptionHints,
	TranscriptionOutcome,
} from './commands';
import type {
	DictationCapability as SharedDictationCapability,
	IpcRecorderError as SharedIpcRecorderError,
	LocalTranscriptionReadiness as SharedLocalTranscriptionReadiness,
	TranscriptionError as SharedTranscriptionError,
	TranscriptionHints as SharedTranscriptionHints,
	TranscriptionOutcome as SharedTranscriptionOutcome,
} from './commands.types';

/**
 * A failed assertion carries both sides, so the error names what moved.
 *
 * `Expect` requires `true`, so an unequal pair reports the object below rather
 * than `Type 'false' does not satisfy the constraint 'true'`, which names
 * neither type:
 *
 *     Type '{ expected: "draft" | "published"; got: string; }'
 *     does not satisfy the constraint 'true'.
 *
 * Copied rather than shared. It is four lines of the canonical spelling with no
 * semantics of its own, and the three copies live in `packages/data/src/field`,
 * `packages/data/src/definition`, and `apps/whispering`, which do not
 * otherwise reach into each other for test
 * utilities. `wellcrafted/testing` exports this pair as of the release after
 * 0.44.0; import it from there once the catalog moves and these go.
 */
type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };

// Browser-safe copies of generated contracts must move in lockstep with the
// native bindings without importing their runtime module into the hosted SPA.
type _SharedContracts = Expect<
	Equal<
		[
			SharedDictationCapability,
			SharedIpcRecorderError,
			SharedLocalTranscriptionReadiness,
			SharedTranscriptionError,
			SharedTranscriptionHints,
			SharedTranscriptionOutcome,
		],
		[
			DictationCapability,
			IpcRecorderError,
			LocalTranscriptionReadiness,
			TranscriptionError,
			TranscriptionHints,
			TranscriptionOutcome,
		]
	>
>;

// The whole recording surface, pinned.
//
// Each of these commands takes an injected `tauri::WebviewWindow` in Rust, so
// the host knows which window is calling without the caller being able to say.
// Specta renders that parameter as nothing at all, and these argument
// assertions are the proof: if the injection ever started leaking into the
// generated signature, the arity here would stop matching.
//
// The errors are the structured `RecorderError` IPC enum, not bare strings, so
// the recorder boundary stays typed.

// start_recording: optional device in, the host-minted blob id out. The caller
// does not supply an id, because the host owns which recording exists, and it
// does not have to enumerate devices first, because the host reports the
// microphone it actually opened.
type _StartRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.startRecording>,
		[
			string | null,
			import('./bindings.gen').BlobDestination,
			import('./bindings.gen').RecordingAttachment,
		]
	>
>;

type _StartRecording = Expect<
	Equal<
		ReturnType<typeof commands.startRecording>,
		Promise<Result<HostRecording, IpcRecorderError>>
	>
>;

// One shape for a started recording and a recovered one. `endedReason` is what
// makes that possible: a recording whose capture died is the same recording with
// a reason attached, not a second kind of thing arriving down a second channel.
type _HostRecordingShape = Expect<
	Equal<
		HostRecording,
		{
			audioBlobId: string;
			destination: import('./bindings.gen').BlobDestination;
			attachment: import('./bindings.gen').RecordingAttachment;
			device: DeviceAcquisition;
			endedReason: EndedReason | null;
		}
	>
>;

// Device acquisition never omits which device ran: both arms carry one, so a
// caller can always say what it is recording from.
type _DeviceAcquisitionShape = Expect<
	Equal<
		DeviceAcquisition,
		| { outcome: 'success'; deviceId: string }
		| {
				outcome: 'fallback';
				reason: 'no-device-selected' | 'preferred-device-unavailable';
				deviceId: string;
		  }
	>
>;

// stop_recording: names the recording to end, and answers with the committed
// blob plus the host's exact duration and byte length. Neither is nullable,
// because a stop that returns at all has already published the file.
type _StopRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.stopRecording>,
		[string, import('./bindings.gen').BlobDestination]
	>
>;

type _StopRecording = Expect<
	Equal<
		ReturnType<typeof commands.stopRecording>,
		Promise<Result<StoppedRecording, IpcRecorderError>>
	>
>;

type _StoppedRecordingShape = Expect<
	Equal<
		StoppedRecording,
		{ audioBlobId: string; durationMs: number; byteLength: number }
	>
>;

// cancel_recording: names the recording to burn, and produces nothing. The
// absence of a result type is the invariant: a cancel can never hand anyone a
// blob.
type _CancelRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.cancelRecording>,
		[string, import('./bindings.gen').BlobDestination]
	>
>;

type _CancelRecording = Expect<
	Equal<
		ReturnType<typeof commands.cancelRecording>,
		Promise<Result<null, IpcRecorderError>>
	>
>;

// current_recording: takes nothing, because the only window it could be asked
// about is the one asking. That scoping lives in Rust with the injected window,
// which is why there is no label parameter here to get wrong.
//
// It answers in the same shape `start` does, which is what lets a recording
// recovered after a reload be as capable as one just started rather than a
// degraded stand-in, including one whose capture already ended.
type _CurrentRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.currentRecording>,
		[import('./bindings.gen').BlobDestination]
	>
>;

type _CurrentRecording = Expect<
	Equal<
		ReturnType<typeof commands.currentRecording>,
		Promise<Result<HostRecording | null, IpcRecorderError>>
	>
>;

// The recorder contract is platform-neutral, so it cannot import the native
// bindings; its `RecordingEndedReason` is a hand-written mirror of the host's
// `EndedReason`. This is what keeps the two from drifting apart: adding a
// reason in Rust without adding it to the contract would otherwise reach a
// `Record` lookup that returns undefined at runtime.
type _EndedReasonMirrorsTheHost = Expect<
	Equal<RecordingEndedReason, EndedReason>
>;

// pause_playback / resume_playback: infallible across IPC. A platform failure
// is logged in Rust and never surfaces as an error the frontend must handle, so
// these stay plain Promises with no Result wrap.
type _PausePlayback = Expect<
	Equal<ReturnType<typeof commands.pausePlayback>, Promise<string[]>>
>;

type _ResumePlayback = Expect<
	Equal<ReturnType<typeof commands.resumePlayback>, Promise<void>>
>;

// transcribe_recording: fallible, takes the blob id plus advisory hints, and
// answers with the text alongside the exact model that produced it. The absence
// of a model argument here is the ADR-0180 invariant expressed at the type
// level: an application cannot name a model, so it cannot change one.
type _TranscribeRecording = Expect<
	Equal<
		ReturnType<typeof commands.transcribeRecording>,
		Promise<Result<TranscriptionOutcome, TranscriptionError>>
	>
>;

type _TranscribeRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.transcribeRecording>,
		[string, TranscriptionHints, import('./bindings.gen').BlobDestination]
	>
>;

// prewarm_model: takes nothing. It warms the active model, the same one
// transcribe will run, because there is only one.
type _PrewarmModelArgs = Expect<
	Equal<Parameters<typeof commands.prewarmModel>, []>
>;

// get_local_transcription_readiness: infallible and advisory. This is the whole
// application-facing read of the local route, and the type is the boundary:
// there is no model id, no name, and no inventory anywhere in it (ADR-0180).
type _GetLocalTranscriptionReadiness = Expect<
	Equal<
		ReturnType<typeof commands.getLocalTranscriptionReadiness>,
		Promise<LocalTranscriptionReadiness>
	>
>;

type _ReadinessShape = Expect<
	Equal<
		LocalTranscriptionReadiness,
		| { status: 'ready'; supportsPrompt: boolean; supportsLanguage: boolean }
		| {
				status: 'unavailable';
				reason: 'no-active-model' | 'active-model-unavailable';
				message: string;
		  }
	>
>;

// open_accessibility_settings: fallible, returns unit as null. Deliberately a
// bare-string error (tier 2): the frontend wraps it into one PermissionsError
// variant and only displays the message; it never branches on the cause.
type _OpenAccessibilitySettings = Expect<
	Equal<
		ReturnType<typeof commands.openAccessibilitySettings>,
		Promise<Result<null, string>>
	>
>;

// encode_recording_for_upload: hand-rolled, raw bytes success path. Error stays
// a bare string (tier 2): `tauri::ipc::Response` is not `specta::Type`, so this
// command lives outside the generated surface, and the frontend treats a
// failure as best-effort ("compression skipped"), never branching on it.
type _EncodeRecordingForUpload = Expect<
	Equal<
		ReturnType<typeof commands.encodeRecordingForUpload>,
		Promise<Result<ArrayBuffer, string>>
	>
>;

// TranscriptionHints is the per-call advisory input: language and prompt, and
// deliberately no model.
type _TranscriptionHintsShape = Expect<
	Equal<
		TranscriptionHints,
		{
			language?: string | null;
			initialPrompt?: string | null;
		}
	>
>;

/** Shared native capture wire contract follows the generated Rust shape. */
type _PortableNativeRecording = Expect<
	Equal<HostRecording, import('@epicenter/app/recorder').NativeRecording>
>;
type _PortableBlobDestination = Expect<
	Equal<
		import('./bindings.gen').BlobDestination,
		import('@epicenter/blobs/native').BlobDestination
	>
>;
