/**
 * The person's settings for this computer, kept in `settings.json` in the
 * app's local data directory (`settings-file.ts`): the transcription server
 * and the microphone. A missing file means neither is set.
 *
 * They are read once at startup and kept here, not in TanStack Query: the
 * query client marks every query stale after every write, and a settings read
 * has no reason to ride along with the recordings list. Every change writes
 * the whole file.
 */
import { toastOnError } from '@epicenter/ui/toast-on-error';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { appData, writeWhole } from './files';
import {
	readSettings,
	type SettingsFile,
	writeSettings,
} from './settings-file';
import type { Server } from './transcription-server';

const PATH = 'settings.json';

export const SettingsError = defineErrors({
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `${PATH} could not be read: ${extractErrorMessage(cause)}`,
		cause,
	}),
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `${PATH} could not be saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SettingsError = InferErrors<typeof SettingsError>;

function createSettings() {
	let current = $state.raw<SettingsFile>({});

	/** Settles once `settings.json` is read; a file that cannot be read leaves nothing set. */
	const loaded = tryAsync({
		try: async () =>
			(await exists(PATH, appData))
				? readSettings(JSON.parse(await readTextFile(PATH, appData)))
				: {},
		catch: (cause) => SettingsError.ReadFailed({ cause }),
	}).then((result) => {
		if (result.error) toastOnError(result, 'Could not read your settings');
		else current = result.data;
	});

	/** Write `next` whole, and keep it here once it is written. */
	async function save(next: SettingsFile) {
		const saved = await tryAsync({
			try: () => writeWhole(PATH, writeSettings(next)),
			catch: (cause) => SettingsError.WriteFailed({ cause }),
		});
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
