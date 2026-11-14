/**
 * The chosen microphone, kept in this computer's settings
 * (`microphone.json` through `@epicenter/local`: AppData on the desktop,
 * this browser's storage on the web).
 *
 * It names hardware on one computer, so it is neither Whispering's data nor
 * a secret, and it is never written to Whispering's files. It is read at
 * once once the settings connected (`<WhenOpen>`).
 */
import { settings } from '@epicenter/local';
import type { RecordingInput } from '@epicenter/recorder';

/** This computer's saved microphone choice, independent of files and capture state. */
export type MicrophonePreferences = {
	/**
	 * The saved microphone, or undefined for the system default. Throws, naming
	 * `microphone.json`, when the file does not read as a choice: it is shown,
	 * never taken for the default, and saving a choice replaces it.
	 */
	microphone(): RecordingInput | undefined;
	/** Save the choice, or forget it with undefined. Return any storage failure as text. */
	setMicrophone(
		microphone: RecordingInput | undefined,
	): Promise<string | undefined>;
};

const file = settings.file('microphone.json');

/** The saved microphone in `text`; throws when it does not read as one. */
function savedIn(text: string | null): RecordingInput | undefined {
	if (text === null) return undefined;
	let saved: unknown;
	try {
		saved = JSON.parse(text);
	} catch {
		throw new Error('microphone.json on this computer is not JSON.');
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
		'microphone.json on this computer does not name a microphone.',
	);
}

export const localPreferences: MicrophonePreferences = {
	microphone: () => savedIn(file.text()),
	async setMicrophone(microphone) {
		try {
			await file.write(
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
