/**
 * `#platform/connections` in Vocab's desktop window: the endpoints a learner
 * connected on this computer, kept by `createKeychainConnections` from
 * `@epicenter/ai/tauri`. The list (each endpoint's id, name, base URL and
 * models) is `connections.md` at the top of the AppData root, beside
 * `settings.md`: machine-local, never synced. Each API key is in the
 * keychain under the connection's id, saved with the endpoint it was entered
 * for (ADR-0564), and the shell sends a connection's requests with it
 * (`connectionFetch`), so no record here carries a key. Nothing about
 * connections is in the data folder, which Epicenter syncs, or in
 * `settings.md`.
 */

import { createKeychainConnections } from '@epicenter/ai/tauri';
import { openAppData } from '@epicenter/folder/tauri';
import { vocabSettings } from './folder.tauri.js';
import type { OpenConnections } from './platform.js';

export const openConnections: OpenConnections = async () => {
	const opened = await openAppData(vocabSettings);
	if (opened.error !== null)
		throw new Error(
			`Vocab's connections could not be opened: ${opened.error.message}`,
			{ cause: opened.error },
		);
	const connections = createKeychainConnections({
		file: opened.data.connections,
	});
	await connections.ready;
	return connections;
};
