/**
 * Recording state types. These are plain unions: the states are never validated
 * at runtime, only used as compile-time types.
 */

/**
 * Manual recording state as the UI tracks it. Owned here rather than by the
 * recorder contract: the recorder has no state to report, because holding a
 * `Recording` is what "recording" means. `operations/recording.svelte.ts` derives
 * this from whether it holds one, and the UI reads that.
 */
export type WhisperingRecordingState = 'IDLE' | 'RECORDING';

/**
 * VAD session state as the UI tracks it: closed, armed and waiting for speech,
 * or mid-utterance. Mirrored from the package's speech callbacks by
 * `vad-recorder.svelte.ts`.
 */
export type VadState = 'IDLE' | 'LISTENING' | 'SPEECH_DETECTED';
