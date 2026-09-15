/**
 * Platform-neutral contracts shared with the generated native bindings.
 *
 * Vite resolves modules before it erases TypeScript-only imports. Importing a
 * type from `commands.ts` therefore retains that module's Tauri side effects in
 * a browser build. Keep the small cross-platform vocabulary here and verify it
 * against the generated bindings in `commands.test-d.ts`.
 */

export type DictationCapability =
	| 'unknown'
	| 'inactive'
	| 'untrusted'
	| 'active'
	| 'broken';

export type IpcRecorderError =
	| { name: 'PermissionDenied'; message: string }
	| { name: 'NoInputDevice'; message: string }
	/** Another window already holds the one host recorder. */
	| { name: 'Busy'; message: string }
	/**
	 * The named recording is not this window's to end: already finished, not the
	 * live one, or owned by another window.
	 */
	| { name: 'NotRecording'; message: string }
	| { name: 'Failed'; message: string }
	| { name: 'CaptureLost'; message: string };

/** Why the local transcription route cannot run right now. */
export type UnavailableReason = 'no-active-model' | 'active-model-unavailable';

/**
 * What an application may learn about the local transcription route: whether it
 * is ready, and which advisory inputs it accepts. Never model identity, never
 * inventory, never residency (ADR-0180).
 *
 * Advisory UI state, not a preflight gate. Transcription resolves the active
 * model independently at the point of use, so this may be stale; `message` is a
 * user-facing sentence that names no model.
 */
export type LocalTranscriptionReadiness =
	| { status: 'ready'; supportsPrompt: boolean; supportsLanguage: boolean }
	| { status: 'unavailable'; reason: UnavailableReason; message: string };

export type TranscriptionError =
	| { name: 'AudioReadError'; message: string }
	// One precondition family: the local route cannot run at all. The two cases
	// differ only as `reason` data, because the caller's job is the same either
	// way. Load and inference failures below stay distinct: they are operational,
	// not "you have not set this up".
	| {
			name: 'LocalRouteUnavailable';
			reason: UnavailableReason;
			message: string;
	  }
	| { name: 'ModelLoadError'; message: string }
	| { name: 'TranscriptionError'; message: string };

/**
 * The advisory hints an application sends with a transcription. No model name:
 * the host resolves the one active model at use, so an ordinary request cannot
 * reassign the shared model cache (ADR-0180).
 */
export type TranscriptionHints = {
	language?: string | null;
	initialPrompt?: string | null;
};

/** Which advisory hints the run actually applied. */
export type AppliedHints = {
	/** The language hint the runtime received; `null` means it autodetected. */
	language: string | null;
	/**
	 * Whether the initial prompt reached the runtime. `false` when none was sent
	 * or the active model does not accept one.
	 */
	initialPrompt: boolean;
};

/**
 * What a transcription produced. `transcribed` names the exact model that made
 * the text, which is what makes an accidental substitution detectable rather
 * than silent. `empty-audio` carries neither a model nor applied hints, because
 * no model ran and claiming one would be claiming an inference that never
 * happened.
 */
export type TranscriptionOutcome =
	| {
			outcome: 'transcribed';
			text: string;
			modelId: string;
			applied: AppliedHints;
	  }
	| { outcome: 'empty-audio' };
