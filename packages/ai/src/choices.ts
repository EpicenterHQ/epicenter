/**
 * `@epicenter/ai/choices`: the person's model choice for each job, kept in
 * `models.md` in this computer's settings (`@epicenter/local`: AppData on
 * the desktop, beside the connections it names; this browser's storage on
 * the web). A job is a key an app names (`'chat'`, `'transcribe'`, or its
 * own), and its choice names an endpoint and a model there (`ModelChoice`).
 * A choice whose endpoint is gone stays saved and is still answered, so a
 * request to it fails at that endpoint and nothing falls back to another.
 *
 * The page reads choices once the settings connected (`<WhenOpen>`), so
 * `get` is the truth, never a stand-in: the saved choice, else the app's
 * default for the job, else null. When `models.md` does not read, `get`
 * answers null, and `require`, which an action that decides on a choice
 * reads, fails with `SettingError.Invalid` naming the file; saving a new
 * choice replaces it.
 */
import { settings } from '@epicenter/local';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { ModelChoice } from './open-ai.js';
import { SettingError, settingNote } from './setting-note.js';

export { SettingError } from './setting-note.js';

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

export const ChoiceError = defineErrors({
	/** No model is chosen for the job, and the app names no default. */
	NoChoice: ({ job }: { job: string }) => ({
		message: `Choose a model for ${job} first.`,
		job,
	}),
});
export type ChoiceError = InferErrors<typeof ChoiceError>;

/** The person's model choice for each job, on this computer. */
export type ModelChoices<TJob extends string = string> = {
	/** The choice saved for `job`, else the app's default for it, else null; null too while `models.md` does not read. */
	get(job: TJob): ModelChoice | null;
	/** The choice for `job`, for an action that decides on it: why there is none, naming `models.md` when it does not read. */
	require(job: TJob): Result<ModelChoice, ChoiceError | SettingError>;
	/** Why `models.md` does not read, or null. */
	problem(): SettingError | null;
	/** Save `choice` for `job`, keeping the others; replaces a `models.md` that does not read. Rejects when it cannot be saved. */
	set(job: TJob, choice: ModelChoice): Promise<void>;
	/** Call `listener` when a choice may have changed; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
};

/**
 * The model this computer's person chose for each job; `defaults` answers
 * a job none was chosen for.
 */
export function modelChoices<TJob extends string = string>(
	defaults: Partial<Record<TJob, ModelChoice>> = {},
): ModelChoices<TJob> {
	const note = settingNote(modelsCollection, settings.file('models.md'));

	/** Every saved choice by job, or why `models.md` does not read. */
	function saved(): Result<Map<string, ModelChoice>, SettingError> {
		const read = note.get();
		if (read.error !== null) return read;
		return Ok(
			new Map(
				(read.data?.choices ?? []).map(({ job, endpoint, model }) => [
					job,
					{ endpoint, model },
				]),
			),
		);
	}

	function chosen(job: TJob): Result<ModelChoice | null, SettingError> {
		const read = saved();
		if (read.error !== null) return read;
		const choice =
			read.data.get(job) ??
			(Object.hasOwn(defaults, job) ? defaults[job] : undefined);
		return Ok(choice ? { ...choice } : null);
	}

	/** Saves run one at a time, each over what the one before it left. */
	let saving: Promise<unknown> = Promise.resolve();

	return {
		get: (job) => chosen(job).data ?? null,
		require(job) {
			const read = chosen(job);
			if (read.error !== null) return read;
			if (read.data === null) return ChoiceError.NoChoice({ job });
			return Ok(read.data);
		},
		problem: () => saved().error,
		set(job, { endpoint, model }) {
			const save = saving.then(async () => {
				await settings.file('models.md').connected();
				const kept = saved().data ?? new Map<string, ModelChoice>();
				kept.set(job, { endpoint, model });
				await note.set({
					choices: [...kept].map(([name, choice]) => ({
						job: name,
						...choice,
					})),
				});
			});
			saving = save.catch(() => {});
			return save;
		},
		subscribe: (listener) => note.subscribe(listener),
	};
}
