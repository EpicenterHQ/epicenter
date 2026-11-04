/**
 * `#device-settings` in a desktop app: the person's connected endpoints,
 * their list in `connections.md` at the top of the app's AppData root
 * (never synced, never a key) and each key in the keychain, sent by the
 * shell (`createKeychainConnections`, `connectionFetch`). The browser's is
 * `device-settings.ts`; the build picks one (the `tauri` condition).
 */
import { type Client, defineContract } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/tauri';
import { type CustomEndpoints, customEndpointsOf } from './custom-endpoints.js';
import { connectionsCollection, createKeychainConnections } from './tauri.js';

/** What `@epicenter/ai` keeps in a desktop app's AppData root, beside the app's own notes. */
const aiSettings = defineContract({
	description:
		'The endpoints connected on this computer: each one’s id, name, base URL and models. Their keys are in the keychain.',
	collections: { connections: connectionsCollection },
});

let opening: Promise<Client<typeof aiSettings>> | undefined;

/** The AppData notes, opened once; a failed open is tried again on the next ask. */
function openSettings() {
	opening ??= openDevice(aiSettings, { root: 'AppData' }).then(
		({ data, error }) => {
			if (error === null) return data;
			opening = undefined;
			throw new Error(
				`The settings on this computer could not be opened: ${error.message}`,
				{ cause: error },
			);
		},
	);
	return opening;
}

/** The person's connected endpoints on this computer, as one entry of `openAi([...])`. */
export function customEndpoints(): CustomEndpoints {
	return customEndpointsOf(async () => {
		const settings = await openSettings();
		const connections = createKeychainConnections({
			file: settings.connections,
		});
		await connections.ready;
		return connections;
	});
}
