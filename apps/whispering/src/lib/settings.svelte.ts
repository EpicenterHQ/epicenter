/**
 * The transcription server the person chose, kept in `settings.json` in the
 * app's local data directory as `{ "baseUrl": ..., "model": ... }`. A missing
 * file means no server is set.
 *
 * It is read once at startup and kept here, not in TanStack Query: the query
 * client marks every query stale after every write, and a settings read has
 * no reason to ride along with the recordings list.
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
import { readServer, type Server } from './transcription-server';

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
	let server = $state.raw<Server>();

	/** Settles once `settings.json` is read; a file that cannot be read leaves no server set. */
	const loaded = tryAsync({
		try: async () => {
			if (!(await exists(PATH, appData))) return undefined;
			const read = readServer(JSON.parse(await readTextFile(PATH, appData)));
			if (!read) throw new Error('it does not hold a baseUrl and a model');
			return read;
		},
		catch: (cause) => SettingsError.ReadFailed({ cause }),
	}).then((result) => {
		if (result.error) toastOnError(result, 'Could not read your settings');
		else server = result.data;
	});

	return {
		/** The server to transcribe with, or undefined when none is set. */
		get server() {
			return server;
		},

		loaded,

		/** Keep `next` as the server, in `settings.json` and here. */
		async save(next: Server) {
			const saved = await tryAsync({
				try: () => writeWhole(PATH, `${JSON.stringify(next, null, '\t')}\n`),
				catch: (cause) => SettingsError.WriteFailed({ cause }),
			});
			if (!saved.error) server = next;
			return saved;
		},
	};
}

export const settings = createSettings();
