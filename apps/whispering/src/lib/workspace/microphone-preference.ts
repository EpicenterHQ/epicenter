/**
 * The chosen microphone, kept in this origin's `localStorage`.
 *
 * It names hardware on one device, so it is neither folder data nor a
 * secret, and it is never written to the folder. A browser tab and Epicenter
 * both keep it here: Epicenter serves every app from one fixed loopback
 * origin, so the choice lasts from launch to launch.
 */
import type { MicrophonePreference } from '../capture.js';
import type { Workspace } from './types.js';

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

export const localPreferences: Workspace['preferences'] = {
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
