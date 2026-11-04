/**
 * `modelChoices()`: the model this computer's person chose for each job,
 * kept in `models.md` in the app's place for this computer's state
 * (`@epicenter/local`: AppData on the desktop, this browser's storage on the
 * web, memory under `test`), beside the connections it names. The build
 * picks the place, so the call takes none (ADR-0766).
 */
import { localFile } from '@epicenter/local';
import {
	type ChoicesPlace,
	createModelChoices,
	type ModelChoices,
	type SavedChoices,
} from './choices.js';
import { localNote } from './local-note.js';
import type { ModelChoice } from './open-ai.js';

const text = { type: 'string' } as const;

/** `models.md`: one entry per job, naming an endpoint and a model there. */
export const modelsCollection = {
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
} as const;

/** How many times a save reads and writes again after another window's write. */
const ATTEMPTS = 3;

/** `models.md`, read again before each write and written over the version read. */
function notePlace(): ChoicesPlace {
	const models = localNote(modelsCollection, localFile('models.md'));

	async function read() {
		const note = await models.get({});
		if (note.error?.name === 'NotFound')
			return { choices: {} as SavedChoices, version: null };
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
			) as SavedChoices,
			version: note.data.version,
		};
	}

	return {
		read: async () => (await read()).choices,
		async save(job: string, choice: ModelChoice) {
			for (let attempt = 1; ; attempt++) {
				const { choices, version } = await read();
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
				if (written.error === null) return next;
				const raced =
					written.error.name === 'Conflict' ||
					written.error.name === 'Occupied';
				if (!raced || attempt === ATTEMPTS)
					throw new Error(
						`models.md could not be saved: ${written.error.message}`,
						{ cause: written.error },
					);
			}
		},
		watch: (listener) => models.subscribe(listener),
	};
}

/**
 * The model this computer's person chose for each job; `defaults` answers
 * a job none was chosen for.
 */
export function modelChoices<TJob extends string = string>(
	defaults: Partial<Record<TJob, ModelChoice>> = {},
): ModelChoices<TJob> {
	return createModelChoices(notePlace(), defaults);
}
