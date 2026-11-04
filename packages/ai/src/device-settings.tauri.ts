/**
 * `#device-settings` in a desktop app: the person's connected endpoints,
 * listed in `connections.md` at the top of the app's AppData root (never
 * synced, reached through `@epicenter/local`), never a key; each key is in
 * the keychain and sent by the shell (`createKeychainConnections`,
 * `connectionFetch`). The browser's is `device-settings.ts`; the build picks
 * one (the `tauri` condition), so an app calls the same `customEndpoints()`
 * in both.
 */
import { localFile } from '@epicenter/local';
import { type CustomEndpoints, customEndpointsOf } from './custom-endpoints.js';
import { localNote } from './local-note.js';
import { connectionsCollection, createKeychainConnections } from './tauri.js';

/** The person's connected endpoints on this computer, as one entry of `openAi([...])`. */
export function customEndpoints(): CustomEndpoints {
	return customEndpointsOf(async () => {
		const connections = createKeychainConnections({
			file: localNote(connectionsCollection, localFile('connections.md')),
		});
		await connections.ready;
		return connections;
	});
}
