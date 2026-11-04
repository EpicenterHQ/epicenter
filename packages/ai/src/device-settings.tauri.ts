/**
 * `#device-settings` in a desktop app: what `@epicenter/ai` keeps of this
 * computer's settings, in notes at the top of the app's AppData root
 * (never synced). The browser's is `device-settings.ts`; the build picks one
 * (the `tauri` condition), so an app calls the same `customEndpoints()` and
 * `modelChoices()` in both.
 *
 * - `connections.md`: the person's connected endpoints, never a key; each
 *   key is in the keychain, sent by the shell (`createKeychainConnections`,
 *   `connectionFetch`).
 * - `models.md`: the model chosen for each job, beside the connections it
 *   names, so a choice never sits in the window's storage while the
 *   endpoint it names sits in AppData.
 */
import {
	type Client,
	defineContract,
	type Version,
} from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/tauri';
import {
	type ChoicesPlace,
	createModelChoices,
	type ModelChoices,
	type SavedChoices,
} from './choices.js';
import { type CustomEndpoints, customEndpointsOf } from './custom-endpoints.js';
import type { ModelChoice } from './open-ai.js';
import { connectionsCollection, createKeychainConnections } from './tauri.js';

const text = { type: 'string' } as const;

/** What `@epicenter/ai` keeps in a desktop app's AppData root, beside the app's own notes. */
const aiSettings = defineContract({
	description:
		'The endpoints connected on this computer (each one’s id, name, base URL and models; their keys are in the keychain) and the model chosen for each job.',
	collections: {
		connections: connectionsCollection,
		models: {
			path: 'models.md',
			fields: {
				choices: {
					type: 'array',
					items: {
						type: 'object',
						properties: { job: text, endpoint: text, model: text },
						required: ['job', 'endpoint', 'model'],
					},
				},
			},
			required: ['choices'],
		},
	},
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

/** `models.md` as read: every choice, and the version to write over (null while it does not exist). */
async function readModels(): Promise<{
	choices: SavedChoices;
	version: Version | null;
}> {
	const { models } = await openSettings();
	const note = await models.get({});
	if (note.error?.name === 'NotFound') return { choices: {}, version: null };
	if (note.error !== null)
		throw new Error(`models.md could not be read: ${note.error.message}`, {
			cause: note.error,
		});
	return {
		choices: Object.fromEntries(
			note.data.choices.map(({ job, endpoint, model }) => [
				job,
				{ endpoint, model },
			]),
		),
		version: note.data.version,
	};
}

/** `models.md` in AppData, read again before each write and written over the version read. */
const appDataChoices: ChoicesPlace = {
	read: async () => (await readModels()).choices,
	async save(job: string, choice: ModelChoice) {
		const { models } = await openSettings();
		const { choices, version } = await readModels();
		const next = { ...choices, [job]: choice };
		const fields = {
			choices: Object.entries(next).map(([name, { endpoint, model }]) => ({
				job: name,
				endpoint,
				model,
			})),
		};
		const written =
			version === null
				? await models.create(fields)
				: await models.update({}, fields, { over: version });
		if (written.error !== null)
			throw new Error(
				`models.md could not be saved: ${written.error.message}`,
				{
					cause: written.error,
				},
			);
		return next;
	},
	watch(listener) {
		let stop: (() => void) | undefined;
		let stopped = false;
		void openSettings().then(
			({ models }) => {
				if (!stopped) stop = models.subscribe(listener);
			},
			() => {},
		);
		return () => {
			stopped = true;
			stop?.();
		};
	},
};

/**
 * The model this computer's person chose for each job, kept in `models.md`
 * in AppData; `defaults` answers a job none was chosen for.
 */
export function modelChoices<TJob extends string = string>(
	defaults: Partial<Record<TJob, ModelChoice>> = {},
): ModelChoices<TJob> {
	return createModelChoices(appDataChoices, defaults);
}
