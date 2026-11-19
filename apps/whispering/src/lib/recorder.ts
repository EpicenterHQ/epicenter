/**
 * The native recorder (`tauri-plugin-epicenter-recorder`). It writes
 * `recordings/<id>.webm` in the app's local data directory a second at a
 * time, so a crash keeps the audio up to the cut.
 */
import {
	commands,
	type EndedReason,
	type RecordingSignal,
} from '@epicenter/recorder/native';
import { Channel } from '@tauri-apps/api/core';
import { appLocalDataDir } from '@tauri-apps/api/path';

export type { EndedReason } from '@epicenter/recorder/native';

export const recorder = {
	/**
	 * Start recording `id` from the system's default microphone. `onEnded`
	 * hears a capture that ends on its own (a microphone unplugged); what was
	 * captured is still there for `stop` to finish.
	 */
	async start(id: string, onEnded: (reason: EndedReason) => void) {
		const signals = new Channel<RecordingSignal>();
		signals.onmessage = (signal) => {
			if (signal.kind === 'ended') onEnded(signal.reason);
		};
		return commands.start(await appLocalDataDir(), id, null, signals);
	},

	/** Finish the recording in place; answers its id and length. */
	stop: () => commands.stop(),
};
