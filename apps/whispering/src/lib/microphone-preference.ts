/**
 * The chosen microphone, kept in this computer's `localStorage`
 * (`this-computer.ts`). It names hardware on one computer, so it is
 * neither Whispering's data nor a secret, and it is never written to
 * Whispering's folder.
 */
import type { RecordingInput } from '@epicenter/recorder';
import { localValue } from './this-computer.js';

/** This computer's saved microphone choice, independent of files and capture state. */
export type MicrophonePreferences = {
	/**
	 * The saved microphone, or undefined for the system default. Throws when
	 * what is kept does not read as a choice: it is shown, never taken for
	 * the default, and saving a choice replaces it.
	 */
	microphone(): RecordingInput | undefined;
	/** Save the choice, or forget it with undefined. Return any storage failure as text. */
	setMicrophone(
		microphone: RecordingInput | undefined,
	): Promise<string | undefined>;
};

/** The saved microphone in `text`; throws when it does not read as one. */
function savedIn(text: string | null): RecordingInput | undefined {
	if (text === null) return undefined;
	let saved: unknown;
	try {
		saved = JSON.parse(text);
	} catch {
		throw new Error('The microphone saved on this computer is not JSON.');
	}
	if (saved === null) return undefined;
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
	throw new Error(
		'What this computer saved as the microphone does not name one.',
	);
}

const kept = localValue('microphone');

export const localPreferences: MicrophonePreferences = {
	microphone: () => savedIn(kept.get()),
	async setMicrophone(microphone) {
		try {
			kept.set(
				microphone === undefined
					? null
					: JSON.stringify({
							deviceId: microphone.deviceId,
							label: microphone.label,
						}),
			);
			return undefined;
		} catch (cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
	},
};
