/** Stable recording-trigger values shared by storage and render metadata. */
export const RECORDING_TRIGGERS = ['manual', 'vad'] as const;

export type RecordingTrigger = (typeof RECORDING_TRIGGERS)[number];
