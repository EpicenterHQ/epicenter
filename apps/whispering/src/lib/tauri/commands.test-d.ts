/**
 * Type-level smoke tests for the boundary adapter.
 *
 * These assertions never run at value-level; they exist so a regression in
 * the `Wrap<F>` mapper or in `tauri-specta`'s output surfaces as a
 * `svelte-check` / `tsc` failure at the type level.
 */

import type { Result } from 'wellcrafted/result';
import type {
	CatalogError,
	commands,
	DictationCapability,
	DownloadProgress,
	IpcRecorderError,
	ModelInfo,
	StagedRecordingCapture,
	TranscriptionError,
	TranscriptionSpec,
} from './commands';
import type {
	CatalogError as SharedCatalogError,
	DictationCapability as SharedDictationCapability,
	DownloadProgress as SharedDownloadProgress,
	IpcRecorderError as SharedIpcRecorderError,
	ModelInfo as SharedModelInfo,
	TranscriptionError as SharedTranscriptionError,
	TranscriptionSpec as SharedTranscriptionSpec,
} from './commands.types';

// Helper: a no-op assertion that two types are equal.
type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

// Browser-safe copies of generated contracts must move in lockstep with the
// native bindings without importing their runtime module into the hosted SPA.
type _SharedContracts = Expect<
	Equal<
		[
			SharedCatalogError,
			SharedDictationCapability,
			SharedDownloadProgress,
			SharedIpcRecorderError,
			SharedModelInfo,
			SharedTranscriptionError,
			SharedTranscriptionSpec,
		],
		[
			CatalogError,
			DictationCapability,
			DownloadProgress,
			IpcRecorderError,
			ModelInfo,
			TranscriptionError,
			TranscriptionSpec,
		]
	>
>;

// stop_recording: fallible, returns only the opaque staged-capture coordinate
// and its byte length. No filesystem path or PCM crosses IPC. The error is the
// structured `RecorderError` IPC enum, not a bare string.
type _StopRecording = Expect<
	Equal<
		ReturnType<typeof commands.stopRecording>,
		Promise<Result<StagedRecordingCapture, IpcRecorderError>>
	>
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

// transcribe_recording: fallible, takes recordingId plus the per-call spec.
type _TranscribeRecording = Expect<
	Equal<
		ReturnType<typeof commands.transcribeRecording>,
		Promise<Result<string, TranscriptionError>>
	>
>;

type _TranscribeRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.transcribeRecording>,
		[string, TranscriptionSpec]
	>
>;

// set_unload_policy: infallible (Rust `()`). Stays plain Promise; no Result
// wrap.
type _SetUnloadPolicy = Expect<
	Equal<ReturnType<typeof commands.setUnloadPolicy>, Promise<void>>
>;

type _SetUnloadPolicyArg = Expect<
	Equal<
		Parameters<typeof commands.setUnloadPolicy>,
		['never' | 'immediately' | 'after_5_minutes' | 'after_30_minutes']
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

// TranscriptionSpec is the per-call local transcription config.
type _TranscriptionSpecShape = Expect<
	Equal<
		TranscriptionSpec,
		{
			modelId: string;
			language?: string | null;
			initialPrompt?: string | null;
		}
	>
>;
