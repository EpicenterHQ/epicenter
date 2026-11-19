/**
 * The settings as the page uses them: read from `settings.json` once at
 * startup, then kept here and written through on every change.
 *
 * They are not in TanStack Query: that client marks every query stale after
 * every write, and one small document has no reason to ride along with the
 * recordings list.
 */
import { toastOnError } from '@epicenter/ui/toast-on-error';
import { settingsFile } from './app';
import type { Settings } from './data/settings';
import type { Server } from './transcription-server';

function createSettings() {
	let current = $state.raw<Settings>({});

	/** Settles once `settings.json` is read; a file that cannot be read leaves nothing set. */
	const loaded = settingsFile.read().then((read) => {
		if (read.error) toastOnError(read, 'Could not read your settings');
		else current = read.data;
	});

	/** Write `next` whole, and keep it here once it is written. */
	async function save(next: Settings) {
		const saved = await settingsFile.write(next);
		if (!saved.error) current = next;
		return saved;
	}

	return {
		/** The server to transcribe with, or undefined when none is set. */
		get server() {
			return current.server;
		},
		/** The microphone to record from, by the id the recorder lists it under; undefined is the system default. */
		get microphone() {
			return current.microphone;
		},

		loaded,

		/** Keep `server` as the server to transcribe with. */
		saveServer: (server: Server) => save({ ...current, server }),

		/** Record from `microphone` from the next recording on; undefined is the system default. */
		saveMicrophone: (microphone: string | undefined) =>
			save({ ...current, microphone }),
	};
}

export const settings = createSettings();
