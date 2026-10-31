/**
 * The chosen microphone, kept in this origin's `localStorage`.
 *
 * It names hardware on one device, so it is neither Whispering's data nor
 * a secret, and it is never written to Whispering's files.
 */
import type { MicrophonePreference } from './capture.js';

/** The device's saved microphone choice, independent of files and capture state. */
export type MicrophonePreferences = {
	/** The saved microphone, or undefined for the system default. Rejects if storage cannot be read. */
	microphone(): Promise<MicrophonePreference | undefined>;
	/** Save the choice, or forget it with undefined. Return any storage failure as text. */
	setMicrophone(
		microphone: MicrophonePreference | undefined,
	): Promise<string | undefined>;
};

const MICROPHONE_STORAGE = 'whispering.microphone';

/** Read the saved microphone; storage and JSON failures reach the chooser. */
function savedMicrophone(): MicrophonePreference | undefined {
	const saved: unknown = JSON.parse(
		localStorage.getItem(MICROPHONE_STORAGE) ?? 'null',
	);
	if (
		typeof saved === 'object' &&
		saved !== null &&
		'deviceId' in saved &&
		typeof saved.deviceId === 'string' &&
		saved.deviceId !== '' &&
		'label' in saved &&
		typeof saved.label === 'string'
	)
		return { deviceId: saved.deviceId, label: saved.label };
	return undefined;
}

export const localPreferences: MicrophonePreferences = {
	microphone: async () => savedMicrophone(),
	async setMicrophone(microphone) {
		try {
			if (microphone === undefined) localStorage.removeItem(MICROPHONE_STORAGE);
			else localStorage.setItem(MICROPHONE_STORAGE, JSON.stringify(microphone));
			return undefined;
		} catch (cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
	},
};
